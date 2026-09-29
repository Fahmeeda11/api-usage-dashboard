/**
 * Rollup aggregation tests.
 *
 * The headline property: running the job twice over the same window produces the
 * same numbers, not doubled ones. That is what makes it safe to re-run on a
 * schedule, after a retry, or as a manual backfill - and it is the difference
 * between `$set` and `$inc` in the handler.
 *
 * Runs against a real in-memory MongoDB, because what is under test IS the
 * aggregation pipeline. A mocked model would only prove the mock works.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Types } from 'mongoose';
import { Rollup, UsageEvent, User } from '@usage/db';
import { usdToMicros } from '@usage/shared';
import { handleBuildRollups, percentile, scheduledWindow } from './buildRollups.js';

let memoryServer: MongoMemoryServer;
let userId: Types.ObjectId;
let otherUserId: Types.ObjectId;
const keyId = new Types.ObjectId();

/** The window under test: one fixed hour, so results are deterministic. */
const HOUR = new Date('2026-03-15T10:00:00.000Z');
const NEXT_HOUR = new Date('2026-03-15T11:00:00.000Z');

beforeAll(async () => {
  memoryServer = await MongoMemoryServer.create();
  await mongoose.connect(memoryServer.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
});

afterAll(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));

  const user = await User.create({
    name: 'Test',
    email: `t.${Date.now()}.${Math.random()}@example.test`,
    passwordHash: 'x',
  });
  userId = user._id;

  const other = await User.create({
    name: 'Other',
    email: `o.${Date.now()}.${Math.random()}@example.test`,
    passwordHash: 'x',
  });
  otherUserId = other._id;
});

interface EventOverrides {
  user?: Types.ObjectId;
  project?: string;
  model?: string;
  provider?: string;
  costUsd?: number;
  latencyMs?: number;
  status?: string;
  minutesIntoHour?: number;
  promptTokens?: number;
  completionTokens?: number;
}

async function seedEvent(overrides: EventOverrides = {}) {
  return UsageEvent.create({
    userId: overrides.user ?? userId,
    keyId,
    project: overrides.project ?? 'rag-pipeline',
    provider: overrides.provider ?? 'anthropic',
    model: overrides.model ?? 'claude-opus-5',
    promptTokens: overrides.promptTokens ?? 1000,
    completionTokens: overrides.completionTokens ?? 500,
    costMicros: usdToMicros(overrides.costUsd ?? 0.01),
    latencyMs: overrides.latencyMs ?? 1200,
    status: overrides.status ?? 'ok',
    occurredAt: new Date(HOUR.getTime() + (overrides.minutesIntoHour ?? 5) * 60_000),
  });
}

const job = {
  granularity: 'hour' as const,
  from: HOUR.toISOString(),
  to: NEXT_HOUR.toISOString(),
};

/* -------------------------------------------------------------------------- */

