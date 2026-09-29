/**
 * Session state.
 *
 * Deliberately NOT in TanStack Query: the current user is client state derived
 * from a token this module owns, not a server resource to cache and refetch.
 * Mixing the two means a background refetch can log you out mid-interaction.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PublicUser } from '@usage/shared';
import { authApi, setAccessToken, setSessionEndedHandler } from './api.js';

interface AuthContextValue {
  user: PublicUser | null;
  /** True until the initial restore attempt finishes. */
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();

  /** Drop every trace of the previous session. */
  const clearSession = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    // Without this, the next person to log in on this browser would briefly see
    // the previous user's board from the cache. Rare, but a genuine data leak.
    queryClient.clear();
  }, [queryClient]);

  /**
   * Restore the session on mount.
   *
   * The access token lived only in memory and is gone after a reload, but the
   * httpOnly refresh cookie survived - so this exchange is exactly what makes
   * "hard refresh and stay logged in" work without ever putting a token
   * somewhere script can read it.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const restored = await authApi.restore();
      if (cancelled) return;
      if (restored) setUser(restored.user as PublicUser);
      setIsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The API client calls this when a request fails with an unrecoverable 401 -
   * an expired refresh token, or a family revoked by reuse detection. Without
   * it the user would sit on a board whose every request silently fails.
   */
  useEffect(() => {
    setSessionEndedHandler(() => clearSession());
    return () => setSessionEndedHandler(() => {});
  }, [clearSession]);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await authApi.login({ email, password });
      setAccessToken(result.accessToken);
      setUser(result.user as PublicUser);
    },
    [],
  );

  const signup = useCallback(async (name: string, email: string, password: string) => {
    const result = await authApi.signup({ name, email, password });
    setAccessToken(result.accessToken);
    setUser(result.user as PublicUser);
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      // Clear locally even if the request failed - the user asked to be logged
      // out, and leaving them apparently signed in because the network blipped
      // is the wrong answer, especially on a shared machine.
      clearSession();
    }
  }, [clearSession]);

  const value = useMemo(
    () => ({ user, isLoading, login, signup, logout }),
    [user, isLoading, login, signup, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside an AuthProvider');
  }
  return context;
}
