/**
 * Application errors.
 *
 * Route handlers throw these; the error middleware in middleware/error.ts is the
 * single place that turns them into responses. No handler calls res.status(4xx)
 * directly - that habit scatters response shapes across the codebase and
 * guarantees the client eventually meets an error body it cannot parse.
 *
 * Every error carries a machine-readable `code` alongside the human message, so
 * the web client can branch on the code without string-matching prose.
 */

/** Error codes the client is allowed to depend on. */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_REUSED: 'TOKEN_REUSED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCodeValue;
  /** Field-level messages for form display, keyed by field name. */
  readonly fields: Record<string, string> | undefined;
  /** True for errors we raised deliberately; false for genuine bugs. */
  readonly expected = true;

  constructor(
    status: number,
    code: ErrorCodeValue,
    message: string,
    fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new AppError(400, ErrorCode.VALIDATION_FAILED, message, fields);

export const unauthorized = (message = 'Not signed in', code: ErrorCodeValue = ErrorCode.UNAUTHORIZED) =>
  new AppError(401, code, message);

export const forbidden = (message = 'Not allowed') => new AppError(403, ErrorCode.FORBIDDEN, message);

/**
 * Note the default message. Whether a record does not exist or merely belongs to
 * someone else, the client is told the same thing - otherwise the 403/404 split
 * becomes an oracle for enumerating other people's record ids.
 */
export const notFound = (message = 'Not found') => new AppError(404, ErrorCode.NOT_FOUND, message);

export const conflict = (message: string, code: ErrorCodeValue = ErrorCode.CONFLICT) =>
  new AppError(409, code, message);

export const validationFailed = (fields: Record<string, string>, message = 'Check the highlighted fields') =>
  new AppError(422, ErrorCode.VALIDATION_FAILED, message, fields);

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
