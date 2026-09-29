/**
 * The single place an error becomes a response.
 *
 * Every error body in this API matches apiErrorSchema from @usage/shared,
 * including unexpected ones. The web client parses error bodies with that schema,
 * so a 500 that returned Express's default HTML error page would blow up the
 * client's error handler - turning a server bug into an unhandled client
 * exception and a blank screen.
 */

import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError, ErrorCode, isAppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { isProduction } from '../lib/env.js';

/** 404 for unmatched routes. Mounted after all real routes. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      message: `Cannot ${req.method} ${req.path}`,
      code: ErrorCode.NOT_FOUND,
    },
  });
};

/** Translate framework/driver errors into our AppError vocabulary. */
function normalise(err: unknown): AppError {
  if (isAppError(err)) return err;

  // Duplicate key. The only unique index a user can collide with is email.
  if (err instanceof mongoose.mongo.MongoServerError && err.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? 'field';
    if (field === 'email') {
      return new AppError(409, ErrorCode.EMAIL_TAKEN, 'That email is already registered', {
        email: 'That email is already registered',
      });
    }
    if (field === 'hashedKey') {
      // Astronomically unlikely (a 256-bit collision), but a 500 here would be
      // baffling, so name it.
      return new AppError(409, ErrorCode.CONFLICT, 'Key collision - please try again');
    }
    return new AppError(409, ErrorCode.CONFLICT, 'That value is already taken', {
      [field]: 'Already taken',
    });
  }

  // Malformed ObjectId in a path param, e.g. /applications/not-an-id.
  // A 404 is the honest answer: no such record could exist.
  if (err instanceof mongoose.Error.CastError) {
    return new AppError(404, ErrorCode.NOT_FOUND, 'Not found');
  }

  if (err instanceof mongoose.Error.ValidationError) {
    const fields: Record<string, string> = {};
    for (const [key, issue] of Object.entries(err.errors)) {
      fields[key] = issue.message;
    }
    return new AppError(422, ErrorCode.VALIDATION_FAILED, 'Check the highlighted fields', fields);
  }

  // A zod error escaping a service rather than the validate middleware.
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) {
      fields[issue.path.join('.') || '_root'] ??= issue.message;
    }
    return new AppError(422, ErrorCode.VALIDATION_FAILED, 'Check the highlighted fields', fields);
  }

  // JSON body that failed to parse.
  if (err instanceof SyntaxError && 'body' in err) {
    return new AppError(400, ErrorCode.VALIDATION_FAILED, 'Request body is not valid JSON');
  }

  return new AppError(500, ErrorCode.INTERNAL, 'Something went wrong');
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    // The response is already streaming; Express's default handler is the only
    // thing that can sensibly close it.
    next(err);
    return;
  }

  const appError = normalise(err);

  if (appError.status >= 500) {
    // Log the ORIGINAL error - `appError` is the sanitised stand-in and has lost
    // the stack trace that actually says where the bug is.
    logger.error(
      { err, method: req.method, path: req.path, userId: req.userId },
      'unhandled error',
    );
  } else {
    logger.debug(
      { code: appError.code, status: appError.status, method: req.method, path: req.path },
      appError.message,
    );
  }

  res.status(appError.status).json({
    error: {
      message: appError.message,
      code: appError.code,
      // The limiter already set the Retry-After header; echoing it into the body
      // means a fetch() caller can back off without reading headers.
      ...(appError.status === 429
        ? { retryAfter: Number(res.getHeader('Retry-After')) || 60 }
        : {}),
      ...(appError.fields ? { fields: appError.fields } : {}),
      // Stack traces only outside production. In production they would hand an
      // attacker file paths, dependency versions and internal structure.
      ...(isProduction || appError.status < 500
        ? {}
        : { stack: err instanceof Error ? err.stack : undefined }),
    },
  });
};
