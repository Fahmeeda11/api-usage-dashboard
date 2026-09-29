/**
 * Server state for the dashboard.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  ApiKey,
  CreateApiKeyInput,
  CreatedApiKey,
  EventsResponse,
  Granularity,
  MetricsResponse,
  UsageEvent,
} from '@usage/shared';
import { apiRequest } from '../../lib/api.js';

export interface EventFilters {
  project?: string | undefined;
  model?: string | undefined;
  status?: string | undefined;
}

export const dashboardKeys = {
  metrics: (params: Record<string, unknown>) => ['metrics', params] as const,
  dimensions: ['metrics', 'dimensions'] as const,
  events: (filters: EventFilters) => ['events', filters] as const,
  apiKeys: ['keys'] as const,
};

export interface MetricsParams {
  from: Date;
  to: Date;
  granularity: Granularity;
  project?: string | undefined;
  model?: string | undefined;
}

export function useMetrics(params: MetricsParams) {
  const query = new URLSearchParams({
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    granularity: params.granularity,
  });
  if (params.project) query.set('project', params.project);
  if (params.model) query.set('model', params.model);

  const serialised = query.toString();

  return useQuery({
    queryKey: dashboardKeys.metrics({ q: serialised }),
    queryFn: () => apiRequest<MetricsResponse>(`/metrics?${serialised}`),
    // Matches the server-side cache window. Shorter would mean refetching
    // responses the server is going to serve from cache anyway.
    staleTime: 30_000,
    // Keep the previous range on screen while a new one loads, so changing the
    // time filter does not blank the whole dashboard and shift the layout.
    placeholderData: (previous) => previous,
  });
}

export function useDimensions() {
  return useQuery({
    queryKey: dashboardKeys.dimensions,
    queryFn: () => apiRequest<{ projects: string[]; models: string[] }>('/metrics/dimensions'),
    staleTime: 5 * 60_000,
  });
}

/* -------------------------------------------------------------------------- */

/**
 * The raw event feed, cursor-paginated.
 *
 * useInfiniteQuery pairs with the virtualized table: the table asks for more
 * rows when the viewport nears the end of what is loaded, rather than loading
 * thousands of rows nobody scrolls to.
 */
export function useEvents(filters: EventFilters) {
  return useInfiniteQuery({
    queryKey: dashboardKeys.events(filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: '100' });
      if (pageParam) query.set('cursor', pageParam);
      if (filters.project) query.set('project', filters.project);
      if (filters.model) query.set('model', filters.model);
      if (filters.status) query.set('status', filters.status);
      return apiRequest<EventsResponse>(`/events?${query.toString()}`);
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/* -------------------------------------------------------------------------- */

export function useApiKeys() {
  return useQuery({
    queryKey: dashboardKeys.apiKeys,
    queryFn: () => apiRequest<{ keys: ApiKey[] }>('/keys').then((r) => r.keys),
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateApiKeyInput) =>
      apiRequest<{ key: CreatedApiKey; warning: string }>('/keys', {
        method: 'POST',
        body: input,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: dashboardKeys.apiKeys }),
  });
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => apiRequest<void>(`/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: dashboardKeys.apiKeys }),
  });
}

/* -------------------------------------------------------------------------- */
/* Live tail                                                                   */
/* -------------------------------------------------------------------------- */

const MAX_TAIL_ROWS = 200;

/**
 * Subscribe to the SSE live tail.
 *
 * EventSource rather than fetch-with-a-reader: the browser handles reconnection
 * on its own, honouring the `retry:` interval the server sends. Hand-rolling
 * that over a streaming fetch means reimplementing backoff and connection-drop
 * detection for no benefit.
 *
 * EventSource cannot set request headers, so it cannot carry the bearer access
 * token. Rather than put a live credential in the query string, the client first
 * exchanges its token - over a normal authenticated request, where headers work
 * - for a single-use ticket that expires in a minute, and opens the stream with
 * that. See the /events/live-ticket route.
 */
export function useLiveTail(enabled: boolean) {
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const sourceRef = useRef<EventSource | null>(null);

  const clear = useCallback(() => setEvents([]), []);

  useEffect(() => {
    if (!enabled) {
      sourceRef.current?.close();
      sourceRef.current = null;
      setStatus('idle');
      return;
    }

    let cancelled = false;
    setStatus('connecting');

    void (async () => {
      let ticket: string;
      try {
        const result = await apiRequest<{ ticket: string }>('/events/live-ticket', {
          method: 'POST',
        });
        ticket = result.ticket;
      } catch {
        if (!cancelled) setStatus('error');
        return;
      }

      if (cancelled) return;

      const source = new EventSource(`/api/events/live?ticket=${encodeURIComponent(ticket)}`);
      sourceRef.current = source;

      source.addEventListener('connected', () => setStatus('live'));

      source.addEventListener('events', (event) => {
        try {
          const batch = JSON.parse((event as MessageEvent).data) as UsageEvent[];
          setEvents((current) => {
            // Newest first, and bounded: an unbounded buffer on a busy account
            // is a slow memory leak that ends with the tab being killed.
            const next = [...batch.reverse(), ...current];
            return next.slice(0, MAX_TAIL_ROWS);
          });
        } catch {
          // A malformed frame is not worth tearing the stream down for.
        }
      });

      source.onerror = () => {
        /**
         * A ticket is single-use, so EventSource's built-in reconnect would
         * retry with a spent one and fail forever. Close the stream and report
         * the state; the user can re-enable the tail, which mints a fresh
         * ticket. Honest, and better than a silent reconnect loop.
         */
        source.close();
        sourceRef.current = null;
        if (!cancelled) setStatus('error');
      };
    })();

    return () => {
      cancelled = true;
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [enabled]);

  return { events, status, clear };
}
