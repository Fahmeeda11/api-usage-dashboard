/**
 * The contract between client and server.
 *
 * Each schema is used twice: once by an Express route to validate a request, and
 * once by a React form (or the example ingest clients) to type what it sends.
 * One definition, so the two cannot disagree.
 */

import { z } from 'zod';
import {
  API_KEY_SCOPES,
  EVENT_STATUSES,
  GRANULARITIES,
  MAX_EVENTS_PER_BATCH,
} from './domain.js';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'must be a 24-character hex id');

export const dateSchema = z.union([z.string().datetime(), z.date()]).pipe(z.coerce.date());

const trimmedString = (max: number) => z.string().trim().min(1).max(max);

/* -------------------------------------------------------------------------- */
/* Auth (unchanged from the shared core)                                       */
/* -------------------------------------------------------------------------- */

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200, 'That is suspiciously long');

export const signupSchema = z.object({
  name: trimmedString(120),
  email: z.string().trim().toLowerCase().email(),
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, 'Password is required'),
});

export const publicUserSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  email: z.string().email(),
  createdAt: dateSchema,
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;

export const authResponseSchema = z.object({
  user: publicUserSchema,
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
});

export type AuthResponse = z.infer<typeof authResponseSchema>;

/* -------------------------------------------------------------------------- */
/* API keys                                                                    */
/* -------------------------------------------------------------------------- */

export const createApiKeySchema = z.object({
  label: trimmedString(80),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).default(['ingest']),
});

/** An API key as listed. The secret is NOT here - it cannot be recovered. */
export const apiKeySchema = z.object({
  id: objectIdSchema,
  label: z.string(),
  /** First few characters, so a key is identifiable without being usable. */
  prefix: z.string(),
  scopes: z.array(z.enum(API_KEY_SCOPES)),
  lastUsedAt: dateSchema.nullable(),
  revokedAt: dateSchema.nullable(),
  createdAt: dateSchema,
});

/**
 * The creation response, and the ONLY time the full secret is ever returned.
 * The server stores a hash; there is no endpoint that can show it again.
 */
export const createdApiKeySchema = apiKeySchema.extend({
  secret: z.string(),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type ApiKey = z.infer<typeof apiKeySchema>;
export type CreatedApiKey = z.infer<typeof createdApiKeySchema>;

/* -------------------------------------------------------------------------- */
/* Usage events (ingest)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One recorded API/LLM call.
 *
 * `costUsd` is accepted as a decimal for caller convenience - nobody wants to
 * convert to micro-dollars at the call site - and converted to an integer on
 * the way in. See domain.ts for why storage is integer.
 *
 * `occurredAt` is optional: a client batching events locally can report when a
 * call actually happened rather than when the batch was flushed, which matters
 * for a client that buffers for a minute before sending.
 */
export const usageEventInputSchema = z.object({
  project: trimmedString(120),
  provider: trimmedString(60),
  model: trimmedString(120),

  promptTokens: z.number().int().nonnegative().max(100_000_000).default(0),
  completionTokens: z.number().int().nonnegative().max(100_000_000).default(0),

  costUsd: z.number().nonnegative().max(1_000_000).default(0),
  latencyMs: z.number().int().nonnegative().max(3_600_000).default(0),

  status: z.enum(EVENT_STATUSES).default('ok'),

  /** Free-form tags. Bounded so a client cannot push arbitrary blobs into Mongo. */
  metadata: z.record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean()]))
    .refine((m) => Object.keys(m).length <= 20, { message: 'At most 20 metadata keys' })
    .optional(),

  occurredAt: dateSchema.optional(),
});

/**
 * The ingest body.
 *
 * Always a batch, even for one event - a single shape means the client library
 * does not need two code paths, and batching is what makes high-volume ingest
 * cheap (one round trip and one insertMany rather than N of each).
 */
export const ingestBatchSchema = z.object({
  events: z.array(usageEventInputSchema).min(1).max(MAX_EVENTS_PER_BATCH),
});

export type UsageEventInput = z.infer<typeof usageEventInputSchema>;
export type IngestBatch = z.infer<typeof ingestBatchSchema>;

export const ingestResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
});

/** A stored event as the dashboard reads it. */
export const usageEventSchema = z.object({
  id: objectIdSchema,
  project: z.string(),
  provider: z.string(),
  model: z.string(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  costMicros: z.number().int(),
  latencyMs: z.number().int(),
  status: z.enum(EVENT_STATUSES),
  metadata: z.record(z.string(), z.unknown()).optional(),
  occurredAt: dateSchema,
});

export type UsageEvent = z.infer<typeof usageEventSchema>;

/* -------------------------------------------------------------------------- */
/* Metrics queries                                                             */
/* -------------------------------------------------------------------------- */

export const metricsQuerySchema = z.object({
  from: dateSchema,
  to: dateSchema,
  granularity: z.enum(GRANULARITIES).default('hour'),
  project: z.string().trim().max(120).optional(),
  model: z.string().trim().max(120).optional(),
});

export type MetricsQuery = z.infer<typeof metricsQuerySchema>;

/** One point on the spend/latency timeline. */
export const timeseriesPointSchema = z.object({
  bucket: dateSchema,
  costMicros: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  /** Approximate - see the worker's rollup handler for the caveat. */
  latencyP50: z.number().nonnegative(),
  latencyP95: z.number().nonnegative(),
});

export const breakdownRowSchema = z.object({
  key: z.string(),
  costMicros: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
});

export const metricsSummarySchema = z.object({
  costMicros: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  latencyP50: z.number().nonnegative(),
  latencyP95: z.number().nonnegative(),
});

export const metricsResponseSchema = z.object({
  summary: metricsSummarySchema,
  timeseries: z.array(timeseriesPointSchema),
  byModel: z.array(breakdownRowSchema),
  byProject: z.array(breakdownRowSchema),
  /** True when the response came from the Redis cache rather than a fresh aggregation. */
  cached: z.boolean().default(false),
});

export type TimeseriesPoint = z.infer<typeof timeseriesPointSchema>;
export type BreakdownRow = z.infer<typeof breakdownRowSchema>;
export type MetricsSummary = z.infer<typeof metricsSummarySchema>;
export type MetricsResponse = z.infer<typeof metricsResponseSchema>;

/** Raw event feed for the virtualized table. Cursor-paginated. */
export const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  cursor: z.string().optional(),
  project: z.string().trim().max(120).optional(),
  model: z.string().trim().max(120).optional(),
  status: z.enum(EVENT_STATUSES).optional(),
});

export type EventsQuery = z.infer<typeof eventsQuerySchema>;

export const eventsResponseSchema = z.object({
  events: z.array(usageEventSchema),
  nextCursor: z.string().nullable(),
});

export type EventsResponse = z.infer<typeof eventsResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export const apiErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
    /** Seconds to wait, on a 429. */
    retryAfter: z.number().int().optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
