/**
 * Seed a demo account with a week of realistic usage.
 *
 *   npm run seed
 *
 * Generates raw events only; the worker builds the rollups the dashboard reads.
 * If the worker is not running, `npm run seed -- --rollup` computes them inline
 * so the dashboard is not empty.
 *
 * Idempotent: rerunning wipes the demo account's data and regenerates it.
 */

import { randomUUID } from 'node:crypto';
import {
  usdToMicros,
  truncateToBucket,
  type EventStatus,
} from '@usage/shared';
import {
  ApiKey,
  Rollup,
  UsageEvent,
  User,
  connectDb,
  disconnectDb,
  generateApiKey,
  handleBuildRollups,
} from '@usage/db';
import { env } from '../lib/env.js';
import { hashPassword } from '../features/auth/service.js';

const DEMO_EMAIL = 'demo@api-usage.local';
const DEMO_PASSWORD = 'demo-password-1234';
const DAYS = 7;

/** Rough public pricing, USD per million tokens. Only needs to be plausible. */
const MODELS = [
  { provider: 'anthropic', model: 'claude-opus-5', inPer1M: 15, outPer1M: 75, share: 0.3 },
  { provider: 'anthropic', model: 'claude-sonnet-5', inPer1M: 3, outPer1M: 15, share: 0.45 },
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inPer1M: 0.8, outPer1M: 4, share: 0.25 },
];

const PROJECTS = [
  { name: 'production-rag-system', weight: 0.5 },
  { name: 'llm-eval-framework', weight: 0.3 },
  { name: 'agentic-rag-mcp', weight: 0.2 },
];

/** Deterministic PRNG, so a seeded board looks the same on every run. */
let prngState = 1337;
function random(): number {
  prngState = (prngState * 1103515245 + 12345) & 0x7fffffff;
  return prngState / 0x7fffffff;
}

function pick<T extends { weight?: number; share?: number }>(items: T[]): T {
  const total = items.reduce((sum, i) => sum + (i.weight ?? i.share ?? 1), 0);
  let roll = random() * total;
  for (const item of items) {
    roll -= item.weight ?? item.share ?? 1;
    if (roll <= 0) return item;
  }
  return items[items.length - 1] as T;
}

/**
 * Traffic shaped like a working day: a ramp in the morning, a dip at lunch, a
 * tail into the evening, and near-silence overnight. Flat random traffic makes
 * the charts look wrong in a way that is hard to put your finger on.
 */
function requestsForHour(hour: number, dayOfWeek: number): number {
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return Math.floor(random() * 12);
  }
  const shape = [
    2, 1, 1, 1, 1, 2, 5, 14, 34, 52, 61, 58, 42, 55, 63, 59, 48, 36, 24, 18, 12, 8, 5, 3,
  ];
  const base = shape[hour] ?? 5;
  return Math.max(0, Math.round(base * (0.7 + random() * 0.6)));
}

function statusFor(): EventStatus {
  const roll = random();
  if (roll > 0.985) return 'error';
  if (roll > 0.978) return 'timeout';
  if (roll > 0.974) return 'rate_limited';
  return 'ok';
}

async function main(): Promise<void> {
  const alsoRollup = process.argv.includes('--rollup');

  await connectDb(env.MONGO_URI);
  console.info(`connected to ${env.MONGO_URI}`);

  let user = await User.findOne({ email: DEMO_EMAIL });

  if (user) {
    await Promise.all([
      UsageEvent.deleteMany({ userId: user._id }),
      Rollup.deleteMany({ userId: user._id }),
      ApiKey.deleteMany({ userId: user._id }),
    ]);
    console.info('cleared existing demo data');
  } else {
    user = await User.create({
      name: 'Demo User',
      email: DEMO_EMAIL,
      passwordHash: await hashPassword(DEMO_PASSWORD),
    });
    console.info('created demo user');
  }

  const generated = generateApiKey();
  const key = await ApiKey.create({
    userId: user._id,
    label: 'demo ingest key',
    scopes: ['ingest'],
    hashedKey: generated.hashedKey,
    prefix: generated.prefix,
  });

  /* ---------------------------------------------------------------------- */

  const now = new Date();
  const docs: Record<string, unknown>[] = [];

  for (let daysAgo = DAYS - 1; daysAgo >= 0; daysAgo--) {
    const day = new Date(now.getTime() - daysAgo * 86_400_000);

    for (let hour = 0; hour < 24; hour++) {
      const bucket = new Date(day);
      bucket.setHours(hour, 0, 0, 0);
      if (bucket > now) continue;

      const count = requestsForHour(hour, bucket.getDay());

      for (let i = 0; i < count; i++) {
        const model = pick(MODELS);
        const project = pick(PROJECTS);
        const status = statusFor();

        const promptTokens = Math.round(600 + random() * 4200);
        const completionTokens = status === 'ok' ? Math.round(80 + random() * 900) : 0;

        const costUsd =
          (promptTokens / 1_000_000) * model.inPer1M +
          (completionTokens / 1_000_000) * model.outPer1M;

        // Opus is slower than Haiku, and failures are slower still - a flat
        // latency distribution would make the p95 chart meaningless.
        const baseLatency = model.model.includes('opus')
          ? 2400
          : model.model.includes('sonnet')
            ? 1200
            : 550;
        const latencyMs =
          status === 'timeout'
            ? 30_000
            : Math.round(baseLatency * (0.6 + random() * 1.1) + (random() > 0.95 ? 4000 : 0));

        const occurredAt = new Date(bucket.getTime() + Math.floor(random() * 3_600_000));

        docs.push({
          userId: user._id,
          keyId: key._id,
          project: project.name,
          provider: model.provider,
          model: model.model,
          promptTokens,
          completionTokens,
          costMicros: usdToMicros(costUsd),
          latencyMs,
          status,
          metadata: { requestId: randomUUID().slice(0, 8) },
          occurredAt,
        });
      }
    }
  }

  // One insertMany rather than thousands of inserts.
  await UsageEvent.insertMany(docs, { ordered: false });
  console.info(`seeded ${docs.length.toLocaleString()} usage events over ${DAYS} days`);

  /* ---------------------------------------------------------------------- */

  if (alsoRollup) {
    console.info('building rollups inline...');
    const from = truncateToBucket(new Date(now.getTime() - DAYS * 86_400_000), 'day');
    const to = new Date(truncateToBucket(now, 'day').getTime() + 86_400_000);

    for (const granularity of ['hour', 'day'] as const) {
      const result = await handleBuildRollups({
        granularity,
        from: from.toISOString(),
        to: to.toISOString(),
      });
      console.info(`  ${granularity}: ${result.buckets} buckets`);
    }
  } else {
    console.info('');
    console.info('  Rollups are built by the worker. Start it with `npm run dev`,');
    console.info('  or rerun with `npm run seed -- --rollup` to compute them now.');
  }

  console.info('');
  console.info('  Sign in with:');
  console.info(`    email:    ${DEMO_EMAIL}`);
  console.info(`    password: ${DEMO_PASSWORD}`);
  console.info('');
  console.info('  Ingest key (shown once, as it would be in the UI):');
  console.info(`    ${generated.secret}`);
  console.info('');

  await disconnectDb();
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
