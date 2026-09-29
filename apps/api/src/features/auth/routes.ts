import { Router, type CookieOptions, type Response } from 'express';
import { loginSchema, signupSchema, type AuthResponse } from '@usage/shared';
import { validateBody } from '../../middleware/validate.js';
import { requireAuth, currentUserId } from '../../middleware/auth.js';
import { unauthorized, conflict, ErrorCode } from '../../lib/errors.js';
import { isProduction } from '../../lib/env.js';
import { User } from '@usage/db';
import {
  accessTokenTtlSeconds,
  burnTimingBudget,
  hashPassword,
  issueRefreshToken,
  revokeAllSessions,
  revokeRefreshFamily,
  rotateRefreshToken,
  signAccessToken,
  toPublicUser,
  verifyPassword,
  type IssuedRefresh,
} from './service.js';

export const REFRESH_COOKIE = 'usage_refresh';

/**
 * Cookie settings for the refresh token.
 *
 *   httpOnly  - JavaScript cannot read it, so an XSS cannot exfiltrate the
 *               long-lived credential even though it can call the API.
 *   sameSite  - 'lax' blocks the cookie on cross-site POSTs, which is what stops
 *               a CSRF against /auth/refresh. 'strict' would also work here but
 *               breaks the "click a link in an email into the app" flow.
 *   secure    - HTTPS only, outside development.
 *   path      - scoped to /auth, so it is not attached to every ordinary API
 *               call. Smaller blast radius, smaller requests.
 */
function refreshCookieOptions(expiresAt: Date): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/auth',
    expires: expiresAt,
  };
}

function setRefreshCookie(res: Response, refresh: IssuedRefresh): void {
  res.cookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions(refresh.expiresAt));
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(new Date(0)), expires: undefined });
}

function buildAuthResponse(user: Parameters<typeof toPublicUser>[0]): AuthResponse {
  const publicUser = toPublicUser(user);
  return {
    user: publicUser,
    accessToken: signAccessToken({ id: publicUser.id, email: publicUser.email }),
    expiresIn: accessTokenTtlSeconds(),
  };
}

export const authRouter = Router();

/* -------------------------------------------------------------------------- */

authRouter.post('/signup', validateBody(signupSchema), async (req, res) => {
  const { name, email, password } = req.body as typeof signupSchema._output;

  // The unique index is the real guard against a duplicate; this check only
  // exists to return a friendlier field-level error in the common case. The
  // race between here and create() is handled by the 11000 branch in the error
  // middleware, which is why that branch is not dead code.
  const existing = await User.exists({ email });
  if (existing) {
    throw conflict('That email is already registered', ErrorCode.EMAIL_TAKEN);
  }

  const user = await User.create({ name, email, passwordHash: await hashPassword(password) });

  const refresh = await issueRefreshToken(user._id, {
    userAgent: req.get('user-agent'),
    ip: req.ip,
  });
  setRefreshCookie(res, refresh);

  res.status(201).json(buildAuthResponse(user));
});

/* -------------------------------------------------------------------------- */

authRouter.post('/login', validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body as typeof loginSchema._output;

  // passwordHash is `select: false` on the schema, so it must be asked for.
  const user = await User.findOne({ email }).select('+passwordHash');

  if (!user) {
    // Spend the same time we would have spent verifying, then fail. See
    // burnTimingBudget - without it, response time reveals which emails exist.
    await burnTimingBudget(password);
    throw unauthorized('Email or password is incorrect', ErrorCode.INVALID_CREDENTIALS);
  }

  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    // Identical message and status to the branch above: the client must not be
    // able to tell "no such account" from "wrong password".
    throw unauthorized('Email or password is incorrect', ErrorCode.INVALID_CREDENTIALS);
  }

  const refresh = await issueRefreshToken(user._id, {
    userAgent: req.get('user-agent'),
    ip: req.ip,
  });
  setRefreshCookie(res, refresh);

  res.json(buildAuthResponse(user));
});

/* -------------------------------------------------------------------------- */

/**
 * Exchange the refresh cookie for a new access token, rotating the refresh
 * token in the process. This is what keeps a user signed in across a page
 * reload: the access token lived only in memory and is gone, but the cookie
 * survives and can mint a new one.
 */
authRouter.post('/refresh', async (req, res) => {
  const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined;

  if (!presented) {
    throw unauthorized('Not signed in');
  }

  try {
    const { user, refresh } = await rotateRefreshToken(presented, {
      userAgent: req.get('user-agent'),
      ip: req.ip,
    });
    setRefreshCookie(res, refresh);
    res.json(buildAuthResponse(user));
  } catch (err) {
    // Whatever went wrong, the cookie the client holds is now worthless. Clear
    // it so the browser stops sending it and the client shows a login screen
    // instead of retrying a token that can never succeed.
    clearRefreshCookie(res);
    throw err;
  }
});

/* -------------------------------------------------------------------------- */

authRouter.post('/logout', async (req, res) => {
  const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (presented) {
    await revokeRefreshFamily(presented);
  }
  clearRefreshCookie(res);
  // 204 whether or not there was a session: logging out of nothing is a success.
  res.status(204).end();
});

/* -------------------------------------------------------------------------- */

/** Sign out of every device by revoking all of this user's token families. */
authRouter.post('/logout-all', requireAuth, async (req, res) => {
  await revokeAllSessions(currentUserId(req));
  clearRefreshCookie(res);
  res.status(204).end();
});

/* -------------------------------------------------------------------------- */

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await User.findById(currentUserId(req));
  if (!user) {
    throw unauthorized('Not signed in');
  }
  res.json({ user: toPublicUser(user) });
});
