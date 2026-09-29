/**
 * Worker configuration.
 *
 * Separate from the API's env even though the two overlap, because the worker is
 * separately deployable and has a genuinely different surface: it needs
 * concurrency and schedule settings, and it has no use for JWT secrets or a web
 * origin. Anything a process does not need, it should not hold.
 */

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  MONGO_URI: z.string().min(1, 'is required'),
  REDIS_URL: z.string().min(1, 'is required'),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(100).default(4),

  /**
   * How far back each scheduled run recomputes.
   *
   * Not just the current bucket: events arrive late (a client that buffers, a
   * retry after a network blip), so a window that already looked complete can
   * gain rows. Recomputing a trailing window picks those up, and the upsert is
   * idempotent so redoing settled buckets costs work but changes nothing.
   */
  ROLLUP_HOUR_LOOKBACK_HOURS: z.coerce.number().int().positive().default(3),
  ROLLUP_DAY_LOOKBACK_DAYS: z.coerce.number().int().positive().default(2),
});

export type WorkerEnv = z.infer<typeof envSchema>;

function loadEnv(): WorkerEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    console.error(['', 'Invalid worker configuration:', ...lines, ''].join('\n'));
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
