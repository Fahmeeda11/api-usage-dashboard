/**
 * The typed API client.
 *
 * Two jobs:
 *
 *   1. Hold the access token IN MEMORY. Not localStorage, not a cookie readable
 *      by script. An XSS can still call this module while the page is open, but
 *      it cannot read a token out of storage, and nothing survives a tab close.
 *      The long-lived credential is the httpOnly refresh cookie, which script
 *      cannot touch at all.
 *
 *   2. Transparently recover from an expired access token. A 401 with code
 *      TOKEN_EXPIRED triggers one refresh and one replay of the original
 *      request. Callers never see it, which is why no component in this app
 *      contains token-handling code.
 *
 * The single-flight refresh below is the part that is easy to get wrong.
 */

import { apiErrorSchema, type ApiError } from '@usage/shared';

/** Thrown for every non-2xx response. Carries the server's machine-readable code. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string> | undefined;

  constructor(status: number, body: ApiError['error']) {
    super(body.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body.code;
    this.fields = body.fields;
  }

  /** True when the error names specific form fields, for react-hook-form. */
  get isValidationError(): boolean {
    return Boolean(this.fields && Object.keys(this.fields).length > 0);
  }
}

/* -------------------------------------------------------------------------- */
/* Access token, held in memory only                                          */
/* -------------------------------------------------------------------------- */

let accessToken: string | null = null;

/** Called when the session ends for any reason, so the app can show a login screen. */
type SessionEndedHandler = () => void;
let onSessionEnded: SessionEndedHandler = () => {};

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setSessionEndedHandler(handler: SessionEndedHandler): void {
  onSessionEnded = handler;
}

/* -------------------------------------------------------------------------- */
/* Single-flight refresh                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The board fires several queries at once on load. When the access token has
 * expired, every one of them gets a 401 at roughly the same moment.
 *
 * Without this, each would call /auth/refresh independently. Because refresh
 * tokens ROTATE, the first call would spend the cookie and the rest would arrive
 * holding a token that is now used - which the server correctly interprets as
 * token reuse and responds to by revoking the whole family. The user gets
 * logged out, apparently at random, whenever two requests expire together.
 *
 * So: at most one refresh is ever in flight. Everyone else awaits the same
 * promise.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch('/auth/refresh', {
        method: 'POST',
        // Without this the browser will not send the refresh cookie.
        credentials: 'include',
      });

      if (!res.ok) return false;

      const data = (await res.json()) as { accessToken: string };
      accessToken = data.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      // Clear on the next microtask so concurrent callers all observe the same
      // settled promise before it is discarded.
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();

  return refreshInFlight;
}

/* -------------------------------------------------------------------------- */
/* Request                                                                     */
/* -------------------------------------------------------------------------- */

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Internal: prevents a refresh loop. */
  _isRetry?: boolean;
}

async function parseError(res: Response): Promise<ApiRequestError> {
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  const parsed = apiErrorSchema.safeParse(payload);
  if (parsed.success) {
    return new ApiRequestError(res.status, parsed.data.error);
  }

  // The server is contractually obliged to return apiErrorSchema, but a proxy
  // or gateway in front of it is not - a 502 from the platform is HTML. Produce
  // something the UI can still display rather than throwing while handling an error.
  return new ApiRequestError(res.status, {
    message: res.status >= 500 ? 'The server is having trouble. Try again shortly.' : res.statusText,
    code: 'INTERNAL',
  });
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, _isRetry = false } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'include',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });

  if (res.ok) {
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const error = await parseError(res);

  // Expired access token: refresh once and replay. _isRetry stops this
  // recursing if the replayed request also 401s.
  if (res.status === 401 && !_isRetry && error.code === 'TOKEN_EXPIRED') {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return apiRequest<T>(path, { ...options, _isRetry: true });
    }
  }

  // Any other 401 - or a failed refresh - means the session is genuinely over.
  if (res.status === 401) {
    accessToken = null;
    onSessionEnded();
  }

  throw error;
}

/* -------------------------------------------------------------------------- */
/* Auth endpoints                                                              */
/* -------------------------------------------------------------------------- */

/**
 * These bypass apiRequest because they target /auth directly (not /api) and
 * must not trigger the refresh-and-retry logic - refreshing in response to a
 * failed login would be nonsense.
 */
async function authRequest<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/auth${path}`, {
    method: 'POST',
    credentials: 'include',
    ...(body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });

  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const authApi = {
  signup: (input: { name: string; email: string; password: string }) =>
    authRequest<{ user: unknown; accessToken: string; expiresIn: number }>('/signup', input),

  login: (input: { email: string; password: string }) =>
    authRequest<{ user: unknown; accessToken: string; expiresIn: number }>('/login', input),

  logout: () => authRequest<void>('/logout'),

  /**
   * Attempt to restore a session on page load.
   *
   * The access token lived in memory and is gone after a reload, but the refresh
   * cookie survives - so this is what makes "refresh the page and stay logged
   * in" work without ever storing a token where script can read it.
   */
  restore: async (): Promise<{ user: unknown; accessToken: string } | null> => {
    try {
      const data = await authRequest<{ user: unknown; accessToken: string }>('/refresh');
      accessToken = data.accessToken;
      return data;
    } catch {
      return null;
    }
  },
};