describe('basic aggregation', () => {
  it('folds events into one bucket per (user, project, model)', async () => {
    await seedEvent();
    await seedEvent();
    await seedEvent();

    const result = await handleBuildRollups(job);

    expect(result.buckets).toBe(1);
    expect(result.events).toBe(3);

    const rollup = await Rollup.findOne({ userId, granularity: 'hour' });
    expect(rollup?.requests).toBe(3);
    expect(rollup?.costMicros).toBe(usdToMicros(0.01) * 3);
    expect(rollup?.promptTokens).toBe(3000);
    expect(rollup?.bucket.toISOString()).toBe(HOUR.toISOString());
  });

  it('separates buckets by model', async () => {
    await seedEvent({ model: 'claude-opus-5' });
    await seedEvent({ model: 'claude-haiku-4-5-20251001' });

    await handleBuildRollups(job);

    const rollups = await Rollup.find({ userId }).sort({ model: 1 });
    expect(rollups).toHaveLength(2);
  });

  it('separates buckets by project', async () => {
    await seedEvent({ project: 'rag-pipeline' });
    await seedEvent({ project: 'eval-harness' });

    await handleBuildRollups(job);

    expect(await Rollup.countDocuments({ userId })).toBe(2);
  });

  it('counts anything that is not ok as an error', async () => {
    await seedEvent({ status: 'ok' });
    await seedEvent({ status: 'error' });
    await seedEvent({ status: 'timeout' });
    await seedEvent({ status: 'rate_limited' });

    await handleBuildRollups(job);

    const rollup = await Rollup.findOne({ userId });
    expect(rollup?.requests).toBe(4);
    expect(rollup?.errorCount).toBe(3);
  });

  it('ignores events outside the window', async () => {
    await seedEvent({ minutesIntoHour: 30 });
    // 90 minutes in, i.e. the next hour.
    await seedEvent({ minutesIntoHour: 90 });

    const result = await handleBuildRollups(job);

    expect(result.events).toBe(1);
  });

  it('does nothing gracefully when the window is empty', async () => {
    const result = await handleBuildRollups(job);

    expect(result.buckets).toBe(0);
    expect(result.events).toBe(0);
    expect(result.affectedUsers).toEqual([]);
  });

  it('keeps each user in their own buckets', async () => {
    await seedEvent({ user: userId });
    await seedEvent({ user: otherUserId });

    await handleBuildRollups(job);

    expect(await Rollup.countDocuments({ userId })).toBe(1);
    expect(await Rollup.countDocuments({ userId: otherUserId })).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */

describe('idempotency', () => {
  /**
   * The property the whole design turns on. The job runs on a schedule, on
   * ingest, and on retry - so it must converge, not accumulate.
   */
  it('produces identical numbers when run twice', async () => {
    await seedEvent({ costUsd: 0.02 });
    await seedEvent({ costUsd: 0.03 });

    await handleBuildRollups(job);
    const first = await Rollup.findOne({ userId }).lean();

    await handleBuildRollups(job);
    const second = await Rollup.findOne({ userId }).lean();

    expect(second?.requests).toBe(first?.requests);
    expect(second?.costMicros).toBe(first?.costMicros);
    expect(second?.promptTokens).toBe(first?.promptTokens);
    // Specifically NOT doubled, which is what $inc would have produced.
    expect(second?.requests).toBe(2);
    expect(second?.costMicros).toBe(usdToMicros(0.05));
  });

  it('stays correct across five runs', async () => {
    await seedEvent();
    await seedEvent();

    for (let i = 0; i < 5; i++) {
      await handleBuildRollups(job);
    }

    expect(await Rollup.countDocuments({ userId })).toBe(1);
    expect((await Rollup.findOne({ userId }))?.requests).toBe(2);
  });

  it('creates exactly one bucket when concurrent runs race', async () => {
    await seedEvent();

    // The unique index on the rollup identity is what makes this safe: one
    // upsert inserts, the others update the same document.
    await Promise.all([
      handleBuildRollups(job),
      handleBuildRollups(job),
      handleBuildRollups(job),
    ]);

    expect(await Rollup.countDocuments({ userId })).toBe(1);
    expect((await Rollup.findOne({ userId }))?.requests).toBe(1);
  });

  it('picks up events that arrive after the first run', async () => {
    await seedEvent();
    await handleBuildRollups(job);
    expect((await Rollup.findOne({ userId }))?.requests).toBe(1);

    // A late-arriving event for an already-rolled-up window.
    await seedEvent();
    await handleBuildRollups(job);

    expect((await Rollup.findOne({ userId }))?.requests).toBe(2);
  });

  /**
   * A bucket whose raw events are gone must not keep reporting spend - that
   * would show cost for a period with no data behind it.
   */
  it('removes a bucket whose events have all disappeared', async () => {
    await seedEvent();
    await handleBuildRollups(job);
    expect(await Rollup.countDocuments({ userId })).toBe(1);

    await UsageEvent.deleteMany({ userId });
    await handleBuildRollups(job);

    expect(await Rollup.countDocuments({ userId })).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('percentiles', () => {
  it('computes p50 and p95 over a bucket', async () => {
    // 1..100ms, so p50 is ~50 and p95 is ~95.
    for (let ms = 1; ms <= 100; ms++) {
      await seedEvent({ latencyMs: ms });
    }

    await handleBuildRollups(job);
    const rollup = await Rollup.findOne({ userId });

    // Approximate (t-digest), so assert a band rather than an exact value.
    expect(rollup?.latencyP50).toBeGreaterThanOrEqual(45);
    expect(rollup?.latencyP50).toBeLessThanOrEqual(55);
    expect(rollup?.latencyP95).toBeGreaterThanOrEqual(90);
    expect(rollup?.latencyP95).toBeLessThanOrEqual(100);
    expect(rollup?.latencyMax).toBe(100);
  });

  it('handles a bucket with a single event', async () => {
    await seedEvent({ latencyMs: 750 });

    await handleBuildRollups(job);
    const rollup = await Rollup.findOne({ userId });

    expect(rollup?.latencyP50).toBe(750);
    expect(rollup?.latencyP95).toBe(750);
  });
});

describe('percentile()', () => {
  // The fallback path used when $percentile is unavailable (MongoDB < 7).
  it('returns 0 for an empty set rather than NaN', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([], 0.95)).toBe(0);
  });

  it('returns the only value for a single-element set', () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
  });

  it('computes nearest-rank percentiles', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.95)).toBe(95);
    expect(percentile(values, 1)).toBe(100);
  });

  it('does not depend on input order', () => {
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  it('does not mutate its input', () => {
    const values = [5, 1, 3];
    percentile(values, 0.5);
    expect(values).toEqual([5, 1, 3]);
  });
});

/* -------------------------------------------------------------------------- */

describe('daily granularity', () => {
  it('folds a whole day into one bucket', async () => {
    await seedEvent({ minutesIntoHour: 5 });
    await seedEvent({ minutesIntoHour: 300 });
    await seedEvent({ minutesIntoHour: 700 });

    const result = await handleBuildRollups({
      granularity: 'day',
      from: '2026-03-15T00:00:00.000Z',
      to: '2026-03-16T00:00:00.000Z',
    });

    expect(result.buckets).toBe(1);
    expect(result.events).toBe(3);

    const rollup = await Rollup.findOne({ userId, granularity: 'day' });
    expect(rollup?.bucket.toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });

  it('keeps hourly and daily rollups as separate documents', async () => {
    await seedEvent();

    await handleBuildRollups(job);
    await handleBuildRollups({
      granularity: 'day',
      from: '2026-03-15T00:00:00.000Z',
      to: '2026-03-16T00:00:00.000Z',
    });

    expect(await Rollup.countDocuments({ userId, granularity: 'hour' })).toBe(1);
    expect(await Rollup.countDocuments({ userId, granularity: 'day' })).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */

describe('scheduledWindow', () => {
  const now = new Date('2026-03-15T10:42:31.000Z');

  it('aligns an hourly window to bucket boundaries', () => {
    const { from, to } = scheduledWindow('hour', 3 * 3_600_000, now);
    expect(from.toISOString()).toBe('2026-03-15T07:00:00.000Z');
    // Exclusive end, one bucket past the current hour, so the in-progress hour
    // is included rather than perpetually lagging.
    expect(to.toISOString()).toBe('2026-03-15T11:00:00.000Z');
  });

  it('aligns a daily window to midnight UTC', () => {
    const { from, to } = scheduledWindow('day', 2 * 86_400_000, now);
    expect(from.toISOString()).toBe('2026-03-13T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-03-16T00:00:00.000Z');
  });

  it('always includes the bucket currently in progress', () => {
    const { from, to } = scheduledWindow('hour', 3_600_000, now);
    expect(now.getTime()).toBeGreaterThanOrEqual(from.getTime());
    expect(now.getTime()).toBeLessThan(to.getTime());
  });
});
