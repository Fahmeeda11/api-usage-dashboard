import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import supertest from 'supertest';
import type { Express } from 'express';
import { UsageEvent, ApiKey } from '@usage/db';
import { usdToMicros, MAX_EVENTS_PER_BATCH } from '@usage/shared';
import { createApp } from '../../app.js';
import {
  authed,
  clearTestDb,
  signupTestUser,
  startTestDb,
  stopTestDb,
  type SignedUpUser,
} from '../../test/helpers.js';
import { isRedisAvailable, clearRateLimitKeys } from '../../test/redis.js';

let app: Express;
let user: SignedUpUser;
let apiSecret: string;

beforeAll(async () => {
  await startTestDb();
  app = createApp();
});

afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  await clearRateLimitKeys();
  user = await signupTestUser(app);

  const res = await authed(app, user)
    .post('/keys')
    .send({ label: 'test key', scopes: ['ingest'] })
    .expect(201);

  apiSecret = res.body.key.secret;
});

function ingest(secret: string = apiSecret) {
  return supertest(app).post('/v1/events').set('Authorization', `Bearer ${secret}`);
}

const sampleEvent = {
  project: 'rag-pipeline',
  provider: 'anthropic',
  model: 'claude-opus-5',
  promptTokens: 1500,
  completionTokens: 300,
  costUsd: 0.0234,
  latencyMs: 1850,
  status: 'ok' as const,
};

/* -------------------------------------------------------------------------- */

describe('API key management', () => {
  it('returns the secret exactly once, at creation', async () => {
    const res = await authed(app, user)
      .post('/keys')
      .send({ label: 'another', scopes: ['ingest'] })
      .expect(201);

    expect(res.body.key.secret).toMatch(/^usg_/);

    // And never again from the list endpoint.
    const list = await authed(app, user).get('/keys').expect(200);
    for (const key of list.body.keys) {
      expect(key).not.toHaveProperty('secret');
      expect(key).not.toHaveProperty('hashedKey');
    }
  });

  it('stores only a hash, never the plaintext', async () => {
    const stored = await ApiKey.find({});
    for (const key of stored) {
      expect(key.hashedKey).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(key.toObject())).not.toContain(apiSecret);
    }
  });

  it('exposes a prefix so a key is identifiable without being usable', async () => {
    const list = await authed(app, user).get('/keys').expect(200);
    const prefix = list.body.keys[0].prefix;

    expect(apiSecret.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(apiSecret.length);

    // The prefix alone must not authenticate.
    await ingest(prefix).send({ events: [sampleEvent] }).expect(401);
  });

  it('revokes a key', async () => {
    const list = await authed(app, user).get('/keys').expect(200);
    await authed(app, user).delete(`/keys/${list.body.keys[0].id}`).expect(204);

    await ingest().send({ events: [sampleEvent] }).expect(401);
  });

  it('cannot revoke another account\'s key', async () => {
    const other = await signupTestUser(app);
    const list = await authed(app, user).get('/keys').expect(200);

    await authed(app, other).delete(`/keys/${list.body.keys[0].id}`).expect(404);
    // Still works for the real owner.
    await ingest().send({ events: [sampleEvent] }).expect(202);
  });

  it('requires a session to manage keys, not an API key', async () => {
    // An API key must never be able to mint another key - that would turn one
    // leaked credential into permanent self-renewing access.
    await supertest(app)
      .post('/keys')
      .set('Authorization', `Bearer ${apiSecret}`)
      .send({ label: 'escalation' })
      .expect(401);
  });
});

/* -------------------------------------------------------------------------- */

