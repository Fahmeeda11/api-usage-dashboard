import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { GRANULARITIES } from '@usage/shared';

/**
 * Pre-aggregated usage, one document per (user, granularity, bucket, project, model).
 *
 * Why this collection exists
 * --------------------------
 * The dashboard's default view is "last 7 days, grouped by hour, broken down by
 * model". Computing that from raw events means scanning every event in the
 * range on every page load. At a thousand events an hour that is fine; at a
 * million it is a multi-second query, and it gets slower precisely as the
 * product gets more successful.
 *
 * So the read path never touches raw events. A background job folds them into
 * these buckets, and the dashboard reads buckets - a query whose cost scales
 * with the length of the time range, not with traffic volume.
 *
 * This is the classic read-heavy tradeoff: spend writes to make reads cheap.
 *
 * Idempotency
 * -----------
 * The unique index below is what lets the rollup job be safely re-run. The
 * handler upserts with $set (not $inc), so recomputing a window overwrites the
 * bucket with the same totals rather than doubling them. That matters because
 * the job WILL run twice - overlapping schedules, retries, manual backfills.
 */
const rollupSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    granularity: { type: String, enum: GRANULARITIES, required: true },

    /** Start of the bucket, truncated in UTC. */
    bucket: { type: Date, required: true },

    project: { type: String, required: true },
    model: { type: String, required: true },
    provider: { type: String, required: true },

    requests: { type: Number, required: true, default: 0 },
    /**
     * Named errorCount, not `errors`: Mongoose reserves `errors` on Document
     * for validation state, and a schema path with that name shadows it. It
     * appears to work until something calls doc.errors and gets a number.
     * The DTO the dashboard sees is still `errors` - this is storage only.
     */
    errorCount: { type: Number, required: true, default: 0 },

    /** Micro-dollars, integer. */
    costMicros: { type: Number, required: true, default: 0 },

    promptTokens: { type: Number, required: true, default: 0 },
    completionTokens: { type: Number, required: true, default: 0 },

    /**
     * Latency percentiles for this bucket.
     *
     * Honest caveat: percentiles do not aggregate. Averaging the p95 of twelve
     * hourly buckets does NOT give the p95 of the day - it gives a number with
     * no statistical meaning. Computing an exact daily p95 requires the raw
     * values, which is exactly what rolling up throws away.
     *
     * The daily rollup therefore recomputes its percentiles from raw events
     * rather than from the hourly buckets, which is correct as long as the raw
     * events are still inside the TTL window. Past that horizon the stored value
     * is the best estimate available, and the dashboard labels these as
     * approximate rather than pretending otherwise.
     *
     * A t-digest or HDR histogram per bucket would make them properly mergeable.
     * That is the right answer at scale; it is overkill here, and naming the
     * limitation beats quietly shipping a wrong number.
     */
    latencyP50: { type: Number, required: true, default: 0 },
    latencyP95: { type: Number, required: true, default: 0 },
    latencyMax: { type: Number, required: true, default: 0 },

    /** When this bucket was last recomputed. Useful for spotting a stalled worker. */
    computedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

/**
 * The identity of a bucket. Unique, so the upsert has something to match on and
 * a concurrent double-run cannot create two rows for the same slice.
 */
rollupSchema.index(
  { userId: 1, granularity: 1, bucket: 1, project: 1, model: 1 },
  { unique: true, name: 'rollup_identity' },
);

/** The dashboard's read: one user, one granularity, a time range. */
rollupSchema.index({ userId: 1, granularity: 1, bucket: -1 });

export type RollupDoc = HydratedDocument<InferSchemaType<typeof rollupSchema>>;
export const Rollup = model('Rollup', rollupSchema);
