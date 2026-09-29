/**
 * The dashboard's charts.
 *
 * Three rules worth stating, because they are the ones most commonly broken:
 *
 *   1. ONE Y-AXIS PER CHART. Spend and latency are different measures on
 *      different scales, so they get separate charts rather than a dual-axis
 *      plot. A second y-scale lets you draw any two lines crossing anywhere,
 *      which means the crossing carries no information - the reader infers a
 *      relationship that the chart's author chose arbitrarily.
 *   2. Colour follows the entity, never its rank. Model colours are assigned
 *      from a fixed slot order, so filtering the list does not repaint the
 *      survivors and "the blue one" stays the blue one.
 *   3. Identity is never colour-alone. Multi-series charts carry a legend AND
 *      direct labels; the breakdown bars carry their values in text.
 */

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  formatMicros,
  microsToUsd,
  type BreakdownRow,
  type Granularity,
  type TimeseriesPoint,
} from '@usage/shared';

/** Fixed slot order. Index into this by entity, never by sorted rank. */
const SERIES = [
  'var(--color-series-1)',
  'var(--color-series-2)',
  'var(--color-series-3)',
  'var(--color-series-4)',
  'var(--color-series-5)',
  'var(--color-series-6)',
  'var(--color-series-7)',
  'var(--color-series-8)',
];

const AXIS_STYLE = { fontSize: 11, fill: 'currentColor' } as const;
const GRID_COLOR = 'currentColor';

function formatBucket(value: string | number, granularity: Granularity): string {
  const date = new Date(value);
  return granularity === 'hour'
    ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', hour12: true }).format(date)
    : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

/** Shared tooltip shell, so every chart's hover layer looks and behaves the same. */
function TooltipBox({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; value: string; color?: string }[];
}) {
  return (
    <div className="rounded-lg bg-white px-3 py-2 text-xs shadow-lg ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
      <p className="font-medium text-slate-900 dark:text-slate-100">{title}</p>
      <div className="mt-1.5 space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2">
            {row.color && (
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: row.color }}
                aria-hidden="true"
              />
            )}
            {/* Text stays in ink colours; the swatch beside it carries identity. */}
            <span className="text-slate-500 dark:text-slate-400">{row.label}</span>
            <span className="tabular ml-auto font-medium text-slate-900 dark:text-slate-100">
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
        {subtitle && (
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
        )}
      </div>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

interface TimeseriesProps {
  data: TimeseriesPoint[];
  granularity: Granularity;
}

/**
 * Spend over time.
 *
 * One series, so no legend - the title names it. Area rather than line because
 * spend accumulates against a meaningful zero, and the filled region reads as
 * "how much", which is the question being asked.
 */
export function SpendChart({ data, granularity }: TimeseriesProps) {
  const chartData = data.map((point) => ({
    bucket: point.bucket,
    // Recharts needs a plain number; micro-dollars would make the axis unreadable.
    usd: microsToUsd(point.costMicros),
    requests: point.requests,
  }));

  return (
    <ChartCard title="Spend over time" subtitle="USD per bucket">
      <div className="h-56 text-slate-400 dark:text-slate-600">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="spendFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-series-1)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--color-series-1)" stopOpacity={0.02} />
              </linearGradient>
            </defs>

            {/* Horizontal only, and recessive: gridlines are a reading aid, not data. */}
            <CartesianGrid stroke={GRID_COLOR} strokeOpacity={0.18} vertical={false} />

            <XAxis
              dataKey="bucket"
              tickFormatter={(v) => formatBucket(v, granularity)}
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={false}
              minTickGap={24}
            />
            <YAxis
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(v: number) => (v === 0 ? '$0' : `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`)}
            />

            <Tooltip
              cursor={{ stroke: GRID_COLOR, strokeOpacity: 0.35, strokeWidth: 1 }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const point = payload[0]?.payload as { usd: number; requests: number };
                return (
                  <TooltipBox
                    title={new Date(label as string).toLocaleString()}
                    rows={[
                      {
                        label: 'Spend',
                        value: `$${point.usd.toFixed(4)}`,
                        color: 'var(--color-series-1)',
                      },
                      { label: 'Requests', value: point.requests.toLocaleString() },
                    ]}
                  />
                );
              }}
            />

            <Area
              type="monotone"
              dataKey="usd"
              stroke="var(--color-series-1)"
              strokeWidth={2}
              fill="url(#spendFill)"
              // No dot per point - a marker on every bucket is noise at this density.
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Latency percentiles.
 *
 * Its own chart rather than a second axis on the spend chart. Two series, so a
 * legend is present; both are labelled in the tooltip too, so identity never
 * rests on colour alone.
 */