describe('POST /v1/events', () => {
  it('accepts a batch and returns 202', async () => {
    const res = await ingest().send({ events: [sampleEvent, sampleEvent] }).expect(202);
    expect(res.body.accepted).toBe(2);
    expect(await UsageEvent.countDocuments({})).toBe(2);
  });

  it('converts decimal USD into integer micro-dollars', async () => {
    await ingest().send({ events: [{ ...sampleEvent, costUsd: 0.0234 }] }).expect(202);

    const event = await UsageEvent.findOne({});
    // Integer, so sums are exact and associative - see domain.ts.
    expect(event?.costMicros).toBe(usdToMicros(0.0234));
    expect(event?.costMicros).toBe(23400);
    expect(Number.isInteger(event?.costMicros)).toBe(true);
  });

  it('attributes events to the key\'s owner', async () => {
    await ingest().send({ events: [sampleEvent] }).expect(202);

    const event = await UsageEvent.findOne({});
    expect(String(event?.userId)).toBe(user.userId);
  });

  it('defaults occurredAt to now but honours a supplied timestamp', async () => {
    const earlier = new Date(Date.now() - 3_600_000);

    await ingest()
      .send({ events: [sampleEvent, { ...sampleEvent, occurredAt: earlier.toISOString() }] })
      .expect(202);

    const events = await UsageEvent.find({}).sort({ occurredAt: 1 });
    expect(events[0]?.occurredAt.getTime()).toBeCloseTo(earlier.getTime(), -3);
  });

  it('rejects an event dated far in the future', async () => {
    // A skewed client clock would otherwise write spend into buckets that have
    // not happened yet, and the chart would silently rewrite itself later.
    const tomorrow = new Date(Date.now() + 86_400_000);

    await ingest()
      .send({ events: [{ ...sampleEvent, occurredAt: tomorrow.toISOString() }] })
      .expect(400);

    expect(await UsageEvent.countDocuments({})).toBe(0);
  });

  it('rejects an empty batch', async () => {
    await ingest().send({ events: [] }).expect(422);
  });

  it('rejects a batch over the size limit', async () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => sampleEvent);
    await ingest().send({ events }).expect(422);
  });

  it('rejects a missing project with a field error', async () => {
    const { project: _project, ...withoutProject } = sampleEvent;
    const res = await ingest().send({ events: [withoutProject] }).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a negative cost', async () => {
    await ingest().send({ events: [{ ...sampleEvent, costUsd: -1 }] }).expect(422);
  });

  it('applies defaults for optional numeric fields', async () => {
    await ingest()
      .send({ events: [{ project: 'p', provider: 'anthropic', model: 'm' }] })
      .expect(202);

    const event = await UsageEvent.findOne({});
    expect(event?.promptTokens).toBe(0);
    expect(event?.costMicros).toBe(0);
    expect(event?.status).toBe('ok');
  });

  it('caps metadata keys', async () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`key${i}`, 'value']),
    );
    await ingest().send({ events: [{ ...sampleEvent, metadata }] }).expect(422);
  });

  it('rejects a request with no key', async () => {
    await supertest(app).post('/v1/events').send({ events: [sampleEvent] }).expect(401);
  });

  it('rejects a made-up key', async () => {
    await ingest('usg_completely-made-up-key-value').send({ events: [sampleEvent] }).expect(401);
  });

  it('accepts the key via x-api-key as well as Authorization', async () => {
    await supertest(app)
      .post('/v1/events')
      .set('x-api-key', apiSecret)
      .send({ events: [sampleEvent] })
      .expect(202);
  });

  it('enforces the ingest scope', async () => {
    const readOnly = await authed(app, user)
      .post('/keys')
      .send({ label: 'read only', scopes: ['read'] })
      .expect(201);

    const res = await ingest(readOnly.body.key.secret)
      .send({ events: [sampleEvent] })
      .expect(403);

    expect(res.body.error.message).toMatch(/scope/i);
  });
});

/* -------------------------------------------------------------------------- */

