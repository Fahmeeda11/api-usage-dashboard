/**
 * Dashboard metrics.
 *
 * The read path deliberately never touches raw events. It reads the pre-computed
 * rollups the worker maintains, so query cost scales with the LENGTH OF THE TIME
 * RANGE rather than with how much traffic the account has. A user with ten
 * million events and a user with ten see the same query cost for "last 7 days".
 *
 * In front of that sits a short Redis cache, because a dashboard open on a
 * second monitor re-requests the same range every time it refocuses.
 */

import { Types } from 'mongoose';
import {
  bucketRange,
  metricsCacheKey,
  METRICS_CACHE_TTL_SECONDS,
  type MetricsQuery,
  type MetricsResponse,
  type TimeseriesPoint,
  type BreakdownRow,
} from '@usage/shared';
import { Rollup } from '@usage/db';
import { cacheGet, cacheSet } from '../../lib/redis.js';
import { childLogger } from '../../lib/logger.js';

const log = childLogger('metrics');

/** How many rows a breakdown returns before the rest are folded into "Other". */
const BREAKDOWN_LIMIT = 10;

export async function getMetrics(userId: string, query: MetricsQuery): Promise<MetricsResponse> {
  const cacheKey = metricsCacheKey(userId, {
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    granularity: query.granularity,
    project: query.project,
    model: query.model,
  });

  const cached = await cacheGet<MetricsResponse>(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  const match: Record<string, unknown> = {
    userId: new Types.ObjectId(userId),
    granularity: query.granularity,
    bucket: { $gte: query.from, $lte: query.to },
  };
  if (query.project) match['project'] = query.project;
  if (query.model) match['model'] = query.model;

  /**
   * One aggregation, three shapes, via $facet.
   *
   * $facet runs several pipelines over the SAME matched set in a single pass.
   * The alternative is three round trips that each re-scan the same documents -
   * three times the index work and three times the latency, for data that is
   * guaranteed to be consistent only in the $facet version (three separate
   * queries can straddle a rollup write and disagree with each other).
   */
  const [result] = await Rollup.aggregate([
    { $match: match },
    {
      $facet: {
        timeseries: [
          {
            $group: {
              _id: '$bucket',
              costMicros: { $sum: '$costMicros' },
              requests: { $sum: '$requests' },
              errors: { $sum: '$errorCount' },
              promptTokens: { $sum: '$promptTokens' },
              completionTokens: { $sum: '$completionTokens' },
              /**
               * Percentiles genuinely do not sum. Taking the max of the
               * constituent buckets' p95 is an upper bound rather than the true
               * p95 - the honest approximation, and it at least never
               * under-reports tail latency, which is the direction that would
               * actually mislead someone debugging.
               */
              latencyP50: { $max: '$latencyP50' },
              latencyP95: { $max: '$latencyP95' },
            },
          },
          { $sort: { _id: 1 } },
        ],

        byModel: [
          {
            $group: {
              _id: '$model',
              costMicros: { $sum: '$costMicros' },
              requests: { $sum: '$requests' },
              errors: { $sum: '$errorCount' },
            },
          },
          { $sort: { costMicros: -1 } },
        ],

        byProject: [
          {
            $group: {
              _id: '$project',
              costMicros: { $sum: '$costMicros' },
              requests: { $sum: '$requests' },
              errors: { $sum: '$errorCount' },
            },
          },
          { $sort: { costMicros: -1 } },
        ],

        summary: [
          {
            $group: {
              _id: null,
              costMicros: { $sum: '$costMicros' },
              requests: { $sum: '$requests' },
              errors: { $sum: '$errorCount' },
              promptTokens: { $sum: '$promptTokens' },
              completionTokens: { $sum: '$completionTokens' },
              latencyP50: { $max: '$latencyP50' },
              latencyP95: { $max: '$latencyP95' },
            },
          },
        ],
      },
    },
  ]);

  const rawTimeseries = (result?.timeseries ?? []) as Array<{
    _id: Date;
    costMicros: number;
    requests: number;
    errors: number;
    promptTokens: number;
    completionTokens: number;
    latencyP50: number;
    latencyP95: number;
  }>;

  const byBucket = new Map(rawTimeseries.map((row) => [row._id.getTime(), row]));

  /**
   * Fill the gaps.
   *
   * Buckets with no traffic simply do not exist in the collection. Handing the
   * chart only the non-empty ones makes it draw a straight line across a quiet
   * weekend, implying steady usage that never happened. Emitting explicit zeroes
   * makes the quiet period look quiet.
   */
  const timeseries: TimeseriesPoint[] = bucketRange(query.from, query.to, query.granularity).map(
    (bucket) => {
      const row = byBucket.get(bucket.getTime());
      return {
        bucket,
        costMicros: row?.costMicros ?? 0,
        requests: row?.requests ?? 0,
        errors: row?.errors ?? 0,
        promptTokens: row?.promptTokens ?? 0,
        completionTokens: row?.completionTokens ?? 0,
        latencyP50: row?.latencyP50 ?? 0,
        latencyP95: row?.latencyP95 ?? 0,
      };
    },
  );

  const summaryRow = (result?.summary ?? [])[0] as
    | {
        costMicros: number;
        requests: number;
        errors: number;
        promptTokens: number;
        completionTokens: number;
        latencyP50: number;
        latencyP95: number;
      }
    | undefined;

  const response: MetricsResponse = {
    summary: {
      costMicros: summaryRow?.costMicros ?? 0,
      requests: summaryRow?.requests ?? 0,
      errors: summaryRow?.errors ?? 0,
      promptTokens: summaryRow?.promptTokens ?? 0,
      completionTokens: summaryRow?.completionTokens ?? 0,
      latencyP50: summaryRow?.latencyP50 ?? 0,
      latencyP95: summaryRow?.latencyP95 ?? 0,
    },
    timeseries,
    byModel: collapseTail(result?.byModel ?? []),
    byProject: collapseTail(result?.byProject ?? []),
    cached: false,
  };

  await cacheSet(cacheKey, response, METRICS_CACHE_TTL_SECONDS);
  log.debug({ userId, granularity: query.granularity }, 'metrics computed');

  return response;
}

/**
 * Keep the top N rows and fold the rest into a single "Other".
 *
 * A legend with sixty models in it conveys nothing, and dropping the tail
 * outright would make the breakdown stop summing to the headline total - which
 * is worse, because then the numbers on screen visibly disagree.
 */
function collapseTail(
  rows: Array<{ _id: string; costMicros: number; requests: number; errors: number }>,
): BreakdownRow[] {
  const mapped = rows.map((r) => ({
    key: r._id ?? 'unknown',
    costMicros: r.costMicros,
    requests: r.requests,
    errors: r.errors,
  }));

  if (mapped.length <= BREAKDOWN_LIMIT) return mapped;

  const head = mapped.slice(0, BREAKDOWN_LIMIT);
  const tail = mapped.slice(BREAKDOWN_LIMIT);

  head.push({
    key: `Other (${tail.length})`,
    costMicros: tail.reduce((sum, r) => sum + r.costMicros, 0),
    requests: tail.reduce((sum, r) => sum + r.requests, 0),
    errors: tail.reduce((sum, r) => sum + r.errors, 0),
  });

  return head;
}
