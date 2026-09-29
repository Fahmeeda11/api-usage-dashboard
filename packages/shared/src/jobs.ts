/**
 * The contract between the API (which enqueues) and the worker (which consumes).
 *
 * Types and constants only - no BullMQ import, no Redis connection. Each process
 * builds its own client; what they share is the agreement about job names and
 * payload shapes.
 */

import { z } from 'zod';
import { GRANULARITIES } from './domain.js';

export const QUEUE_NAMES = {
  rollups: 'rollups',
} as const;

export const JOB_NAMES = {
  /** Aggregate raw events into time buckets. */
  buildRollups: 'build-rollups',
} as const;

/**
 * Recompute rollups for a window.
 *
 * Deliberately a *window* rather than a single bucket, because recomputation
 * must be idempotent: running the job twice for the same window has to produce
 * the same rollups, not doubled ones. The handler achieves that with an upsert
 * that SETS the computed totals rather than incrementing them - so a rerun
 * overwrites with the same numbers.
 *
 * That property is what makes it safe to re-run the job for a past window when
 * late events arrive, or after a bug fix.
 */
export const buildRollupsJobSchema = z.object({
  granularity: z.enum(GRANULARITIES),
  /** Start of the window, inclusive. */
  from: z.string(),
  /** End of the window, exclusive. */
  to: z.string(),
});

export type BuildRollupsJob = z.infer<typeof buildRollupsJobSchema>;

export const ROLLUP_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 10_000 },
  removeOnComplete: { age: 86_400, count: 500 },
  removeOnFail: { age: 604_800 },
} as const;

/**
 * How often each granularity is rebuilt.
 *
 * Hourly rollups run every minute over a trailing window so the dashboard is
 * near-live; daily rollups run every fifteen minutes because nobody needs a
 * 30-day chart to be fresher than that, and the aggregation is heavier.
 */
export const ROLLUP_SCHEDULE = {
  hour: { everyMs: 60_000, lookbackMs: 3 * 3_600_000 },
  day: { everyMs: 15 * 60_000, lookbackMs: 2 * 86_400_000 },
} as const;

/**
 * Redis key for a cached metrics response.
 *
 * Built from the exact query so two different ranges never collide, and
 * namespaced by user so one account's cache can never serve another's data -
 * a cache key that forgets the tenant is a data leak with a very long tail.
 */
export function metricsCacheKey(userId: string, query: Record<string, unknown>): string {
  const canonical = Object.keys(query)
    .sort()
    .map((k) => `${k}=${String(query[k] ?? '')}`)
    .join('&');
  return `metrics:${userId}:${canonical}`;
}

/** Everything cached for one user, invalidated when their rollups change. */
export function metricsCachePattern(userId: string): string {
  return `metrics:${userId}:*`;
}

export const METRICS_CACHE_TTL_SECONDS = 60;

/** Redis pub/sub channel carrying newly ingested events to SSE listeners. */
export function liveTailChannel(userId: string): string {
  return `live:${userId}`;
}
