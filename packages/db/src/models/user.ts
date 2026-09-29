import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/* -------------------------------------------------------------------------- */
/* User                                                                        */
/* -------------------------------------------------------------------------- */

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      // Uniqueness is enforced by the index below, not by a pre-save check.
      // A read-then-write check has a race between the read and the write;
      // the unique index is the only thing that actually holds under concurrency.
      maxlength: 320,
    },
    passwordHash: { type: String, required: true, select: false },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const User = model('User', userSchema);

/* -------------------------------------------------------------------------- */
/* Refresh token                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Refresh tokens, stored hashed, rotated on every use, grouped into families.
 *
 * Why hashed: this collection is a list of live credentials. If it leaks and the
 * tokens are plaintext, every session is hijackable. Hashed, the leak is inert.
 * (SHA-256 is right here, unlike for passwords - these are 256-bit random values,
 * so there is no dictionary to attack and no need for a slow KDF.)
 *
 * Why families: rotation alone does not tell you whether a token was stolen. If
 * an attacker copies a refresh token and uses it, both they and the real user now
 * hold tokens descended from the same original. The moment an *already-used*
 * token is presented again, we know one of the two is an impostor - but not
 * which - so we revoke the whole family and force a fresh login. That is the
 * standard OAuth refresh-token-rotation reuse detection, and it is the reason
 * this collection exists at all rather than just signing a long-lived JWT.
 */
const refreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** SHA-256 of the opaque token. The plaintext is only ever in the cookie. */
    tokenHash: { type: String, required: true },

    /** Shared by every token descended from one login. */
    familyId: { type: String, required: true, index: true },

    expiresAt: { type: Date, required: true },

    /** Set the moment this token is exchanged. A second exchange means reuse. */
    usedAt: { type: Date, default: null },

    /** Set when the family is killed, either by logout or by reuse detection. */
    revokedAt: { type: Date, default: null },

    /** Audit breadcrumbs - useful when a user asks why they were signed out. */
    userAgent: { type: String, maxlength: 500 },
    ip: { type: String, maxlength: 64 },
  },
  { timestamps: true },
);

refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });

/**
 * TTL index: Mongo deletes expired tokens on its own, roughly once a minute.
 * Without this the collection grows forever, since nothing else ever deletes a
 * row - rotation marks tokens used, it does not remove them (we need the used
 * ones around precisely so reuse can be detected).
 */
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RefreshTokenDoc = HydratedDocument<InferSchemaType<typeof refreshTokenSchema>>;
export const RefreshToken = model('RefreshToken', refreshTokenSchema);
