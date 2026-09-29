/**
 * Request validation, driven by the zod schemas in @usage/shared.
 *
 * The same schema object that types the React form validates the request here.
 * A handler downstream of this middleware can read `req.body` as the inferred
 * type with no casting and no defensive checks, because anything that reaches it
 * has already been parsed.
 *
 * Note that it *replaces* req.body with the parse result rather than merely
 * checking it. That matters: zod strips unknown keys, so a client cannot smuggle
 * an extra `role: "admin"` field through into a spread like
 * `new User({ ...req.body })`. Validating without reassigning leaves that hole
 * wide open, and it is a genuinely common way mass-assignment bugs happen.
 */

import type { RequestHandler } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { validationFailed } from '../lib/errors.js';

/** Flatten zod issues into { fieldName: message } for direct form display. */
function toFieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_root';
    // Keep the first message per field; later ones are usually less specific.
    fields[key] ??= issue.message;
  }
  return fields;
}

export function validateBody<T extends ZodTypeAny>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(validationFailed(toFieldErrors(result.error)));
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery<T extends ZodTypeAny>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(validationFailed(toFieldErrors(result.error)));
      return;
    }
    // Express 5 makes req.query a getter-only property, so assigning to it
    // throws. Stash the parsed value instead; handlers read res.locals.query.
    _res.locals['query'] = result.data;
    next();
  };
}

export function validateParams<T extends ZodTypeAny>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      next(validationFailed(toFieldErrors(result.error)));
      return;
    }
    _res.locals['params'] = result.data;
    next();
  };
}

/** Typed accessor for whatever validateQuery stashed. */
export function parsedQuery<T>(res: { locals: Record<string, unknown> }): T {
  return res.locals['query'] as T;
}
