import { formatMoney } from '@aruna/shared';
import { BarChart3, Table2 } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Card } from '@/components/ui/card';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';

/*
 * Small hand-drawn SVG charts, light enough for the shop's slow PCs. Every colour is a theme
 * token, so the Super Admin's colour theme and dark mode apply. Marks: thin bars (≤ 24 px) with
 * 4 px rounded data-ends, 2 px lines, hairline solid gridlines, a crosshair on lines and a
 * per-bar tooltip on bars (keyboard focus shows the same). Every chart has a table view.
 */

/** "Rs 12.5K", "Rs 1.2M" for axes and tight labels; full rupees stay in tooltips and tables. */
export function compactRs(value: number): string {
  const n = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (n >= 1_000_000) return `${sign}Rs ${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${sign}Rs ${trim(n / 1_000)}K`;
  return `${sign}Rs ${Math.round(n)}`;
}
const trim = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, ''));
export const rs = (v: string | number) => `Rs ${formatMoney(String(v))}`;

/** Clean axis steps: 0, 5K, 10K, 15K… */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(v);
  return out;
}

/**
 * The element's width, kept up to date. A callback ref, so it follows the element even when the
 * chart first shows an empty state and the real plot mounts later.
 */
function useWidth<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width, el] as const;
}

/** A rounded-top column path: square at the baseline, 4 px radius at the data end. */
function columnPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

interface TipRow {
  label: string;
  value: string;
  /** Line key colour; omitted for one-series charts. */
  color?: string;
  dashed?: boolean;
}

