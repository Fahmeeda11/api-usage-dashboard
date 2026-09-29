/**
 * The raw event feed.
 *
 * Virtualized with @tanstack/react-virtual: only the rows actually on screen
 * exist in the DOM. Without it, a few thousand events means a few thousand DOM
 * nodes, and scrolling becomes visibly janky somewhere around ten thousand -
 * which is minutes of traffic on a busy account.
 *
 * Virtualization also pairs with cursor pagination: the table asks for the next
 * page as the viewport nears the end of what is loaded, so "infinite scroll"
 * costs one request per screenful rather than one enormous initial fetch.
 */

import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { formatMicros, STATUS_LABELS, type EventStatus, type UsageEvent } from '@usage/shared';
import { useEvents, type EventFilters } from './queries.js';
import { Spinner } from '../../components/ui.js';

/** Fixed row height, which is what lets the virtualizer compute offsets without measuring. */
const ROW_HEIGHT = 40;

/** How close to the end before the next page is requested. */
const PREFETCH_ROWS = 20;

const STATUS_STYLE: Record<EventStatus, string> = {
  ok: 'text-slate-500 dark:text-slate-400',
  error: 'text-status-critical font-medium',
  timeout: 'text-status-warning font-medium',
  rate_limited: 'text-status-warning font-medium',
};

function formatTime(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function EventsTable({ filters }: { filters: EventFilters }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data, isPending, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useEvents(filters);

  // Flatten the pages into one list for the virtualizer.
  const rows: UsageEvent[] = data?.pages.flatMap((page) => page.events) ?? [];

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    // Render a few rows beyond the viewport so fast scrolling does not show blanks.
    overscan: 8,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const lastVisibleIndex = virtualRows[virtualRows.length - 1]?.index ?? 0;

  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && lastVisibleIndex >= rows.length - PREFETCH_ROWS) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, lastVisibleIndex, rows.length, fetchNextPage]);

  if (isPending) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="text-slate-400" />
      </div>
    );
  }

  if (error) {
    return (
      <p className="py-8 text-center text-sm text-status-critical">{error.message}</p>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm font-medium text-slate-700 dark:text-slate-300">No events yet</p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Create an API key and POST to <code className="font-mono">/v1/events</code> to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      {/*
        The header sits OUTSIDE the scroll container rather than as a sticky row
        inside it - a sticky row inside a virtualized list has to be excluded
        from the virtualizer's index maths, which is a reliable source of
        off-by-one bugs.
      */}
      <div
        className="grid gap-3 border-b border-slate-200 px-4 py-2 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400"
        style={{ gridTemplateColumns: '150px 1fr 1fr 90px 80px 90px' }}
      >
        <span>Time</span>
        <span>Project</span>
        <span>Model</span>
        <span className="text-right">Tokens</span>
        <span className="text-right">Latency</span>
        <span className="text-right">Cost</span>
      </div>

      <div ref={scrollRef} className="h-96 overflow-auto">
        {/* Spacer of the full virtual height, so the scrollbar is the real size. */}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualRows.map((virtualRow) => {
            const event = rows[virtualRow.index];
            if (!event) return null;

            return (
              <div
                key={event.id}
                className="absolute inset-x-0 grid items-center gap-3 border-b border-slate-100 px-4 text-xs hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40"
                style={{
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                  gridTemplateColumns: '150px 1fr 1fr 90px 80px 90px',
                }}
              >
                <span className="tabular text-slate-500 dark:text-slate-400">
                  {formatTime(event.occurredAt)}
                </span>
                <span className="truncate text-slate-700 dark:text-slate-300">{event.project}</span>
                <span className="truncate font-mono text-[11px] text-slate-600 dark:text-slate-400">
                  {event.model}
                </span>
                <span className="tabular text-right text-slate-600 dark:text-slate-400">
                  {(event.promptTokens + event.completionTokens).toLocaleString()}
                </span>
                <span className="tabular text-right text-slate-600 dark:text-slate-400">
                  {event.latencyMs}ms
                </span>
                <span className="tabular text-right font-medium text-slate-900 dark:text-slate-100">
                  {event.status === 'ok' ? (
                    formatMicros(event.costMicros)
                  ) : (
                    // Status is shown as a word, never as colour alone.
                    <span className={STATUS_STYLE[event.status]}>
                      {STATUS_LABELS[event.status]}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        <span>
          {rows.length.toLocaleString()} loaded
          {hasNextPage ? ' — scroll for more' : ''}
        </span>
        {isFetchingNextPage && <Spinner className="size-3" />}
      </div>
    </div>
  );
}
