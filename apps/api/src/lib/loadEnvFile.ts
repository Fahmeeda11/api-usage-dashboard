/**
 * Load the repo-root .env into process.env, before anything reads it.
 *
 * Uses Node's built-in `process.loadEnvFile` (20.12+) rather than the `dotenv`
 * package - it is the same job with no dependency.
 *
 * Two deliberate behaviours:
 *
 *   1. SKIPPED IN PRODUCTION. On Render, Fly, or any container platform the
 *      real environment is injected by the platform and there is no .env file.
 *      Trying to load one there is at best a no-op and at worst loads a stale
 *      file someone accidentally baked into the image.
 *
 *   2. REAL ENV VARS WIN. Anything already set in the actual environment is
 *      preserved, so `PORT=5000 npm run dev` does what you expect and CI's
 *      variables are not silently overwritten by a developer's local file.
 *      `process.loadEnvFile` overwrites, so the existing values are snapshotted
 *      and restored afterwards.
 *
 * Walks up from this file looking for a .env, so it works the same whether it
 * is running from src/ via tsx or from dist/ after a build.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_LEVELS = 6;

function findEnvFile(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < MAX_LEVELS; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return null;
}

export function loadEnvFile(): string | null {
  if (process.env['NODE_ENV'] === 'production') return null;

  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = findEnvFile(here);
  if (!envPath) return null;

  // Snapshot what the real environment already provides, so the file cannot
  // clobber it.
  const preexisting = { ...process.env };

  try {
    process.loadEnvFile(envPath);
  } catch {
    // Malformed or unreadable .env - fall through to plain process.env and let
    // the schema produce a precise error about what is actually missing.
    return null;
  }

  for (const [key, value] of Object.entries(preexisting)) {
    if (value !== undefined) process.env[key] = value;
  }

  return envPath;
}
