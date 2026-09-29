/**
 * Redis availability probe for tests.
 *
 * The sliding-window limiter is a Lua script evaluated by Redis, so testing it
 * meaningfully needs a real Redis - a mock would be testing the mock's idea of
 * ZREMRANGEBYSCORE, not Redis's.
 *
 * Rather than fail the suite on a machine without Docker running, the
 * Redis-dependent describes skip with a visible message, and CI runs them for
 * real via a redis service container. A skipped test that announces itself is
 * honest; a test that silently passes against a mock is not.
 */

import IORedis from 'ioredis';

let cached: boolean | null = null;

export async function isRedisAvailable(): Promise<boolean> {
  if (cached !== null) return cached;

  const client = new IORedis(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 0,
    connectTimeout: 1000,
    retryStrategy: () => null,
    lazyConnect: true,
    // Without this an unreachable Redis logs a wall of connection errors.
    enableOfflineQueue: false,
  });

  // ioredis prints "Unhandled error event" if nothing listens, which buries the
  // real test output under connection noise on a machine with no Redis.
  client.on('error', () => {});

  try {
    await client.connect();
    await client.ping();
    cached = true;
  } catch {
    cached = false;
  } finally {
    client.disconnect();
  }

  if (!cached) {
    console.warn(
      '\n  [skipping Redis-dependent tests] No Redis at REDIS_URL.\n' +
        '  Start one with `npm run db:up` to run them locally; CI always runs them.\n',
    );
  }

  return cached;
}

/** Clear rate-limit keys between tests so one test's budget does not leak. */
export async function clearRateLimitKeys(): Promise<void> {
  const client = new IORedis(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    enableOfflineQueue: false,
  });
  client.on('error', () => {});
  try {
    const keys = await client.keys('ratelimit:*');
    if (keys.length > 0) await client.del(...keys);
  } catch {
    // Nothing to clear if Redis is not there.
  } finally {
    client.disconnect();
  }
}