export function LatencyChart({ data, granularity }: TimeseriesProps) {
  const chartData = data.map((point) => ({
    bucket: point.bucket,
    p50: point.latencyP50,
    p95: point.latencyP95,
  }));

  return (
    <ChartCard title="Latency" subtitle="Milliseconds. Percentiles are approximate across buckets.">
      <div className="h-56 text-slate-400 dark:text-slate-600">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID_COLOR} strokeOpacity={0.18} vertical={false} />

            <XAxis
              dataKey="bucket"
              tickFormatter={(v) => formatBucket(v, granularity)}
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={false}
              minTickGap={24}
            />
            <YAxis
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={(v: number) => `${v}`}
            />

            <Tooltip
              cursor={{ stroke: GRID_COLOR, strokeOpacity: 0.35, strokeWidth: 1 }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const point = payload[0]?.payload as { p50: number; p95: number };
                return (
                  <TooltipBox
                    title={new Date(label as string).toLocaleString()}
                    rows={[
                      { label: 'p95', value: `${point.p95} ms`, color: 'var(--color-series-2)' },
                      { label: 'p50', value: `${point.p50} ms`, color: 'var(--color-series-3)' },
                    ]}
                  />
                );
              }}
            />

            <Legend
              verticalAlign="top"
              align="right"
              height={24}
              iconType="plainline"
              wrapperStyle={{ fontSize: 11 }}
            />

            <Line
              name="p95"
              type="monotone"
              dataKey="p95"
              stroke="var(--color-series-2)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
            <Line
              name="p50"
              type="monotone"
              dataKey="p50"
              stroke="var(--color-series-3)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

/* -------------------------------------------------------------------------- */

interface BreakdownProps {
  title: string;
  subtitle?: string;
  rows: BreakdownRow[];
}

/**
 * Cost broken down by model or project.
 *
 * Horizontal bars, because the labels are long model names - rotated x-axis
 * labels on a vertical bar chart are a readability tax paid on every glance.
 *
 * Every bar carries its value as text. That is not decoration: three of the
 * light-mode palette hues sit below 3:1 contrast against the surface, and the
 * palette's relief rule requires visible labels or a table view wherever they
 * appear. The labels are the relief.
 */
export function BreakdownBars({ title, subtitle, rows }: BreakdownProps) {
  if (rows.length === 0) {
    return (
      <ChartCard title={title} subtitle={subtitle}>
        <p className="py-8 text-center text-xs text-slate-400 dark:text-slate-600">
          No data in this range
        </p>
      </ChartCard>
    );
  }

  const chartData = rows.map((row, index) => ({
    key: row.key,
    usd: microsToUsd(row.costMicros),
    requests: row.requests,
    errors: row.errors,
    // Slot assigned by position in the entity list, so a filter that removes a
    // row does not recolour the ones that remain.
    fill: SERIES[index % SERIES.length] as string,
  }));

  // Height grows with row count so bars keep a consistent thickness instead of
  // becoming either hairlines or slabs depending on how many models there are.
  const height = Math.max(140, chartData.length * 34 + 24);

  return (
    <ChartCard title={title} subtitle={subtitle}>
      <div style={{ height }} className="text-slate-400 dark:text-slate-600">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 0, right: 56, bottom: 0, left: 0 }}
            barCategoryGap={6}
          >
            <CartesianGrid stroke={GRID_COLOR} strokeOpacity={0.18} horizontal={false} />

            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="key"
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={false}
              width={132}
            />

            <Tooltip
              cursor={{ fill: GRID_COLOR, fillOpacity: 0.08 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0]?.payload as {
                  key: string;
                  usd: number;
                  requests: number;
                  errors: number;
                  fill: string;
                };
                return (
                  <TooltipBox
                    title={row.key}
                    rows={[
                      { label: 'Spend', value: `$${row.usd.toFixed(4)}`, color: row.fill },
                      { label: 'Requests', value: row.requests.toLocaleString() },
                      { label: 'Errors', value: row.errors.toLocaleString() },
                    ]}
                  />
                );
              }}
            />

            <Bar dataKey="usd" radius={[0, 4, 4, 0]} isAnimationActive={false}>
              {chartData.map((row) => (
                <Cell key={row.key} fill={row.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/*
        The value labels, rendered as text beside the chart rather than inside
        the SVG. Keeping them in the DOM means they are selectable, screen-
        reader accessible, and wear text tokens rather than the series colour.
      */}
      <ul className="mt-2 space-y-1 text-xs">
        {chartData.map((row) => (
          <li key={row.key} className="flex items-center gap-2">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: row.fill }}
              aria-hidden="true"
            />
            <span className="truncate text-slate-600 dark:text-slate-400">{row.key}</span>
            <span className="tabular ml-auto font-medium text-slate-900 dark:text-slate-100">
              {formatMicros(rows.find((r) => r.key === row.key)?.costMicros ?? 0)}
            </span>
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}
