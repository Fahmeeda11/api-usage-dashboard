import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  createApiKeySchema,
  objectIdSchema,
  type ApiKey as ApiKeyDTO,
  type CreatedApiKey,
} from '@usage/shared';
import { ApiKey, generateApiKey, type ApiKeyDoc } from '@usage/db';
import { validateBody } from '../../middleware/validate.js';
import { requireAuth, currentUserId } from '../../middleware/auth.js';
import { notFound } from '../../lib/errors.js';

export const keysRouter = Router();

// Managing keys is an interactive action, so it uses the SESSION auth, not key
// auth. A key must never be able to mint another key - that turns a single
// leaked credential into permanent, self-renewing access.
keysRouter.use(requireAuth);

const idParam = z.object({ id: objectIdSchema });

function toDTO(doc: ApiKeyDoc): ApiKeyDTO {
  return {
    id: String(doc._id),
    label: doc.label,
    prefix: doc.prefix,
    scopes: doc.scopes as ApiKeyDTO['scopes'],
    lastUsedAt: doc.lastUsedAt ?? null,
    revokedAt: doc.revokedAt ?? null,
    createdAt: doc.createdAt as Date,
  };
}

/* -------------------------------------------------------------------------- */

keysRouter.get('/', async (req, res) => {
  const keys = await ApiKey.find({ userId: new Types.ObjectId(currentUserId(req)) }).sort({
    createdAt: -1,
  });
  // Note what is absent: hashedKey. The secret cannot be listed, only used.
  res.json({ keys: keys.map(toDTO) });
});

/**
 * Create a key.
 *
 * This is the ONLY response that ever contains the secret. The database holds a
 * SHA-256 hash, so there is no endpoint - and no support process - that can
 * recover it later. Lose it and you rotate.
 *
 * That is a deliberate constraint, not an oversight: a system that can show you
 * your key again is a system where a database compromise hands over every key.
 */
keysRouter.post('/', validateBody(createApiKeySchema), async (req, res) => {
  const { label, scopes } = req.body as typeof createApiKeySchema._output;
  const generated = generateApiKey();

  const key = await ApiKey.create({
    userId: new Types.ObjectId(currentUserId(req)),
    label,
    scopes,
    hashedKey: generated.hashedKey,
    prefix: generated.prefix,
  });

  const response: CreatedApiKey = { ...toDTO(key), secret: generated.secret };

  res.status(201).json({
    key: response,
    warning: 'Copy this key now. It cannot be shown again.',
  });
});

/**
 * Revoke a key.
 *
 * Soft-revoked rather than deleted, so the usage events it wrote keep a valid
 * reference and the audit trail survives. Deleting the row would orphan every
 * event it ingested.
 */
keysRouter.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);

  const result = await ApiKey.updateOne(
    { _id: id, userId: new Types.ObjectId(currentUserId(req)), revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );

  if (result.matchedCount === 0) {
    // Same 404 whether it does not exist, belongs to someone else, or was
    // already revoked - none of those distinctions are the caller's business.
    throw notFound('API key not found');
  }

  res.status(204).end();
});
