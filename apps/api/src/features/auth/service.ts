/**
 * Auth mechanics: hashing, token minting, rotation, reuse detection.
 *
 * Route handlers stay thin and call into here. Keeping the crypto and the
 * rotation state machine in one module means there is exactly one place to audit
 * when someone asks "how does your session handling work".
 *
 * The scheme:
 *   - Access token: a short-lived (15m) signed JWT, returned in the response
 *     body and held in memory by the client. Never written to localStorage, so
 *     an XSS cannot read it out of storage at rest.
 *   - Refresh token: a 256-bit opaque random value in an httpOnly cookie. Not a
 *     JWT - it carries no claims, it is just a lookup key into the collection,
 *     which means it can be revoked server-side. JWTs cannot.
 */

import crypto from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import type { PublicUser } from '@usage/shared';
import { env } from '../../lib/env.js';
import { childLogger } from '../../lib/logger.js';
import { unauthorized, ErrorCode } from '../../lib/errors.js';
import { RefreshToken, User, type UserDoc } from '@usage/db';

const log = childLogger('auth');

/* -------------------------------------------------------------------------- */
/* Passwords                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Argon2id parameters. These are the OWASP-recommended baseline: 19 MiB of
 * memory, 2 iterations, 1 degree of parallelism. Memory cost is what makes
 * GPU cracking expensive, which is why it matters more than iteration count.
 */
const ARGON_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hash, plain);
  } catch {
    // A malformed hash in the database should read as "wrong password", not as a
    // 500 that tells the caller something unusual just happened.
    return false;
  }
}

/**
 * Burn roughly the same CPU as a real verify would, for logins against an email
 * that does not exist.
 *
 * Without this, "no such user" returns in ~1ms while a real user's wrong password
 * takes ~50ms, and that timing difference is a reliable oracle for enumerating
 * which email addresses have accounts.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZXg$8Z0Yw5nGJ0mCq3qXk1vX9F7VJ7z5lS0Q7wYh0aQ1bQo';

export async function burnTimingBudget(plain: string): Promise<void> {
  await argonVerify(DUMMY_HASH, plain).catch(() => false);
}

/* -------------------------------------------------------------------------- */
/* Access tokens                                                               */
/* -------------------------------------------------------------------------- */

export interface AccessTokenPayload {
  sub: string;
  email: string;
}

export function signAccessToken(user: { id: string; email: string }): string {
  return jwt.sign({ sub: user.id, email: user.email }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
    issuer: 'api-usage',
    audience: 'api-usage-dashboard-web',
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: 'api-usage',
      audience: 'api-usage-dashboard-web',
    });
    if (typeof decoded === 'string' || !decoded.sub) {
      throw unauthorized('Malformed token');
    }
    return { sub: String(decoded.sub), email: String(decoded['email'] ?? '') };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      // A distinct code so the client knows to try /auth/refresh rather than
      // bouncing the user straight to the login screen.
      throw unauthorized('Access token expired', ErrorCode.TOKEN_EXPIRED);
    }
    throw unauthorized('Invalid token');
  }
}

/** Seconds until the access token expires, for the client's refresh timer. */
export function accessTokenTtlSeconds(): number {
  const match = /^(\d+)([smhd])$/.exec(env.ACCESS_TOKEN_TTL);
  if (!match) return 900;
  const value = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return value * multiplier;
}

/* -------------------------------------------------------------------------- */
/* Refresh tokens                                                              */
/* -------------------------------------------------------------------------- */

const REFRESH_BYTES = 32; // 256 bits

function generateRefreshToken(): string {
  return crypto.randomBytes(REFRESH_BYTES).toString('base64url');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
}

export interface IssuedRefresh {
  token: string;
  expiresAt: Date;
}

/** Start a brand new token family. Called on signup and on password login. */
export async function issueRefreshToken(
  userId: Types.ObjectId | string,
  context: { userAgent?: string; ip?: string } = {},
): Promise<IssuedRefresh> {
  const token = generateRefreshToken();
  const expiresAt = refreshExpiry();

  await RefreshToken.create({
    userId,
    tokenHash: hashToken(token),
    familyId: crypto.randomUUID(),
    expiresAt,
    userAgent: context.userAgent?.slice(0, 500),
    ip: context.ip?.slice(0, 64),
  });

  return { token, expiresAt };
}

/**
 * Exchange a refresh token for a fresh pair, rotating it.
 *
 * The reuse branch is the security-critical part. Presenting a token that has
 * already been exchanged means two parties hold tokens from this family, and we
 * cannot tell which is legitimate - so we revoke every token in the family. The
 * real user gets signed out and has to log in again, which is the correct
 * outcome: an inconvenience for them, a dead end for the attacker.
 */
export async function rotateRefreshToken(
  presentedToken: string,
  context: { userAgent?: string; ip?: string } = {},
): Promise<{ user: UserDoc; refresh: IssuedRefresh }> {
  const tokenHash = hashToken(presentedToken);
  const existing = await RefreshToken.findOne({ tokenHash });

  if (!existing) {
    throw unauthorized('Session expired, please sign in again');
  }

  if (existing.revokedAt) {
    throw unauthorized('Session was revoked, please sign in again');
  }

  if (existing.usedAt) {
    // Reuse detected. Kill the family.
    await RefreshToken.updateMany(
      { familyId: existing.familyId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    log.warn(
      { userId: String(existing.userId), familyId: existing.familyId },
      'refresh token reuse detected - family revoked',
    );
    throw unauthorized(
      'This session was already used elsewhere. For your security, please sign in again.',
      ErrorCode.TOKEN_REUSED,
    );
  }

  if (existing.expiresAt.getTime() <= Date.now()) {
    throw unauthorized('Session expired, please sign in again');
  }

  const user = await User.findById(existing.userId);
  if (!user) {
    // Account deleted while the session was live.
    await RefreshToken.updateMany(
      { familyId: existing.familyId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    throw unauthorized('Session expired, please sign in again');
  }

  // Mint the replacement inside the same family.
  const token = generateRefreshToken();
  const expiresAt = refreshExpiry();
  const replacement = await RefreshToken.create({
    userId: existing.userId,
    tokenHash: hashToken(token),
    familyId: existing.familyId,
    expiresAt,
    userAgent: context.userAgent?.slice(0, 500),
    ip: context.ip?.slice(0, 64),
  });

  existing.usedAt = new Date();
  await existing.save();

  log.debug({ userId: String(user._id), replacedBy: String(replacement._id) }, 'refresh rotated');

  return { user, refresh: { token, expiresAt } };
}

/** Revoke the presented token's whole family. Used by logout. */
export async function revokeRefreshFamily(presentedToken: string): Promise<void> {
  const existing = await RefreshToken.findOne({ tokenHash: hashToken(presentedToken) });
  if (!existing) return;
  await RefreshToken.updateMany(
    { familyId: existing.familyId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

/** Revoke every session for a user. For "sign out everywhere". */
export async function revokeAllSessions(userId: Types.ObjectId | string): Promise<void> {
  await RefreshToken.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                               */
/* -------------------------------------------------------------------------- */

export function toPublicUser(user: UserDoc): PublicUser {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    createdAt: user.createdAt as Date,
  };
}
