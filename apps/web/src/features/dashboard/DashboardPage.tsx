import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  EVENT_STATUSES,
  RANGE_PRESETS,
  STATUS_LABELS,
  formatMicros,
  type Granularity,
} from '@usage/shared';
import { useAuth } from '../../lib/auth.js';
import { Button, ErrorBanner, Spinner } from '../../components/ui.js';
import { useDimensions, useLiveTail, useMetrics } from './queries.js';
import { StatTiles } from './StatTiles.js';
import { BreakdownBars, LatencyChart, SpendChart } from './Charts.js';
import { EventsTable } from './EventsTable.js';

export function DashboardPage() {
  const { user, logout } = useAuth();

  const [presetIndex, setPresetIndex] = useState(0);
  const [project, setProject] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [tailOpen, setTailOpen] = useState(false);

  const preset = RANGE_PRESETS[presetIndex] ?? RANGE_PRESETS[0];

  /**
   * Recomputed only when the preset changes, not on every render.
   *
   * Without the memo, `new Date()` produces a new value each render, which
   * changes the query key, which triggers a refetch, which re-renders - a
   * refetch loop that is invisible in development and obvious on the bill.
   */
  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - preset.hours * 3_600_000);
    return { from, to, granularity: preset.granularity as Granularity };
  }, [preset]);

  const { data: metrics, isPending, error } = useMetrics({
    ...range,
    project: project || undefined,
    model: model || undefined,
  });

  const { data: dimensions } = useDimensions();
  const tail = useLiveTail(tailOpen);

  const filters = {
    project: project || undefined,
    model: model || undefined,
    status: status || undefined,
  };

  return (
    <div className="min-h-dvh">
      <header className="flex items-center gap-4 border-b border-slate-200 px-6 py-3 dark:border-slate-800">
        <h1 className="text-lg font-semibold tracking-tight">API Usage</h1>
        <nav className="ml-4">
          <Link
            to="/keys"
            className="text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            API keys
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-sm text-slate-500 sm:inline dark:text-slate-400">
            {user?.name}
          </span>
          <Button variant="ghost" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="space-y-6 p-6">
        {/* Filters in one row above the charts, so the controls that change
            every chart are not scattered among them. */}
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800"
            role="group"
            aria-label="Time range"
          >
            {RANGE_PRESETS.map((option, index) => (
              <button
                key={option.label}
                type="button"
                onClick={() => setPresetIndex(index)}
                aria-pressed={index === presetIndex}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  index === presetIndex
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <FilterSelect
            label="Project"
            value={project}
            onChange={setProject}
            options={dimensions?.projects ?? []}
          />
          <FilterSelect
            label="Model"
            value={model}
            onChange={setModel}
            options={dimensions?.models ?? []}
          />
          <FilterSelect
            label="Status"
            value={status}
            onChange={setStatus}
            options={[...EVENT_STATUSES]}
            renderOption={(v) => STATUS_LABELS[v as keyof typeof STATUS_LABELS] ?? v}
          />

          <div className="ml-auto flex items-center gap-2">
            {metrics?.cached && (
              <span className="text-xs text-slate-400 dark:text-slate-600">cached</span>
            )}
            <Button
              variant={tailOpen ? 'primary' : 'secondary'}
              onClick={() => setTailOpen((open) => !open)}
            >
              {tailOpen ? `Live · ${tail.status}` : 'Live tail'}
            </Button>
          </div>
        </div>

        {error && <ErrorBanner message={error.message} />}

        {isPending || !metrics ? (
          <div className="flex h-64 items-center justify-center">
            <Spinner className="size-6 text-slate-400" />
          </div>
        ) : (
          <>
            <StatTiles summary={metrics.summary} />

            {/* Two charts, two y-axes - never one chart with two y-axes. */}
            <div className="grid gap-4 lg:grid-cols-2">
              <SpendChart data={metrics.timeseries} granularity={range.granularity} />
              <LatencyChart data={metrics.timeseries} granularity={range.granularity} />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <BreakdownBars title="Cost by model" rows={metrics.byModel} />
              <BreakdownBars title="Cost by project" rows={metrics.byProject} />
            </div>
          </>
        )}

        {tailOpen && <LiveTailPanel tail={tail} />}

        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
            Raw events
          </h2>
          <EventsTable filters={filters} />
        </section>
      </main>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function FilterSelect({
  label,
  value,
  onChange,
  options,
  renderOption,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  renderOption?: (value: string) => string;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border-0 bg-white py-1.5 pr-8 pl-2.5 text-xs ring-1 ring-slate-300 focus:ring-2 focus:ring-sky-500 dark:bg-slate-800 dark:ring-slate-700"
      >
        <option value="">All {label.toLowerCase()}s</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {renderOption ? renderOption(option) : option}
          </option>
        ))}
      </select>
    </label>
  );
}

/* -------------------------------------------------------------------------- */

function LiveTailPanel({ tail }: { tail: ReturnType<typeof useLiveTail> }) {
  return (
    <section className="rounded-xl bg-slate-900 p-4 ring-1 ring-slate-800 dark:bg-slate-950">
      <div className="mb-2 flex items-center gap-2">
        <span
          className={`size-2 rounded-full ${
            tail.status === 'live'
              ? 'bg-status-good'
              : tail.status === 'error'
                ? 'bg-status-critical'
                : 'bg-status-warning'
          }`}
          aria-hidden="true"
        />
        <h3 className="text-sm font-semibold text-slate-100">
          Live tail
          {/* The state is spelled out, not conveyed by the dot's colour alone. */}
          <span className="ml-2 font-normal text-slate-400">{tail.status}</span>
        </h3>
        <button
          type="button"
          onClick={tail.clear}
          className="ml-auto text-xs text-slate-400 hover:text-slate-200"
        >
          Clear
        </button>
      </div>

      <div className="h-48 overflow-auto font-mono text-[11px] leading-relaxed">
        {tail.events.length === 0 ? (
          <p className="py-6 text-center text-slate-500">
            Waiting for events. POST to /v1/events and they appear here without a refresh.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {tail.events.map((event) => (
              <li key={event.id} className="flex gap-3 text-slate-300">
                <span className="tabular shrink-0 text-slate-500">
                  {new Date(event.occurredAt).toLocaleTimeString()}
                </span>
                <span className="shrink-0 text-slate-400">{event.project}</span>
                <span className="truncate text-slate-300">{event.model}</span>
                <span className="tabular ml-auto shrink-0 text-slate-400">
                  {event.latencyMs}ms
                </span>
                <span className="tabular w-20 shrink-0 text-right text-slate-100">
                  {formatMicros(event.costMicros)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
