/**
 * API-key authentication, for machine callers.
 *
 * Distinct from requireAuth (middleware/auth.ts), which authenticates a browser
 * session with a short-lived JWT. A script has no browser, no cookie jar and
 * nobody to re-authenticate it, so it presents a long-lived secret instead.
 *
 * Keeping the two separate means revoking a key cannot log a person out, and
 * losing a session cannot break a background job.
 */

import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { ApiKey, hashApiKey } from '@usage/db';
import { API_KEY_PREFIX, type ApiKeyScope } from '@usage/shared';
import { unauthorized, forbidden, ErrorCode } from '../lib/errors.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger('api-key');

declare module 'express-serve-static-core' {
  interface Request {
    apiKeyId?: string;
    apiKeyUserId?: string;
    apiKeyScopes?: ApiKeyScope[];
  }
}

/**
 * How stale lastUsedAt may get before it is worth a write.
 *
 * Updating it on every request would double the write load of the busiest
 * endpoint in the system purely to maintain a timestamp nobody reads in real
 * time. Five minutes of staleness is invisible in the UI and removes ~99% of
 * those writes.
 */
const LAST_USED_REFRESH_MS = 5 * 60_000;

function extractKey(header: string | undefined): string | null {
  if (!header) return null;

  // Accept both "Bearer usg_..." and a bare "usg_...". Client libraries in the
  // wild do both, and rejecting one is a support burden with no security benefit.
  const value = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();

  return value.startsWith(API_KEY_PREFIX) ? value : null;
}

export function requireApiKey(scope: ApiKeyScope): RequestHandler {
  return async (req, _res, next) => {
    try {
      const presented = extractKey(req.headers.authorization) ?? extractKey(req.get('x-api-key'));

      if (!presented) {
        throw unauthorized('Provide an API key in the Authorization header');
      }

      // Look up by hash. The plaintext key is never stored, so a database dump
      // does not hand an attacker a set of working credentials.
      const key = await ApiKey.findOne({ hashedKey: hashApiKey(presented) });

      if (!key || key.revokedAt) {
        // Identical response for "no such key" and "revoked key" - telling them
        // apart would confirm that a revoked key once existed.
        throw unauthorized('Invalid API key', ErrorCode.INVALID_CREDENTIALS);
      }

      if (!key.scopes.includes(scope)) {
        throw forbidden(`This key does not have the "${scope}" scope`);
      }

      req.apiKeyId = String(key._id);
      req.apiKeyUserId = String(key.userId);
      req.apiKeyScopes = key.scopes as ApiKeyScope[];

      // Fire-and-forget, and only when meaningfully stale. Deliberately not
      // awaited: the caller should not wait on a bookkeeping write.
      const lastUsed = key.lastUsedAt?.getTime() ?? 0;
      if (Date.now() - lastUsed > LAST_USED_REFRESH_MS) {
        void ApiKey.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } }).catch((err) =>
          log.warn({ err }, 'could not update lastUsedAt'),
        );
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/** The authenticated key's owner. Throws if called outside requireApiKey. */
export function apiKeyUserId(req: { apiKeyUserId?: string }): Types.ObjectId {
  if (!req.apiKeyUserId) throw unauthorized('Invalid API key');
  return new Types.ObjectId(req.apiKeyUserId);
}

export function apiKeyId(req: { apiKeyId?: string }): Types.ObjectId {
  if (!req.apiKeyId) throw unauthorized('Invalid API key');
  return new Types.ObjectId(req.apiKeyId);
}
