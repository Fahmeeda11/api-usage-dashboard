import { formatMicros, type MetricsSummary } from '@usage/shared';

/**
 * Headline numbers.
 *
 * These are deliberately NOT charts. Each of these is a single value with no
 * shape to read - spend, request count, error rate - and drawing a one-value
 * "chart" for them adds axes and gridlines that carry no information. A big
 * number with a label is the right form; the charts below show the shape.
 */

interface TileProps {
  label: string;
  value: string;
  hint?: string;
  /** Applied to the value, for the error tile only. */
  tone?: 'default' | 'critical' | 'good';
}

function Tile({ label, value, hint, tone = 'default' }: TileProps) {
  const toneClass =
    tone === 'critical'
      ? 'text-status-critical'
      : tone === 'good'
        ? 'text-status-good'
        : 'text-slate-900 dark:text-slate-100';

  return (
    <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className={`tabular mt-1.5 text-2xl font-semibold ${toneClass}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">{hint}</p>}
    </div>
  );
}

function compact(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
    n,
  );
}

export function StatTiles({ summary }: { summary: MetricsSummary }) {
  const errorRate = summary.requests === 0 ? 0 : (summary.errors / summary.requests) * 100;
  const totalTokens = summary.promptTokens + summary.completionTokens;

  /**
   * Cost per thousand tokens: the number that actually tells you whether a
   * model switch was worth it, which neither raw spend nor raw token count
   * does on its own.
   */
  const costPerKToken =
    totalTokens === 0 ? 0 : (summary.costMicros / totalTokens) * 1000;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Tile label="Spend" value={formatMicros(summary.costMicros)} />
      <Tile
        label="Requests"
        value={compact(summary.requests)}
        hint={`${compact(totalTokens)} tokens`}
      />
      <Tile
        label="Error rate"
        value={`${errorRate.toFixed(errorRate < 10 ? 1 : 0)}%`}
        hint={`${compact(summary.errors)} failed`}
        // Colour alone never carries the meaning - the number and its label are
        // both present and legible either way.
        tone={errorRate > 5 ? 'critical' : errorRate > 0 ? 'default' : 'good'}
      />
      <Tile
        label="Latency p95"
        value={`${compact(summary.latencyP95)} ms`}
        hint={`p50 ${compact(summary.latencyP50)} ms`}
      />
      <Tile label="Cost / 1K tokens" value={formatMicros(costPerKToken)} />
    </div>
  );
}