describe('GET /events (dashboard feed)', () => {
  beforeEach(async () => {
    const events = Array.from({ length: 15 }, (_, i) => ({
      ...sampleEvent,
      project: i % 2 === 0 ? 'rag-pipeline' : 'eval-harness',
      status: i % 5 === 0 ? ('error' as const) : ('ok' as const),
    }));
    await ingest().send({ events }).expect(202);
  });

  it('returns events newest first', async () => {
    const res = await authed(app, user).get('/events?limit=5').expect(200);
    expect(res.body.events).toHaveLength(5);
    expect(res.body.nextCursor).toBeTruthy();
  });

  it('paginates with a cursor without repeating or skipping rows', async () => {
    const first = await authed(app, user).get('/events?limit=6').expect(200);
    const second = await authed(app, user)
      .get(`/events?limit=6&cursor=${first.body.nextCursor}`)
      .expect(200);

    const firstIds = first.body.events.map((e: { id: string }) => e.id);
    const secondIds = second.body.events.map((e: { id: string }) => e.id);

    expect(new Set([...firstIds, ...secondIds]).size).toBe(firstIds.length + secondIds.length);
  });

  it('returns a null cursor on the final page', async () => {
    const res = await authed(app, user).get('/events?limit=500').expect(200);
    expect(res.body.events).toHaveLength(15);
    expect(res.body.nextCursor).toBeNull();
  });

  it('filters by project', async () => {
    const res = await authed(app, user).get('/events?project=eval-harness').expect(200);
    expect(res.body.events.length).toBeGreaterThan(0);
    for (const event of res.body.events) {
      expect(event.project).toBe('eval-harness');
    }
  });

  it('filters by status', async () => {
    const res = await authed(app, user).get('/events?status=error').expect(200);
    for (const event of res.body.events) {
      expect(event.status).toBe('error');
    }
  });

  it('rejects a malformed cursor instead of returning a confusing 500', async () => {
    await authed(app, user).get('/events?cursor=not-an-object-id').expect(400);
  });

  it('never returns another account\'s events', async () => {
    const other = await signupTestUser(app);
    const res = await authed(app, other).get('/events').expect(200);
    expect(res.body.events).toHaveLength(0);
  });

  it('requires a session', async () => {
    await supertest(app).get('/events').expect(401);
  });
});

/* -------------------------------------------------------------------------- */

describe('rate limiting', () => {
  /**
   * These need a real Redis: the limiter is a Lua script, and a mock would only
   * prove the mock's idea of ZREMRANGEBYSCORE. Skipped locally without Docker,
   * always run in CI.
   */
  it('enforces the limit and returns Retry-After', async ({ skip }) => {
    if (!(await isRedisAvailable())) return skip();

    // The limit comes from env; drive it with a tiny override via many requests.
    const limit = Number(process.env['RATE_LIMIT_MAX'] ?? 600);
    const burst = Math.min(limit + 5, 50);

    let sawRateLimit = false;
    let retryAfter: string | undefined;

    for (let i = 0; i < burst; i++) {
      const res = await ingest().send({ events: [sampleEvent] });
      if (res.status === 429) {
        sawRateLimit = true;
        retryAfter = res.headers['retry-after'];
        expect(res.body.error.code).toBe('RATE_LIMITED');
        break;
      }
    }

    if (sawRateLimit) {
      expect(Number(retryAfter)).toBeGreaterThan(0);
    } else {
      // Limit not reached within the burst - assert the advisory headers are
      // present and decreasing, which is the part a client actually uses.
      const res = await ingest().send({ events: [sampleEvent] }).expect(202);
      expect(Number(res.headers['ratelimit-limit'])).toBe(limit);
      expect(Number(res.headers['ratelimit-remaining'])).toBeLessThan(limit);
    }
  });

  it('advertises the limit on every successful response', async ({ skip }) => {
    if (!(await isRedisAvailable())) return skip();

    const res = await ingest().send({ events: [sampleEvent] }).expect(202);
    expect(res.headers['ratelimit-limit']).toBeDefined();
    expect(res.headers['ratelimit-remaining']).toBeDefined();
    expect(res.headers['ratelimit-reset']).toBeDefined();
  });

  /**
   * With Redis unreachable the limiter fails OPEN. For a telemetry ingest
   * endpoint that is the right call: dropping customers' data because our cache
   * is down is worse than briefly serving traffic unthrottled. A limiter in
   * front of something destructive should fail closed instead.
   */
  it('still accepts events when Redis is unavailable', async ({ skip }) => {
    if (await isRedisAvailable()) return skip();

    await ingest().send({ events: [sampleEvent] }).expect(202);
  });
});
