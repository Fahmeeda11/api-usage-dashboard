/**
 * Sliding-window rate limiting, backed by Redis.
 *
 * Why not a fixed window
 * ----------------------
 * The naive implementation is INCR on a key named for the current minute. It is
 * one command and it is wrong at the boundary: a caller limited to 600/min can
 * send 600 requests at 10:00:59 and another 600 at 10:01:00, so 1200 land inside
 * two seconds. The limit is nominally enforced and the server still falls over.
 *
 * A sliding window fixes that by counting requests in the trailing N
 * milliseconds regardless of where clock boundaries fall. This uses the sorted-set
 * technique: each request is a member scored by timestamp, entries older than the
 * window are trimmed, and the remaining cardinality is the current count.
 *
 * Why the Lua script
 * ------------------
 * Trim, count, add and expire have to happen atomically. Issued as four separate
 * commands, two callers can interleave between the count and the add and both
 * conclude they are under the limit - the exact race the limiter exists to
 * prevent. Redis runs a script atomically, so the whole decision is one
 * indivisible step. A MULTI pipeline would not do: it batches commands but
 * cannot branch on an intermediate result.
 */

import type { RequestHandler } from 'express';
import { AppError, ErrorCode } from '../lib/errors.js';
import { getRedis } from '../lib/redis.js';
import { childLogger } from '../lib/logger.js';
import { env } from '../lib/env.js';

const log = childLogger('rate-limit');

/**
 * KEYS[1] - the sorted set for this caller
 * ARGV[1] - now (ms)
 * ARGV[2] - window size (ms)
 * ARGV[3] - max requests in the window
 * ARGV[4] - a unique member id for this request
 *
 * Returns { allowed, count, resetMs }
 */
const SLIDING_WINDOW_SCRIPT = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max    = tonumber(ARGV[3])
local member = ARGV[4]

-- Drop everything that has fallen out of the trailing window.
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

local count = redis.call('ZCARD', key)

if count >= max then
  -- Over the limit. Do NOT add this request: counting rejected requests would
  -- let a client that keeps hammering hold its own window open indefinitely.
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetMs = window
  if oldest[2] then
    resetMs = (tonumber(oldest[2]) + window) - now
  end
  return { 0, count, resetMs }
end

redis.call('ZADD', key, now, member)
-- Expire the whole key once the window has fully drained, so idle callers do
-- not leave keys behind forever.
redis.call('PEXPIRE', key, window)

return { 1, count + 1, window }
`;

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  /** Which caller is being limited. Defaults to the API key, falling back to IP. */
  keyBy?: (req: { apiKeyId?: string; ip?: string }) => string;
}

export function rateLimit(options: RateLimitOptions = {}): RequestHandler {
  const windowMs = options.windowMs ?? env.RATE_LIMIT_WINDOW_MS;
  const max = options.max ?? env.RATE_LIMIT_MAX;

  const keyBy =
    options.keyBy ??
    ((req: { apiKeyId?: string; ip?: string }) =>
      req.apiKeyId ? `key:${req.apiKeyId}` : `ip:${req.ip ?? 'unknown'}`);

  return async (req, res, next) => {
    try {
      const bucket = `ratelimit:${keyBy(req)}`;
      const now = Date.now();
      const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

      const result = (await getRedis().eval(
        SLIDING_WINDOW_SCRIPT,
        1,
        bucket,
        String(now),
        String(windowMs),
        String(max),
        member,
      )) as [number, number, number];

      const [allowed, count, resetMs] = result;
      const retryAfterSeconds = Math.max(1, Math.ceil(resetMs / 1000));

      // Standard headers, so a well-behaved client can back off BEFORE being
      // rejected rather than discovering the limit by hitting it.
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, max - count)));
      res.setHeader('RateLimit-Reset', String(retryAfterSeconds));

      if (!allowed) {
        res.setHeader('Retry-After', String(retryAfterSeconds));
        next(
          new AppError(
            429,
            ErrorCode.RATE_LIMITED,
            `Rate limit exceeded. Retry in ${retryAfterSeconds}s.`,
          ),
        );
        return;
      }

      next();
    } catch (err) {
      /**
       * Fail OPEN, deliberately.
       *
       * If Redis is unreachable the choice is to reject every request or accept
       * every request. For a usage-ingest endpoint, dropping customers' data
       * because our cache is down is far worse than briefly serving traffic
       * unthrottled. A limiter protecting something destructive should fail
       * closed instead - the right answer depends on what is behind it.
       */
      log.error({ err }, 'rate limiter unavailable, allowing request through');
      next();
    }
  };
}
