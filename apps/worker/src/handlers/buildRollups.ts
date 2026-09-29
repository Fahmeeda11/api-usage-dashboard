/**
 * Fold raw usage events into time buckets.
 *
 * This is the job that makes the dashboard fast. Without it, every page load
 * scans every event in the range; with it, the read path touches a few hundred
 * pre-aggregated documents no matter how much traffic the account has.
 *
 * IDEMPOTENCY
 * ===========
 * This job WILL run more than once for the same window - overlapping schedules,
 * BullMQ retries, ingest-triggered recomputes, manual backfills. So the write
 * uses `$set`, never `$inc`:
 *
 *     $inc  - "add these 40 requests to the bucket"   -> rerun doubles it
 *     $set  - "this bucket contains 40 requests"      -> rerun writes 40 again
 *
 * The aggregation recomputes the bucket's totals from the raw events every time,
 * so setting the result is both correct and naturally idempotent. This is the
 * same principle as the reminder handler in the job-tracker project - make the
 * operation safe to repeat rather than trying to guarantee it happens once.
 *
 * PERCENTILES
 * ===========
 * Sums and counts aggregate cleanly. Percentiles do not: the p95 of a day is not
 * any function of the p95s of its hours. So each granularity computes its own
 * percentiles from the RAW events in its window rather than from finer buckets.
 * That is exact while the raw events are inside the TTL window, which is the
 * only period the dashboard can be asked to recompute anyway.
 */

import { Types, type PipelineStage } from 'mongoose';
import {
  buildRollupsJobSchema,
  truncateToBucket,
  metricsCachePattern,
  type BuildRollupsJob,
  type Granularity,
} from '@usage/shared';
import { Rollup, UsageEvent } from '@usage/db';
import { childLogger } from '../logger.js';

const log = childLogger('build-rollups');

export interface RollupResult {
  granularity: Granularity;
  buckets: number;
  events: number;
  /** Users whose cached metrics are now stale. */
  affectedUsers: string[];
}

/**
 * $percentile needs MongoDB 7. On an older server the aggregation fails, so the
 * first failure flips this and every subsequent run uses the manual path.
 * Degrading to an approximation beats refusing to produce rollups at all.
 */
let percentileOperatorAvailable = true;

