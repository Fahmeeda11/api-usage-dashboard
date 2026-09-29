/**
 * Configuration, validated once at boot.
 *
 * The rule here: nothing else in the codebase reads process.env. Everything
 * imports `env` from this module and gets a fully-typed, already-validated
 * object. That buys two things:
 *
 *   1. The app refuses to start with a missing or malformed secret, loudly and
 *      with the variable named - instead of booting fine and throwing
 *      "secretOrPrivateKey must have a value" on the first login attempt.
 *   2. `env.PORT` is a number, not `string | undefined`, so no call site has to
 *      remember to parse or default it.
 *
 * Fail fast, at boot, in the one place that can explain what is wrong.
 */

import { z } from 'zod';
import { loadEnvFile } from './loadEnvFile.js';

// Must run BEFORE the schema below reads process.env.
const loadedFrom = loadEnvFile();

/** Minimum secret length. Short JWT secrets are brute-forceable offline. */
const SECRET_MIN = 32;

const secretSchema = z
  .string()
  .min(SECRET_MIN, `must be at least ${SECRET_MIN} characters`)
  .refine((v) => !v.startsWith('replace-me'), {
    message: 'still set to the placeholder from .env.example - generate a real secret',
  });

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),

    MONGO_URI: z.string().min(1, 'is required'),
    REDIS_URL: z.string().min(1, 'is required'),

    JWT_ACCESS_SECRET: secretSchema,
    JWT_REFRESH_SECRET: secretSchema,
    ACCESS_TOKEN_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

    WEB_ORIGIN: z.string().url().default('http://localhost:5173'),

    /**
     * Cap on ingest requests per API key per minute. Enforced by a Redis
     * sliding window - see middleware/rateLimit.ts.
     */
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

    /** Seconds a metrics response stays in the Redis cache. */
    METRICS_CACHE_TTL: z.coerce.number().int().nonnegative().default(60),
  })
  /**
   * Cross-field rules. Choosing a transport but not supplying its credentials is
   * a configuration error that would otherwise only surface when the first
   * reminder fires - in the worker, hours later, where nobody is watching.
   */
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV === 'production' && cfg.JWT_ACCESS_SECRET === cfg.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ - reusing one secret lets an ' +
          'access token be replayed as a refresh token',
        path: ['JWT_REFRESH_SECRET'],
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    // Deliberately console.error + exit rather than throw: a stack trace here is
    // noise, and this is the one message someone needs to read to fix their setup.
    console.error(
      ['', 'Invalid environment configuration:', ...lines, '', loadedFrom ? `Loaded from: ${loadedFrom}` : 'No .env file found - relying on the real environment.',
        'See .env.example for the full list.', ''].join(
        '\n',
      ),
    );
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
