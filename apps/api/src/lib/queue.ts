/**
 * The rollups queue, producer side.
 *
 * The API enqueues a recompute when it ingests events; the worker in apps/worker
 * consumes. Aggregation over a busy window is CPU- and IO-heavy, and doing it
 * inside a request would make ingest latency depend on how much data the user
 * already has - exactly backwards.
 */

import { Queue } from 'bullmq';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  ROLLUP_JOB_OPTIONS,
  truncateToBucket,
  bucketDurationMs,
  type BuildRollupsJob,
  type Granularity,
} from '@usage/shared';
import { getRedis } from './redis.js';
import { childLogger } from './logger.js';

const log = childLogger('queue');

let rollupsQueue: Queue<BuildRollupsJob> | null = null;

export function getRollupsQueue(): Queue<BuildRollupsJob> {
  rollupsQueue ??= new Queue<BuildRollupsJob>(QUEUE_NAMES.rollups, { connection: getRedis() });
  return rollupsQueue;
}

/**
 * Ask for the buckets covering `occurredAt` to be rebuilt.
 *
 * Note the job id: it encodes the exact window being rebuilt. BullMQ refuses a
 * second job with an id that already exists, so a burst of a thousand ingest
 * requests all touching the current hour enqueues ONE rollup job, not a
 * thousand. That debounce is the whole reason the id is deterministic rather
 * than random - without it, a busy ingest endpoint would drown its own worker.
 */
export async function requestRollup(occurredAt: Date, granularity: Granularity): Promise<void> {
  const from = truncateToBucket(occurredAt, granularity);
  const to = new Date(from.getTime() + bucketDurationMs(granularity));

  const payload: BuildRollupsJob = {
    granularity,
    from: from.toISOString(),
    to: to.toISOString(),
  };

  try {
    await getRollupsQueue().add(JOB_NAMES.buildRollups, payload, {
      ...ROLLUP_JOB_OPTIONS,
      jobId: `${granularity}:${from.toISOString()}`,
      /**
       * A short delay, so the job runs after the burst that triggered it rather
       * than during. Events arriving in the next few seconds get folded into the
       * same run instead of each causing another.
       */
      delay: 5_000,
    });
  } catch (err) {
    // Never fail an ingest because the rollup could not be queued. The worker's
    // own periodic schedule will rebuild the window anyway; the enqueue here
    // only makes the dashboard fresher, sooner.
    log.warn({ err, granularity, from }, 'could not enqueue rollup');
  }
}

/** Queue rollups for every granularity covering a timestamp. */
export async function requestRollupsFor(occurredAt: Date): Promise<void> {
  await Promise.all([requestRollup(occurredAt, 'hour'), requestRollup(occurredAt, 'day')]);
}

export async function closeQueue(): Promise<void> {
  await rollupsQueue?.close();
  rollupsQueue = null;
}