export async function handleBuildRollups(rawPayload: unknown): Promise<RollupResult> {
  const payload: BuildRollupsJob = buildRollupsJobSchema.parse(rawPayload);
  const { granularity } = payload;
  const from = new Date(payload.from);
  const to = new Date(payload.to);

  const started = Date.now();

  /**
   * One aggregation for the whole window, grouping by every dimension the
   * rollup identity needs. Running it per-bucket would mean N round trips and N
   * index scans over overlapping ranges.
   */
  const pipeline: PipelineStage[] = [
    {
      $match: {
        occurredAt: { $gte: from, $lt: to },
      },
    },
    {
      /**
       * Compute the bucket start in the pipeline with $dateTrunc rather than in
       * JS. Doing it server-side means the events never leave Mongo - the
       * alternative is streaming every raw document to the worker to bucket it
       * in application code, which is the difference between moving a few
       * hundred results and a few million rows across the wire.
       *
       * timezone: 'UTC' is explicit. The default is already UTC, but an implicit
       * dependency on that would break silently if anyone ever set a default
       * timezone on the connection.
       */
      $addFields: {
        bucket: {
          $dateTrunc: {
            date: '$occurredAt',
            unit: granularity,
            timezone: 'UTC',
          },
        },
      },
    },
    {
      // Cast: the accumulator set is chosen at run time ($percentile vs a manual
      // fallback), which the PipelineStage.Group literal type cannot express.
      $group: {
        _id: {
          userId: '$userId',
          bucket: '$bucket',
          project: '$project',
          model: '$model',
          provider: '$provider',
        },
        requests: { $sum: 1 },
        errors: { $sum: { $cond: [{ $eq: ['$status', 'ok'] }, 0, 1] } },
        costMicros: { $sum: '$costMicros' },
        promptTokens: { $sum: '$promptTokens' },
        completionTokens: { $sum: '$completionTokens' },
        latencyMax: { $max: '$latencyMs' },
        ...(percentileOperatorAvailable
          ? {
              latencies: {
                $percentile: {
                  input: '$latencyMs',
                  p: [0.5, 0.95],
                  // 'approximate' uses t-digest: bounded memory regardless of
                  // how many events are in the bucket. The exact method has to
                  // hold every value in memory, which is a memory cliff on a
                  // busy hour.
                  method: 'approximate',
                },
              },
            }
          : {
              // Fallback for MongoDB < 7: collect the values and sort in the
              // worker. Correct, but it does stream the latencies out, so it is
              // the slower path by design.
              latencyValues: { $push: '$latencyMs' },
            }),
      },
    } as PipelineStage.Group,
  ];

  let groups: AggregatedGroup[];

  try {
    groups = (await UsageEvent.aggregate(pipeline).allowDiskUse(true)) as AggregatedGroup[];
  } catch (err) {
    if (percentileOperatorAvailable && isUnknownOperatorError(err)) {
      log.warn('$percentile unavailable (needs MongoDB 7); falling back to manual percentiles');
      percentileOperatorAvailable = false;
      return handleBuildRollups(rawPayload);
    }
    throw err;
  }

  if (groups.length === 0) {
    /**
     * No events left in this window. That is NOT nothing to do: any rollups
     * still sitting here describe data that no longer exists, and leaving them
     * means the dashboard keeps reporting spend for a period with nothing behind
     * it. Returning early here was a bug - the emptiest window is exactly the
     * one whose stale buckets most need clearing.
     */
    const stale = await Rollup.find({ granularity, bucket: { $gte: from, $lt: to } })
      .select('_id userId')
      .lean();

    if (stale.length > 0) {
      await Rollup.deleteMany({ _id: { $in: stale.map((r) => r._id) } });
      log.info({ granularity, count: stale.length }, 'cleared rollups for an emptied window');
    }

    return {
      granularity,
      buckets: 0,
      events: 0,
      // Their caches still need invalidating - the numbers just changed to zero.
      affectedUsers: [...new Set(stale.map((r) => String(r.userId)))],
    };
  }

  const computedAt = new Date();
  const affectedUsers = new Set<string>();
  let totalEvents = 0;

  const operations = groups.map((group) => {
    const { p50, p95 } = resolvePercentiles(group);
    affectedUsers.add(String(group._id.userId));
    totalEvents += group.requests;

    return {
      updateOne: {
        // Matches the unique index on the model, which is what makes the upsert
        // safe under a concurrent double-run: one wins, the other updates.
        filter: {
          userId: group._id.userId,
          granularity,
          bucket: group._id.bucket,
          project: group._id.project,
          model: group._id.model,
        },
        update: {
          $set: {
            provider: group._id.provider,
            requests: group.requests,
            errorCount: group.errors,
            costMicros: group.costMicros,
            promptTokens: group.promptTokens,
            completionTokens: group.completionTokens,
            latencyP50: Math.round(p50),
            latencyP95: Math.round(p95),
            latencyMax: group.latencyMax,
            computedAt,
          },
        },
        upsert: true,
      },
    };
  });

  // ordered: false lets the driver apply the rest if one write fails, and lets
  // the server parallelise them.
  await Rollup.bulkWrite(operations, { ordered: false });

  /**
   * Delete buckets that no longer have any events behind them.
   *
   * Without this, a bucket whose raw events were deleted (TTL expiry of a
   * back-dated import, say) keeps its stale totals forever and the dashboard
   * shows spend for a period that has no data. Scoped to this window only.
   */
  const liveKeys = new Set(
    groups.map((g) => `${g._id.userId}|${g._id.bucket.getTime()}|${g._id.project}|${g._id.model}`),
  );

  const existing = await Rollup.find({ granularity, bucket: { $gte: from, $lt: to } })
    .select('_id userId bucket project model')
    .lean();

  const orphaned = existing
    .filter((r) => !liveKeys.has(`${r.userId}|${r.bucket.getTime()}|${r.project}|${r.model}`))
    .map((r) => r._id);

  if (orphaned.length > 0) {
    await Rollup.deleteMany({ _id: { $in: orphaned } });
    log.debug({ count: orphaned.length }, 'removed orphaned rollups');
  }

  log.info(
    {
      granularity,
      buckets: operations.length,
      events: totalEvents,
      users: affectedUsers.size,
      ms: Date.now() - started,
    },
    'rollups rebuilt',
  );

  return {
    granularity,
    buckets: operations.length,
    events: totalEvents,
    affectedUsers: [...affectedUsers],
  };
}

/* -------------------------------------------------------------------------- */

interface AggregatedGroup {
  _id: {
    userId: Types.ObjectId;
    bucket: Date;
    project: string;
    model: string;
    provider: string;
  };
  requests: number;
  errors: number;
  costMicros: number;
  promptTokens: number;
  completionTokens: number;
  latencyMax: number;
  latencies?: number[];
  latencyValues?: number[];
}

function resolvePercentiles(group: AggregatedGroup): { p50: number; p95: number } {
  if (group.latencies && group.latencies.length >= 2) {
    return { p50: group.latencies[0] ?? 0, p95: group.latencies[1] ?? 0 };
  }

  const values = group.latencyValues ?? [];
  if (values.length === 0) return { p50: 0, p95: 0 };

  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

/**
 * Nearest-rank percentile.
 *
 * Exported for the tests: percentile maths is easy to get subtly wrong at the
 * boundaries, and "p95 of a single value" or "p95 of an empty set" are exactly
 * the cases that produce a NaN on a dashboard at 3am.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] ?? 0;
}

function isUnknownOperatorError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unknown group operator|Unrecognized expression|\$percentile/i.test(message);
}

/** The cache keys invalidated by a rollup run. */
export function cachePatternsFor(users: string[]): string[] {
  return users.map(metricsCachePattern);
}

/** Bucket-aligned window for a scheduled run: `lookbackMs` back from now. */
export function scheduledWindow(
  granularity: Granularity,
  lookbackMs: number,
  now: Date = new Date(),
): { from: Date; to: Date } {
  const from = truncateToBucket(new Date(now.getTime() - lookbackMs), granularity);
  // Exclusive end, one bucket past the current one so the in-progress bucket is
  // included rather than always lagging by one.
  const to = new Date(truncateToBucket(now, granularity).getTime() + bucketMs(granularity));
  return { from, to };
}

function bucketMs(granularity: Granularity): number {
  return granularity === 'hour' ? 3_600_000 : 86_400_000;
}
