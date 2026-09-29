import crypto from 'node:crypto';
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { API_KEY_PREFIX, API_KEY_DISPLAY_CHARS, API_KEY_SCOPES } from '@usage/shared';

/**
 * API keys: a SECOND authentication surface, separate from user sessions.
 *
 * This distinction is the thing most tutorials skip. The two have genuinely
 * different requirements:
 *
 *   User session              API key
 *   -----------               -------
 *   Short-lived, rotating     Long-lived, static
 *   Belongs to a browser      Belongs to a script
 *   Interactive re-auth       No human to re-authenticate
 *   Cookie + JWT              Bearer secret in a header
 *
 * Trying to serve a background job with a 15-minute rotating token means the job
 * needs a login flow, which it cannot have. Hence a separate credential type
 * with its own storage, its own middleware, and its own revocation.
 */
const apiKeySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    label: { type: String, required: true, trim: true, maxlength: 80 },

    /**
     * SHA-256 of the full secret. The plaintext is returned exactly once, at
     * creation, and is then unrecoverable.
     *
     * SHA-256 rather than argon2 is correct HERE, unlike for passwords: the
     * secret is 256 bits of CSPRNG output, so there is no dictionary to attack
     * and no need for a slow KDF. It is also verified on every ingest request,
     * where a deliberately-slow hash would be a self-inflicted rate limit.
     */
    hashedKey: { type: String, required: true },

    /** Leading characters, so a key is identifiable in a list without being usable. */
    prefix: { type: String, required: true },

    scopes: {
      type: [String],
      enum: API_KEY_SCOPES,
      required: true,
      default: ['ingest'],
    },

    /**
     * Updated opportunistically, not on every request - see the ingest route.
     * A write per request purely to update a timestamp would double the write
     * load of the hottest endpoint in the system.
     */
    lastUsedAt: { type: Date, default: null },

    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * The hot path: every ingest request looks a key up by its hash. Unique because
 * two keys hashing identically would be a catastrophic collision, and the index
 * is what makes the lookup a single index seek rather than a collection scan.
 */
apiKeySchema.index({ hashedKey: 1 }, { unique: true });

export type ApiKeyDoc = HydratedDocument<InferSchemaType<typeof apiKeySchema>>;
export const ApiKey = model('ApiKey', apiKeySchema);

/* -------------------------------------------------------------------------- */

export interface GeneratedKey {
  /** Shown to the user exactly once. */
  secret: string;
  hashedKey: string;
  prefix: string;
}

/**
 * Mint a new key.
 *
 * 32 bytes of CSPRNG output, base64url-encoded so it is safe in a header, a URL
 * and an environment variable without escaping.
 */
export function generateApiKey(): GeneratedKey {
  const random = crypto.randomBytes(32).toString('base64url');
  const secret = `${API_KEY_PREFIX}${random}`;

  return {
    secret,
    hashedKey: hashApiKey(secret),
    prefix: secret.slice(0, API_KEY_PREFIX.length + API_KEY_DISPLAY_CHARS),
  };
}

export function hashApiKey(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}
