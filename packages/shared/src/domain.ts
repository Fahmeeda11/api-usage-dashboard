/**
 * Domain constants shared by the API, the worker and the dashboard.
 */

/** Rollup granularities. Raw events expire; these are what the dashboard reads. */
export const GRANULARITIES = ['hour', 'day'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export const EVENT_STATUSES = ['ok', 'error', 'timeout', 'rate_limited'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const STATUS_LABELS: Record<EventStatus, string> = {
  ok: 'OK',
  error: 'Error',
  timeout: 'Timeout',
  rate_limited: 'Rate limited',
};

/** Anything that is not `ok` counts against the error rate. */
export function isFailure(status: EventStatus): boolean {
  return status !== 'ok';
}

/* -------------------------------------------------------------------------- */
/* Money                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Cost is stored in MICRO-DOLLARS as an integer, never as a float.
 *
 * Two reasons, and the second is the one that bites:
 *
 *   1. Floats accumulate error. Summing a million costs of 0.0000015 with
 *      doubles drifts; summing integers does not.
 *   2. Mongo's $sum over doubles is not associative, so a rollup computed in a
 *      different shard order produces a *slightly different* total. Dashboards
 *      that disagree with themselves on refresh are impossible to debug.
 *
 * A single LLM call can cost fractions of a cent, so cents are too coarse -
 * micro-dollars (1e-6 USD) give plenty of headroom. A request costing $0.0034
 * is stored as 3400.
 */
export const MICRO_PER_USD = 1_000_000;

export function usdToMicros(usd: number): number {
  return Math.round(usd * MICRO_PER_USD);
}

export function microsToUsd(micros: number): number {
  return micros / MICRO_PER_USD;
}

/** Format micro-dollars for display, with enough precision to be useful. */
export function formatMicros(micros: number): string {
  const usd = microsToUsd(micros);
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/* -------------------------------------------------------------------------- */
/* Time buckets                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Truncate a timestamp to the start of its bucket, in UTC.
 *
 * Always UTC, deliberately. A rollup bucketed in the server's local time would
 * silently re-bucket when the server moves region or when daylight saving
 * shifts, and the historical data would no longer line up with the new data.
 * The dashboard converts to the viewer's timezone at render time; storage is
 * always UTC.
 */
export function truncateToBucket(date: Date, granularity: Granularity): Date {
  const d = new Date(date);
  d.setUTCMilliseconds(0);
  d.setUTCSeconds(0);
  d.setUTCMinutes(0);
  if (granularity === 'day') d.setUTCHours(0);
  return d;
}

/** Milliseconds in one bucket of the given granularity. */
export function bucketDurationMs(granularity: Granularity): number {
  return granularity === 'hour' ? 3_600_000 : 86_400_000;
}

/**
 * Every bucket start between `from` and `to`, inclusive of empty ones.
 *
 * Charts need the gaps: a run of buckets with no traffic should render as a
 * flat line at zero, not as a straight line interpolated across the gap that
 * implies steady usage which never happened.
 */
export function bucketRange(from: Date, to: Date, granularity: Granularity): Date[] {
  const step = bucketDurationMs(granularity);
  const start = truncateToBucket(from, granularity).getTime();
  const end = truncateToBucket(to, granularity).getTime();

  const buckets: Date[] = [];
  // Guard against a pathological range producing millions of points.
  const MAX = 10_000;
  for (let t = start; t <= end && buckets.length < MAX; t += step) {
    buckets.push(new Date(t));
  }
  return buckets;
}

/* -------------------------------------------------------------------------- */
/* API keys                                                                    */
/* -------------------------------------------------------------------------- */

/** Prefix on every issued key, so one is recognisable in a log or a paste. */
export const API_KEY_PREFIX = 'usg_';

/** Characters of the key shown in the UI after creation (the rest is unrecoverable). */
export const API_KEY_DISPLAY_CHARS = 8;

export const API_KEY_SCOPES = ['ingest', 'read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const SCOPE_DESCRIPTIONS: Record<ApiKeyScope, string> = {
  ingest: 'Write usage events',
  read: 'Read aggregated metrics',
};

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/** Events accepted in one ingest request. Keeps a single body bounded. */
export const MAX_EVENTS_PER_BATCH = 500;

/** How long raw events are kept before the TTL index removes them. */
export const RAW_EVENT_RETENTION_DAYS = 30;

/** Sliding-window rate limit, per API key. */
export const RATE_LIMIT = {
  windowMs: 60_000,
  maxRequests: 600,
} as const;

/** Dashboard time-range presets. */
export const RANGE_PRESETS = [
  { label: 'Last 24 hours', hours: 24, granularity: 'hour' as Granularity },
  { label: 'Last 7 days', hours: 24 * 7, granularity: 'day' as Granularity },
  { label: 'Last 30 days', hours: 24 * 30, granularity: 'day' as Granularity },
] as const;