function Tooltip({
  x,
  y,
  title,
  rows,
  width,
}: {
  x: number;
  y: number;
  title: string;
  rows: TipRow[];
  width: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(140);
  useLayoutEffect(() => setW(ref.current?.offsetWidth ?? 140), [title, rows]);
  const left = Math.min(Math.max(8, x - w / 2), Math.max(8, width - w - 8));
  return (
    <div
      ref={ref}
      role="status"
      className="pointer-events-none absolute z-10 rounded-[10px] border border-border bg-surface px-3 py-2 text-sm shadow-lg"
      style={{ left, top: Math.max(0, y - 12), transform: 'translateY(-100%)' }}
    >
      <div className="mb-1 text-xs text-muted">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 whitespace-nowrap">
          {r.color ? (
            <svg width="14" height="4" aria-hidden>
              <line
                x1="1"
                x2="13"
                y1="2"
                y2="2"
                stroke={r.color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={r.dashed ? '3 3' : undefined}
              />
            </svg>
          ) : null}
          <span className="font-semibold text-text">{r.value}</span>
          <span className="text-muted">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/** A card with a title, an optional legend, and a chart ↔ table switch. */
export function ChartCard({
  title,
  subtitle,
  legend,
  table,
  children,
  className,
  busy,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  legend?: ReactNode;
  /** Controls beside the title, e.g. "By day · By week". */
  actions?: ReactNode;
  /** The same numbers as a table, for reading without the chart. */
  table: ReactNode;
  children: ReactNode;
  className?: string;
  /** Refetching: keep the last picture, a little faded. */
  busy?: boolean;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <Card className={cn('flex min-w-0 flex-col', className)}>
      <div className="flex items-start justify-between gap-3 px-5 pb-1 pt-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {actions}
          <IconButton
            label={asTable ? 'Show the chart' : 'Show as a table'}
            icon={asTable ? <BarChart3 size={16} /> : <Table2 size={16} />}
            onClick={() => setAsTable(!asTable)}
          />
        </div>
      </div>
      {legend && !asTable ? <div className="px-5 pb-1">{legend}</div> : null}
      <div className={cn('min-w-0 flex-1 px-5 pb-4 pt-2 transition-opacity', busy && 'opacity-60')}>
        {asTable ? <div className="max-h-80 overflow-auto">{table}</div> : children}
      </div>
    </Card>
  );
}

export function SimpleTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-surface text-left text-muted">
        <tr>
          {head.map((h, i) => (
            <th key={h} className={cn('py-1.5 font-medium', i > 0 && 'text-right')}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-border">
            {r.map((c, j) => (
              <td key={j} className={cn('py-1.5', j > 0 && 'num')}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LegendItem({
  label,
  color,
  kind = 'line',
  dashed,
}: {
  label: string;
  color: string;
  kind?: 'line' | 'box';
  dashed?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      {kind === 'line' ? (
        <svg width="16" height="6" aria-hidden>
          <line
            x1="1"
            x2="15"
            y1="3"
            y2="3"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={dashed ? '3 3' : undefined}
          />
        </svg>
      ) : (
        <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color }} />
      )}
      {label}
    </span>
  );
}

const AXIS = 'var(--muted)';
const GRID = 'var(--border)';
const ACCENT = 'var(--accent)';
/** The comparison series in the emphasis form: the same chart, in quiet grey. */
const PREVIOUS = 'color-mix(in srgb, var(--muted) 55%, transparent)';

function moveFocus(e: KeyboardEvent, index: number, count: number, set: (i: number) => void) {
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') set(Math.min(count - 1, index + 1));
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') set(Math.max(0, index - 1));
  else if (e.key === 'Home') set(0);
  else if (e.key === 'End') set(count - 1);
  else return;
  e.preventDefault();
}

export interface TrendPoint {
  label: string;
  /** Full label for the tooltip ("Tue 27 Oct"). */
  title: string;
  value: number | null;
  previous?: number | null;
}

/**
 * One series over time as a line with a soft area, plus the previous period as a quiet grey
 * line. A crosshair snaps to the nearest day and the tooltip lists both.
 */
export function TrendChart({
  points,
  height = 240,
  seriesLabel,
  previousLabel,
  format = rs,
}: {
  points: TrendPoint[];
  height?: number;
  seriesLabel: string;
  previousLabel?: string;
  format?: (v: number) => string;
}) {
  const [ref, width, el] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 52, r: 12, t: 12, b: 26 };
  const values = points.flatMap((p) => [p.value ?? 0, p.previous ?? 0]);
  const ticks = niceTicks(Math.max(...values, 0));
  const top = ticks.at(-1)!;
  const iw = Math.max(10, width - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const n = points.length;
  const xOf = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const yOf = (v: number) => pad.t + ih - (v / top) * ih;

  const path = (get: (p: TrendPoint) => number | null | undefined) => {
    let d = '';
    let pen = false;
    points.forEach((p, i) => {
      const v = get(p);
      if (v === null || v === undefined) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const lastIdx = points.reduce((last, p, i) => (p.value !== null ? i : last), -1);
  const line = path((p) => p.value);
  const area =
    lastIdx >= 0 && line
      ? `${line}L${xOf(lastIdx).toFixed(1)},${pad.t + ih}L${xOf(points.findIndex((p) => p.value !== null)).toFixed(1)},${pad.t + ih}Z`
      : '';
  const prevLine = previousLabel ? path((p) => p.previous) : '';
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 64))));

  const pick = (clientX: number) => {
    if (!el) return;
    const box = el.getBoundingClientRect();
    const x = clientX - box.left - pad.l;
    setHover(Math.max(0, Math.min(n - 1, Math.round(n <= 1 ? 0 : (x / iw) * (n - 1)))));
  };
  const hp = hover !== null ? points[hover] : null;

  return (
    <div
      ref={ref}
      className="relative w-full outline-none"
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-label={`${seriesLabel}. Use the arrow keys to read each day.`}
      onPointerMove={(e) => pick(e.clientX)}
      onPointerLeave={() => setHover(null)}
      onFocus={() => setHover((h) => h ?? Math.max(0, lastIdx))}
      onBlur={() => setHover(null)}
      onKeyDown={(e) => moveFocus(e, hover ?? lastIdx, n, setHover)}
    >
      {width > 0 ? (
        <svg width={width} height={height} className="block overflow-visible">
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={pad.l}
                x2={pad.l + iw}
                y1={yOf(t)}
                y2={yOf(t)}
                stroke={GRID}
                strokeWidth="1"
              />
              <text
                x={pad.l - 8}
                y={yOf(t)}
                dy="0.32em"
                textAnchor="end"
                fontSize="11"
                fill={AXIS}
                className="num"
              >
                {t === 0 ? '0' : compactRs(t).replace('Rs ', '')}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            (i % labelEvery === 0 && n - 1 - i >= labelEvery * 0.7) || i === n - 1 ? (
              <text
                key={i}
                x={xOf(i)}
                y={height - 6}
                textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
                fontSize="11"
                fill={AXIS}
              >
                {p.label}
              </text>
            ) : null,
          )}
          {prevLine ? (
            <path
              d={prevLine}
              fill="none"
              stroke={PREVIOUS}
              strokeWidth="2"
              strokeDasharray="4 4"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null}
          {area ? <path d={area} fill={ACCENT} opacity="0.1" /> : null}
          {line ? (
            <path
              d={line}
              fill="none"
              stroke={ACCENT}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null}
          {lastIdx >= 0 && hover === null ? (
            <circle
              cx={xOf(lastIdx)}
              cy={yOf(points[lastIdx]!.value!)}
              r="4"
              fill={ACCENT}
              stroke="var(--surface)"
              strokeWidth="2"
            />
          ) : null}
          {hp ? (
            <g>
              <line
                x1={xOf(hover!)}
                x2={xOf(hover!)}
                y1={pad.t}
                y2={pad.t + ih}
                stroke={AXIS}
                strokeWidth="1"
                opacity="0.5"
              />
              {hp.previous !== null && hp.previous !== undefined && previousLabel ? (
                <circle
                  cx={xOf(hover!)}
                  cy={yOf(hp.previous)}
                  r="4"
                  fill="var(--muted)"
                  stroke="var(--surface)"
                  strokeWidth="2"
                />
              ) : null}
              {hp.value !== null ? (
                <circle
                  cx={xOf(hover!)}
                  cy={yOf(hp.value)}
                  r="4.5"
                  fill={ACCENT}
                  stroke="var(--surface)"
                  strokeWidth="2"
                />
              ) : null}
            </g>
          ) : null}
        </svg>
      ) : null}
      {hp ? (
        <Tooltip
          x={xOf(hover!)}
          y={yOf(Math.max(hp.value ?? 0, hp.previous ?? 0))}
          width={width}
          title={hp.title}
          rows={[
            {
              label: seriesLabel,
              value: hp.value === null ? 'still to come' : format(hp.value),
              color: previousLabel ? ACCENT : undefined,
            },
            ...(previousLabel && hp.previous !== null && hp.previous !== undefined
              ? [
                  {
                    label: previousLabel,
                    value: format(hp.previous),
                    color: 'var(--muted)',
                    dashed: true,
                  },
                ]
              : []),
          ]}
        />
      ) : null}
    </div>
  );
}

export interface ColumnDatum {
  label: string;
  title: string;
  value: number;
  /** Extra tooltip line, e.g. "12 bills". */
  detail?: string;
}

/** Vertical columns from one baseline; the highlighted column (e.g. now, or the best) stands out. */
export function ColumnChart({
  data,
  height = 200,
  highlight,
  format = rs,
  ariaLabel,
  empty = 'Nothing in this range.',
}: {
  data: ColumnDatum[];
  height?: number;
  highlight?: number;
  format?: (v: number) => string;
  ariaLabel: string;
  /** Shown instead of an empty grid when every value is zero. */
  empty?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 4, t: 10, b: 24 };
  const ticks = niceTicks(Math.max(...data.map((d) => d.value), 0), 3);
  const top = ticks.at(-1)!;
  const iw = Math.max(10, width - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const band = iw / Math.max(1, data.length);
  const bw = Math.min(24, Math.max(4, band * 0.62));
  const yOf = (v: number) => pad.t + ih - (v / top) * ih;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 34))));
  const hd = hover !== null ? data[hover] : null;

  if (!data.some((d) => d.value > 0)) {
    return (
      <div className="grid place-items-center text-sm text-muted" style={{ height }}>
        {empty}
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className="relative w-full outline-none"
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-label={`${ariaLabel}. Use the arrow keys to read each column.`}
      onPointerLeave={() => setHover(null)}
      onBlur={() => setHover(null)}
      onFocus={() => setHover((h) => h ?? highlight ?? 0)}
      onKeyDown={(e) => moveFocus(e, hover ?? 0, data.length, setHover)}
    >
      {width > 0 ? (
        <svg width={width} height={height} className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={pad.l}
                x2={pad.l + iw}
                y1={yOf(t)}
                y2={yOf(t)}
                stroke={GRID}
                strokeWidth="1"
              />
              <text
                x={pad.l - 8}
                y={yOf(t)}
                dy="0.32em"
                textAnchor="end"
                fontSize="11"
                fill={AXIS}
                className="num"
              >
                {t === 0 ? '0' : compactRs(t).replace('Rs ', '')}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = pad.l + i * band + (band - bw) / 2;
            const y = yOf(d.value);
            const strong = highlight === undefined || highlight === i;
            return (
              <g key={i} onPointerEnter={() => setHover(i)}>
                <rect x={pad.l + i * band} y={pad.t} width={band} height={ih} fill="transparent" />
                <path
                  d={columnPath(x, y, bw, pad.t + ih - y)}
                  fill={ACCENT}
                  opacity={hover === i ? 0.85 : strong ? 1 : 0.38}
                />
                {i % labelEvery === 0 ? (
                  <text x={x + bw / 2} y={height - 6} textAnchor="middle" fontSize="11" fill={AXIS}>
                    {d.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      ) : null}
      {hd ? (
        <Tooltip
          x={pad.l + hover! * band + band / 2}
          y={yOf(hd.value)}
          width={width}
          title={hd.title}
          rows={[{ label: hd.detail ?? '', value: format(hd.value) }]}
        />
      ) : null}
    </div>
  );
}

export interface BarItem {
  key: string;
  label: string;
  value: number;
  /** Shown after the value, e.g. "36 cans · 41%". */
  note?: string;
}

/** A ranked horizontal bar list: name, a thin bar, the value at its end. */
export function BarList({
  items,
  format = rs,
  empty = 'Nothing yet.',
}: {
  items: BarItem[];
  format?: (v: number) => string;
  empty?: string;
}) {
  const max = Math.max(...items.map((i) => i.value), 0);
  if (!items.length || max <= 0)
    return <p className="py-6 text-center text-sm text-muted">{empty}</p>;
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((i) => (
        <li
          key={i.key}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1"
        >
          <span className="truncate text-sm" title={i.label}>
            {i.label}
          </span>
          <span className="text-right text-sm font-semibold">
            {format(i.value)}
            {i.note ? <span className="ml-1.5 font-normal text-muted">{i.note}</span> : null}
          </span>
          <span className="col-span-2 h-2 rounded-full bg-surface-2">
            <span
              className="block h-2 rounded-full bg-accent"
              style={{ width: `${Math.max(1.5, (i.value / max) * 100)}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A tiny trend line for a stat tile: the de-emphasised history, the latest point in the accent. */
export function Sparkline({ values, height = 32 }: { values: number[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const max = Math.max(...values, 0) || 1;
  const n = values.length;
  const pts = values.map(
    (v, i) =>
      [
        n <= 1 ? width / 2 : (i / (n - 1)) * (width - 6) + 3,
        height - 3 - (v / max) * (height - 6),
      ] as const,
  );
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const last = pts.at(-1);
  return (
    <div ref={ref} className="h-8 w-full" aria-hidden>
      {width > 0 && n > 1 ? (
        <svg width={width} height={height} className="block">
          <path
            d={d}
            fill="none"
            stroke="var(--muted)"
            strokeOpacity="0.6"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {last ? <circle cx={last[0]} cy={last[1]} r="3" fill={ACCENT} /> : null}
        </svg>
      ) : null}
    </div>
  );
}

/** Part-to-whole in one stacked bar with status colours; each part also has a label and count. */
export function StatusBar({
  parts,
}: {
  parts: {
    key: string;
    label: string;
    value: number;
    tone: 'ok' | 'warn' | 'danger';
    icon: ReactNode;
  }[];
}) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => setHover(null), [total]);
  const color = { ok: 'var(--ok)', warn: 'var(--warn)', danger: 'var(--danger)' } as const;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full bg-surface-2">
        {total > 0
          ? parts
              .filter((p) => p.value > 0)
              .map((p) => (
                <span
                  key={p.key}
                  title={`${p.label}: ${p.value}`}
                  onPointerEnter={() => setHover(p.key)}
                  onPointerLeave={() => setHover(null)}
                  className="h-full first:rounded-l-full last:rounded-r-full"
                  style={{
                    width: `${(p.value / total) * 100}%`,
                    background: color[p.tone],
                    opacity: hover && hover !== p.key ? 0.5 : 1,
                  }}
                />
              ))
          : null}
      </div>
      <ul className="grid grid-cols-3 gap-2">
        {parts.map((p) => (
          <li key={p.key} className="rounded-[10px] bg-surface-2/60 px-3 py-2">
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <span style={{ color: color[p.tone] }}>{p.icon}</span>
              {p.label}
            </div>
            <div className="mt-0.5 text-lg font-semibold">
              {p.value}
              <span className="ml-1 text-xs font-normal text-muted">
                {total ? `${Math.round((p.value / total) * 100)}%` : ''}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
