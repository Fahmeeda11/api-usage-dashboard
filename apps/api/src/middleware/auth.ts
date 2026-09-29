/**
 * Bearer-token authentication.
 *
 * Attaches `req.userId` for downstream handlers. Note what it does NOT do: it
 * does not load the user from Mongo. The access token is signed and short-lived,
 * so its `sub` is trustworthy for the 15 minutes it lives, and skipping the
 * lookup saves a database round trip on literally every authenticated request.
 * Handlers that genuinely need the user document fetch it themselves.
 */

import type { RequestHandler } from 'express';
import { unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../features/auth/service.js';

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
    userEmail?: string;
  }
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    next(unauthorized('Not signed in'));
    return;
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    next(unauthorized('Not signed in'));
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.sub;
    req.userEmail = payload.email;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Read the authenticated user id, or throw.
 *
 * Handlers behind requireAuth know a user id is present, but TypeScript does
 * not - the declaration above has to make it optional, since the field is absent
 * on unauthenticated requests. This centralises that assertion so handlers are
 * not littered with non-null assertions that would silently become wrong if a
 * route were ever mounted without requireAuth.
 */
export function currentUserId(req: { userId?: string }): string {
  if (!req.userId) {
    throw unauthorized('Not signed in');
  }
  return req.userId;
}
