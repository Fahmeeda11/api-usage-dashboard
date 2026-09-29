import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { EVENT_STATUSES, RAW_EVENT_RETENTION_DAYS } from '@usage/shared';

/**
 * One recorded API call. This is the high-write collection.
 *
 * Design consequences of "many writes, few reads":
 *
 *   - No denormalisation of anything that would need updating later. These rows
 *     are written once and never modified.
 *   - Cost stored as an integer (micro-dollars). See domain.ts: float sums are
 *     not associative, so two rollups over the same data can disagree.
 *   - A TTL index, because raw events are a means to an end. The dashboard reads
 *     rollups; raw rows exist for the live tail and for recomputation, both of
 *     which only care about the recent past.
 */
const usageEventSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    keyId: { type: Schema.Types.ObjectId, ref: 'ApiKey', required: true },

    project: { type: String, required: true, trim: true, maxlength: 120 },
    provider: { type: String, required: true, trim: true, maxlength: 60 },
    model: { type: String, required: true, trim: true, maxlength: 120 },

    promptTokens: { type: Number, required: true, default: 0, min: 0 },
    completionTokens: { type: Number, required: true, default: 0, min: 0 },

    /** Micro-dollars (1e-6 USD) as an integer. Never a float. */
    costMicros: { type: Number, required: true, default: 0, min: 0 },

    latencyMs: { type: Number, required: true, default: 0, min: 0 },

    status: { type: String, enum: EVENT_STATUSES, required: true, default: 'ok' },

    metadata: { type: Schema.Types.Mixed },

    /**
     * When the call happened, which is NOT necessarily when it was received -
     * a client that buffers events for a minute reports the real time here.
     * Every rollup and every query buckets on this, never on createdAt.
     *
     * Deliberately NOT `index: true` - the TTL index declared below is already
     * on { occurredAt: 1 } and serves range queries just as well. Declaring both
     * makes Mongo reject the second as "an equivalent index already exists with
     * a different name", and even where it succeeded it would be a redundant
     * index costing write throughput on the hottest collection in the system.
     */
    occurredAt: { type: Date, required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

/**
 * The rollup aggregation's driving query: one user's events in a time window.
 * Equality on userId first, then the range on occurredAt - the ESR rule
 * (Equality, Sort/Range) that makes the index usable for both at once.
 */
usageEventSchema.index({ userId: 1, occurredAt: -1 });

/** The raw-event table, which filters by project or model and sorts by time. */
usageEventSchema.index({ userId: 1, project: 1, occurredAt: -1 });
usageEventSchema.index({ userId: 1, model: 1, occurredAt: -1 });

/**
 * TTL: Mongo deletes events older than the retention window on its own, roughly
 * once a minute.
 *
 * This is what stops the collection growing without bound. It works because
 * rollups are computed BEFORE the raw rows expire - the dashboard never needs a
 * 90-day-old raw event, only the daily bucket it was folded into. Worth knowing:
 * the TTL monitor is best-effort, so rows can outlive their expiry by a minute
 * or two, and it deletes one document at a time rather than dropping a range.
 */
usageEventSchema.index(
  { occurredAt: 1 },
  { expireAfterSeconds: RAW_EVENT_RETENTION_DAYS * 86_400, name: 'raw_event_ttl' },
);

export type UsageEventDoc = HydratedDocument<InferSchemaType<typeof usageEventSchema>>;
export const UsageEvent = model('UsageEvent', usageEventSchema);
