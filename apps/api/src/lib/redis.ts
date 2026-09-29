/**
 * Redis: three distinct jobs, and they cannot all share one connection.
 *
 *   1. Commands - rate limiting, the metrics cache. Ordinary request/response.
 *   2. Publishing - broadcasting new events to the live tail.
 *   3. Subscribing - each SSE client listening for its user's events.
 *
 * A Redis connection in subscriber mode accepts only subscribe/unsubscribe
 * commands; issuing a GET on it throws. So subscribers get their own
 * connection, and commands and publishes share the main one. Discovering this
 * by having the cache mysteriously fail after opening a live tail is a rite of
 * passage worth skipping.
 */

import IORedis, { type Redis } from 'ioredis';
import { env } from './env.js';
import { childLogger } from './logger.js';

const log = childLogger('redis');

function create(role: string): Redis {
  // maxRetriesPerRequest: null is required for any connection BullMQ touches -
  // with the default, a Redis blip makes blocking commands throw and the queue
  // wedges. Harmless for the others, so it is applied uniformly.
  const client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,

    /**
     * Fail fast when Redis is unreachable instead of queueing.
     *
     * ioredis defaults enableOfflineQueue to true, which means a command issued
     * while disconnected is BUFFERED until a connection comes back - it does not
     * reject. That quietly defeats the rate limiter's fail-open path: the
     * `catch` that is supposed to wave the request through never runs, because
     * the eval never settles at all. The request simply hangs until something
     * upstream times it out.
     *
     * With the offline queue disabled, a command against a dead Redis rejects
     * immediately, the catch fires, and the limiter behaves as designed.
     */
    enableOfflineQueue: false,

    // Bound reconnection attempts so a permanently-absent Redis stops retrying
    // forever and filling the log.
    retryStrategy: (times) => (times > 10 ? null : Math.min(times * 200, 2000)),
  });

  client.on('error', (err) => log.error({ err, role }, 'redis error'));
  client.on('ready', () => log.debug({ role }, 'redis ready'));

  return client;
}

let commandClient: Redis | null = null;

/** Shared connection for commands and publishes. */
export function getRedis(): Redis {
  commandClient ??= create('commands');
  return commandClient;
}

/**
 * A dedicated subscriber connection. NOT shared - each SSE stream gets its own
 * and disposes of it on disconnect, because a connection in subscriber mode is
 * effectively single-purpose.
 */
export function createSubscriber(): Redis {
  return create('subscriber');
}

export async function closeRedis(): Promise<void> {
  if (commandClient) {
    commandClient.disconnect();
    commandClient = null;
  }
}

/* -------------------------------------------------------------------------- */
/* Cache helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Read a JSON value, returning null on a miss or on any Redis trouble. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await getRedis().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err) {
    // A cache is an optimisation. If Redis is down the request should be slow,
    // not broken - so failures here are swallowed and the caller recomputes.
    log.warn({ err, key }, 'cache read failed, falling through to source');
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await getRedis().set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    log.warn({ err, key }, 'cache write failed');
  }
}

/**
 * Delete every key matching a pattern.
 *
 * Uses SCAN, never KEYS. KEYS blocks the entire Redis server while it walks the
 * keyspace - on a large instance that is a multi-second stall for every client,
 * which is why it is effectively banned in production. SCAN walks in bounded
 * chunks and lets other commands interleave.
 */
export async function cacheInvalidatePattern(pattern: string): Promise<number> {
  const client = getRedis();
  let cursor = '0';
  let deleted = 0;

  try {
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) {
        deleted += await client.del(...keys);
      }
    } while (cursor !== '0');
  } catch (err) {
    log.warn({ err, pattern }, 'cache invalidation failed');
  }

  return deleted;
}
