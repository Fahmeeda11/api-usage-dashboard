/**
 * Runs before any test module is imported.
 *
 * lib/env.ts validates process.env at import time and calls process.exit(1) if
 * anything is missing - which in a test run would kill the whole suite with no
 * useful output. So the environment has to be populated here, before the first
 * `import { createApp }` pulls env.ts in.
 *
 * These are throwaway values for an in-memory database. Nothing here is a real
 * secret, and nothing here is read outside tests.
 */

process.env['NODE_ENV'] = 'test';
// Never actually bound - supertest drives the app in-process - but it still has
// to satisfy the schema, and PORT=0 would not (the validator requires positive).
process.env['PORT'] = '4001';

// Overwritten per-suite by the in-memory server's URI; needs to be present and
// non-empty at import time so validation passes.
process.env['MONGO_URI'] ??= 'mongodb://127.0.0.1:27017/api-usage-dashboard-test';
process.env['REDIS_URL'] ??= 'redis://127.0.0.1:6380';

// Long enough to satisfy the 32-character minimum, and deliberately distinct so
// the "secrets must differ" production rule is exercised rather than sidestepped.
process.env['JWT_ACCESS_SECRET'] = 'test-access-secret-not-a-real-one-0123456789';
process.env['JWT_REFRESH_SECRET'] = 'test-refresh-secret-not-a-real-one-9876543210';

process.env['ACCESS_TOKEN_TTL'] = '15m';
process.env['REFRESH_TOKEN_TTL_DAYS'] = '30';
process.env['WEB_ORIGIN'] = 'http://localhost:5174';

// Small enough that a rate-limit test can actually reach it in a short burst.
process.env['RATE_LIMIT_MAX'] ??= '25';
process.env['RATE_LIMIT_WINDOW_MS'] ??= '60000';
