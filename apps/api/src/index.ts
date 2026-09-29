/**
 * Server entry point.
 *
 * Boots in a deliberate order - config, then database, then HTTP - and shuts
 * down in reverse. The graceful shutdown matters more than it looks: without it,
 * a deploy kills the process mid-request and the user sees a failed save for a
 * change that may or may not have been written.
 */

import { createApp } from './app.js';
import { env, isProduction } from './lib/env.js';
import { logger } from './lib/logger.js';
import { connectDb, disconnectDb, syncIndexes } from '@usage/db';
import { closeQueue } from './lib/queue.js';
import { closeRedis } from './lib/redis.js';

async function main(): Promise<void> {
  await connectDb(env.MONGO_URI, {
    onEvent: (event, detail) => {
      if (event === 'error') logger.error({ err: detail }, 'mongo connection error');
      else logger.warn({ event }, `mongo ${event}`);
    },
  });
  logger.info('mongo connected');

  // In production autoIndex is off, so indexes are built explicitly here where
  // the cost is logged rather than silently paid on first query.
  if (isProduction) {
    await syncIndexes((model, ms) => logger.info({ model, ms }, 'indexes synced'));
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');
  });

  // Node's default is 5s, shorter than many load balancers' idle timeout, which
  // produces sporadic 502s when the LB reuses a connection the server just closed.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    // Stop accepting new connections, let in-flight requests finish.
    server.close(() => logger.info('http server closed'));

    // Hard deadline. If something is wedged, exiting non-zero is better than
    // hanging forever and being SIGKILLed with no log line explaining why.
    const timeout = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000);
    timeout.unref();

    try {
      await closeQueue();
      await closeRedis();
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

  // An unhandled rejection means state is unknown. Log it and let the platform
  // restart a clean process rather than continuing in a corrupt one.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
