/**
 * Worker entry point.
 *
 * Runs the rollup aggregations that keep the dashboard fast. A separate process
 * from the API, deliberately: aggregating a busy hour is CPU- and IO-heavy, and
 * on the API's event loop it would add latency to every request on the box -
 * including the ingest endpoint whose whole job is to be fast.
 */

import { Queue, Worker, type Job } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  ROLLUP_JOB_OPTIONS,
  ROLLUP_SCHEDULE,
  GRANULARITIES,
  type BuildRollupsJob,
  type Granularity,
} from '@usage/shared';
import {
  connectDb,
  disconnectDb,
  handleBuildRollups,
  cachePatternsFor,
  scheduledWindow,
} from '@usage/db';
import { env } from './env.js';
import { logger } from './logger.js';

function createConnection(): Redis {
  const client = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  client.on('error', (err) => logger.error({ err }, 'redis error'));
  return client;
}

/**
 * Drop cached metrics for the users whose rollups just changed.
 *
 * Explicit invalidation rather than waiting for the TTL: a user who just sent
 * events and opens the dashboard should see them, not a cached response from 50
 * seconds ago. The TTL remains as the backstop for anything this misses.
 *
 * SCAN, never KEYS - KEYS blocks the whole Redis server while it walks the
 * keyspace.
 */
async function invalidateCaches(connection: Redis, users: string[]): Promise<void> {
  if (users.length === 0) return;

  for (const pattern of cachePatternsFor(users)) {
    let cursor = '0';
    do {
      const [next, keys] = await connection.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await connection.del(...keys);
    } while (cursor !== '0');
  }

  logger.debug({ users: users.length }, 'invalidated metrics caches');
}

async function main(): Promise<void> {
  await connectDb(env.MONGO_URI, {
    onEvent: (event, detail) => {
      if (event === 'error') logger.error({ err: detail }, 'mongo connection error');
      else logger.warn({ event }, `mongo ${event}`);
    },
  });
  logger.info('mongo connected');

  const connection = createConnection();
  const queue = new Queue<BuildRollupsJob>(QUEUE_NAMES.rollups, { connection });

  const worker = new Worker<BuildRollupsJob>(
    QUEUE_NAMES.rollups,
    async (job: Job<BuildRollupsJob>) => {
      // The data layer stays logger-agnostic; the worker supplies pino.
      const result = await handleBuildRollups(job.data, (event, detail) =>
        logger.info(detail, event),
      );
      await invalidateCaches(connection, result.affectedUsers);
      return result;
    },
    {
      connection,
      concurrency: env.WORKER_CONCURRENCY,
      // Aggregations over a busy window can legitimately take a while; the
      // default 30s lock would let a long run be reclaimed as stalled and
      // executed twice concurrently.
      lockDuration: 120_000,
    },
  );

  worker.on('completed', (job, result) => {
    logger.debug({ jobId: job.id, buckets: result?.buckets }, 'rollup job completed');
  });
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, attempts: job?.attemptsMade, err }, 'rollup job failed');
  });
  worker.on('error', (err) => logger.error({ err }, 'worker error'));

  /* ---------------------------------------------------------------------- */

  /**
   * Repeatable schedules, one per granularity.
   *
   * These are the safety net. Ingest also enqueues a rollup for the buckets it
   * touches, which makes the dashboard near-live - but that enqueue can fail,
   * Redis can lose a job, and events can arrive late for a window nothing is
   * about to touch. The schedule reconciles from the database regardless, on
   * the same principle as the job-tracker sweeper: the queue makes work timely,
   * only a durable store makes it reliable.
   */
  for (const granularity of GRANULARITIES) {
    const schedule = ROLLUP_SCHEDULE[granularity];

    await queue.add(
      JOB_NAMES.buildRollups,
      // Placeholder payload; the real window is computed at run time, since a
      // repeatable job's data is fixed when it is registered and would
      // otherwise pin the window to whenever the worker last booted.
      { granularity, from: '', to: '' },
      {
        ...ROLLUP_JOB_OPTIONS,
        repeat: { every: schedule.everyMs },
        // A stable name so restarting the worker updates the existing schedule
        // instead of stacking up a new one on every deploy.
        jobId: `scheduled:${granularity}`,
      },
    );
  }

  /**
   * Repeatable jobs carry an empty window, so fill it in here. Kept out of the
   * handler so the handler stays a pure function of its payload - which is what
   * makes it testable without mocking a clock.
   */
  worker.on('active', (job) => {
    if (job.data.from === '' && job.name === JOB_NAMES.buildRollups) {
      const granularity = job.data.granularity as Granularity;
      const lookbackMs =
        granularity === 'hour'
          ? env.ROLLUP_HOUR_LOOKBACK_HOURS * 3_600_000
          : env.ROLLUP_DAY_LOOKBACK_DAYS * 86_400_000;

      const { from, to } = scheduledWindow(granularity, lookbackMs);
      job.data.from = from.toISOString();
      job.data.to = to.toISOString();
    }
  });

  logger.info({ concurrency: env.WORKER_CONCURRENCY }, 'rollup worker started');

  /* ---------------------------------------------------------------------- */

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const timeout = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 30_000);
    timeout.unref();

    try {
      // Waits for in-flight aggregations rather than abandoning them mid-write.
      await worker.close();
      await queue.close();
      connection.disconnect();
      await disconnectDb();
      clearTimeout(timeout);
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
