import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatQty,
  groupSales,
  type DashboardRange,
} from '@aruna/shared';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Minus,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import {
  BarList,
  ChartCard,
  ColumnChart,
  LegendItem,
  SimpleTable,
  Sparkline,
  StatusBar,
  TrendChart,
  compactRs,
  rs,
} from '@/components/charts/charts';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/misc';
import { api, qs } from '@/lib/api';
import type { Page, ShiftSummary, StockListItem } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Totals {
  sales: string;
  bills: number;
  averageBill: string;
  returns: string;
  discount: string;
  profit?: string;
}

interface Dashboard {
  range: DashboardRange;
  today: string;
  monthStartDay: number;
  current: { start: string; end: string };
  previous: { start: string; end: string };
  totals: { current: Totals; previous: Totals };
  daily: {
    date: string;
    future: boolean;
    sales: string;
    bills: number;
    returns: string;
    previousSales: string | null;
    profit?: string;
  }[];
  hourly: { hour: number; sales: string; bills: number }[];
  weekdays: { day: number; days: number; average: string }[];
  topProducts: {
    id: string;
    code: string;
    name: string;
    sales: string;
    qty: string;
    unit: string;
  }[];
  categories: { name: string; sales: string }[];
  counters: { code: string; name: string; sales: string; bills: number }[];
  cashiers: { name: string; sales: string; bills: number }[];
  stock: { ok: number; low: number; out: number };
  supplierDues: { total: string; top: { id: string; name: string; balance: string }[] } | null;
}

interface SystemStatus {
  version: string;
  sync: { linked: boolean; pending: number };
  lastBackup: { at: string; kind: string; status: string } | null;
}

const RANGES: { id: DashboardRange; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'month', label: 'This month' },
  { id: '12m', label: '12 months' },
];
const COMPARED: Record<DashboardRange, string> = {
  today: 'yesterday',
  '7d': 'the 7 days before',
  '30d': 'the 30 days before',
  '90d': 'the 90 days before',
  month: 'last month',
  '12m': 'the 12 months before',
};
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RANGE_KEY = 'aruna.dashboard.range';

const dayLabel = (d: string) => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const dayTitle = (d: string) =>
  `${WEEKDAYS[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7]} ${dayLabel(d)}`;
const n = (v: string | number | null | undefined) => Number(v ?? 0);

function savedRange(): DashboardRange {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    if (RANGES.some((r) => r.id === v)) return v as DashboardRange;
  } catch {
    // Storage blocked: start on 30 days.
  }
  return '30d';
}

/**
 * The owner's view of the shop: sales over time against the period before, the busy hours and
 * days, what sells, stock health, supplier dues and the counters. One date range at the top
 * scopes every chart.
 */
export function DashboardPage() {
  const { can, me } = useAuth();
  const [range, setRange] = useState<DashboardRange>(savedRange);
  const [grouping, setGrouping] = useState<Partial<Record<DashboardRange, Grouping>>>({});
  const pickRange = (r: DashboardRange) => {
    setRange(r);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      // Not remembered; fine.
    }
  };
  const q = useQuery({
    queryKey: ['dashboard', range],
    queryFn: () => api.get<Dashboard>(`/api/dashboard${qs({ range })}`, { passive: true }),
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });
  const shifts = useQuery({
    queryKey: ['shifts-today'],
    queryFn: () => api.get<{ items: ShiftSummary[] }>('/api/shifts'),
    enabled: can('day_end.view'),
  });
  const system = useQuery({
    queryKey: ['system-status'],
    queryFn: () => api.get<SystemStatus>('/api/system/status', { passive: true }),
  });
  const alerts = useQuery({
    queryKey: ['alerts'],
    queryFn: () =>
      api.get<{
        items: { id: string; kind: string; message: string; createdAt: string; severity: string }[];
      }>('/api/alerts'),
  });
  const low = useQuery({
    queryKey: ['products', 'low'],
    queryFn: () =>
      api.get<Page<StockListItem>>(`/api/products${qs({ lowStock: true, pageSize: 6 })}`),
    enabled: can('stock.view', 'products.view'),
  });

  const d = q.data;
  const busy = q.isFetching && Boolean(d);
  const cur = d?.totals.current;
  const prev = d?.totals.previous;
  const daily = d?.daily ?? [];
  const pastDaily = daily.filter((x) => !x.future);
  const drawers = (shifts.data?.items ?? [])
    .filter((x) => x.status === 'OPEN')
    .reduce((a, x) => a + Number(x.expectedCash), 0);
  const nowHour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      hour12: false,
      timeZone: 'Asia/Colombo',
    }).format(new Date()),
  );
  const hour12 = me.settings.timeFormat === '12h';
  const hourLabel = (h: number) =>
    hour12 ? `${h % 12 || 12}${h < 12 ? 'a' : 'p'}` : String(h).padStart(2, '0');
  const hourTitle = (h: number) =>
    hour12
      ? `${h % 12 || 12}:00 ${h < 12 ? 'am' : 'pm'} – ${(h + 1) % 12 || 12}:00 ${h + 1 < 12 || h + 1 === 24 ? 'am' : 'pm'}`
      : `${String(h).padStart(2, '0')}:00 – ${String(h + 1).padStart(2, '0')}:00`;

  const catTotal = (d?.categories ?? []).reduce((s, c) => s + n(c.sales), 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Dashboard"
        description={
          d
            ? `${formatDate(d.current.start)}${d.current.start !== d.current.end ? ` to ${formatDate(d.current.end)}` : ''} · compared with ${COMPARED[range]}`
            : 'Loading…'
        }
      >
        <div
          role="radiogroup"
          aria-label="Date range"
          className="inline-flex gap-1 rounded-[12px] border border-border bg-surface-2 p-1"
          onKeyDown={(e) => {
            const i = RANGES.findIndex((r) => r.id === range);
            if (e.key === 'ArrowRight') pickRange(RANGES[Math.min(RANGES.length - 1, i + 1)]!.id);
            else if (e.key === 'ArrowLeft') pickRange(RANGES[Math.max(0, i - 1)]!.id);
            else return;
            e.preventDefault();
          }}
        >
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              role="radio"
              aria-checked={range === r.id}
              tabIndex={range === r.id ? 0 : -1}
              onClick={() => pickRange(r.id)}
              className={cn(
                'h-8 rounded-[8px] px-3 text-sm transition-colors',
                range === r.id
                  ? 'bg-surface font-medium text-text shadow-sm'
                  : 'text-muted hover:text-text',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </PageHeader>

      {/* Headline numbers, each with its trend and the change against the period before. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Sales"
          value={cur ? compactRs(n(cur.sales)) : '—'}
          full={cur ? rs(cur.sales) : undefined}
          now={n(cur?.sales)}
          before={n(prev?.sales)}
          trend={pastDaily.map((x) => n(x.sales))}
          hero
        />
        <StatTile
          label="Bills"
          value={cur ? String(cur.bills) : '—'}
          now={cur?.bills ?? 0}
          before={prev?.bills ?? 0}
          trend={pastDaily.map((x) => x.bills)}
        />
        <StatTile
          label="Average bill"
          value={cur ? rs(cur.averageBill) : '—'}
          now={n(cur?.averageBill)}
          before={n(prev?.averageBill)}
        />
        {cur?.profit !== undefined ? (
          <StatTile
            label="Gross profit"
            value={compactRs(n(cur.profit))}
            full={rs(cur.profit)}
            now={n(cur.profit)}
            before={n(prev?.profit)}
            trend={pastDaily.map((x) => n(x.profit))}
            note={
              n(cur.sales)
                ? `${Math.round((n(cur.profit) / n(cur.sales)) * 100)}% margin`
                : undefined
            }
          />
        ) : (
          <StatTile
            label="Discounts given"
            value={cur ? rs(cur.discount) : '—'}
            now={n(cur?.discount)}
            before={n(prev?.discount)}
            neutral
          />
        )}
        <StatTile
          label="Returns"
          value={cur ? rs(cur.returns) : '—'}
          now={n(cur?.returns)}
          before={n(prev?.returns)}
          upIsBad
        />
        {d?.supplierDues ? (
          <StatTile
            label="Supplier dues"
            value={compactRs(n(d.supplierDues.total))}
            full={rs(d.supplierDues.total)}
          />
        ) : (
          <StatTile label="Cash in drawers now" value={rs(drawers)} />
        )}
      </div>

      {d ? (
        <SalesCard
          d={d}
          range={range}
          busy={busy}
          grouping={grouping[range] ?? DEFAULT_GROUPING[range]}
          onGrouping={(g) => setGrouping((x) => ({ ...x, [range]: g }))}
          hourLabel={hourLabel}
          hourTitle={hourTitle}
          nowHour={nowHour}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {range === 'today' && cur?.profit === undefined ? null : cur?.profit !== undefined &&
          range !== 'today' ? (
          <ChartCard
            title="Gross profit by day"
            subtitle={`${rs(cur.profit)} · sales minus the cost of the goods`}
            busy={busy}
            table={
              <SimpleTable
                head={['Day', 'Sales', 'Gross profit']}
                rows={pastDaily.map((x) => [dayTitle(x.date), rs(x.sales), rs(x.profit ?? 0)])}
              />
            }
          >
            <TrendChart
              height={200}
              seriesLabel="Gross profit"
              points={daily.map((x) => ({
                label: dayLabel(x.date),
                title: dayTitle(x.date),
                value: x.future ? null : n(x.profit),
              }))}
            />
          </ChartCard>
        ) : null}
        {range !== 'today' ? (
          <ChartCard
            title="Returns by day"
            subtitle={cur ? `${rs(cur.returns)} refunded` : undefined}
            busy={busy}
            table={
              <SimpleTable
                head={['Day', 'Refunded']}
                rows={pastDaily
                  .filter((x) => n(x.returns) > 0)
                  .map((x) => [dayTitle(x.date), rs(x.returns)])}
              />
            }
          >
            <ColumnChart
              ariaLabel="Refunds by day"
              height={200}
              empty="No returns in this range."
              data={pastDaily.map((x) => ({
                label: dayLabel(x.date),
                title: dayTitle(x.date),
                value: n(x.returns),
                detail: 'refunded',
              }))}
            />
          </ChartCard>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Best-selling products"
          subtitle="By sales in the range"
          busy={busy}
          table={
            <SimpleTable
              head={['Product', 'Sold', 'Sales']}
              rows={(d?.topProducts ?? []).map((p) => [
                `${p.code} · ${p.name}`,
                `${formatQty(p.qty)} ${p.unit}`,
                rs(p.sales),
              ])}
            />
          }
        >
          <BarList
            empty="No sales in this range yet."
            items={(d?.topProducts ?? []).map((p) => ({
              key: p.id,
              label: p.name,
              value: n(p.sales),
              note: `${formatQty(p.qty)} ${p.unit}`,
            }))}
          />
        </ChartCard>
        <ChartCard
          title="Sales by category"
          subtitle="Share of the range's sales"
          busy={busy}
          table={
            <SimpleTable
              head={['Category', 'Share', 'Sales']}
              rows={(d?.categories ?? []).map((c) => [
                c.name,
                catTotal ? `${Math.round((n(c.sales) / catTotal) * 100)}%` : '—',
                rs(c.sales),
              ])}
            />
          }
        >
          <BarList
            empty="No sales in this range yet."
            items={(d?.categories ?? []).map((c) => ({
              key: c.name,
              label: c.name,
              value: n(c.sales),
              note: catTotal ? `${Math.round((n(c.sales) / catTotal) * 100)}%` : undefined,
            }))}
          />
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard
          title="Stock health"
          subtitle="Active products"
          table={
            <SimpleTable
              head={['State', 'Products']}
              rows={[
                ['In stock', d?.stock.ok ?? 0],
                ['Low (at or below the reorder level)', d?.stock.low ?? 0],
                ['Out of stock', d?.stock.out ?? 0],
              ]}
            />
          }
        >
          <StatusBar
            parts={[
              {
                key: 'ok',
                label: 'In stock',
                value: d?.stock.ok ?? 0,
                tone: 'ok',
                icon: <CheckCircle2 size={13} />,
              },
              {
                key: 'low',
                label: 'Low',
                value: d?.stock.low ?? 0,
                tone: 'warn',
                icon: <AlertTriangle size={13} />,
              },
              {
                key: 'out',
                label: 'Out',
                value: d?.stock.out ?? 0,
                tone: 'danger',
                icon: <XCircle size={13} />,
              },
            ]}
          />
          {(low.data?.items ?? []).length ? (
            <ul className="mt-4 flex flex-col gap-1.5 text-sm">
              {low.data!.items.map((p) => (
                <li key={p.id} className="flex justify-between gap-2">
                  <span className="truncate">
                    <span className="text-muted">{p.code}</span> {p.name}
                  </span>
                  <span className="shrink-0 font-medium">
                    {formatQty(p.stock)} {p.unit.name}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </ChartCard>
        {d?.supplierDues ? (
          <ChartCard
            title="Supplier dues"
            subtitle={`${rs(d.supplierDues.total)} owed in total`}
            table={
              <SimpleTable
                head={['Supplier', 'Owed']}
                rows={d.supplierDues.top.map((s) => [s.name, rs(s.balance)])}
              />
            }
          >
            <BarList
              empty="The shop owes no supplier."
              items={d.supplierDues.top.map((s) => ({
                key: s.id,
                label: s.name,
                value: n(s.balance),
              }))}
            />
          </ChartCard>
        ) : null}
        <ChartCard
          title="Sales by cashier"
          subtitle="Bills they completed in the range"
          busy={busy}
          table={
            <SimpleTable
              head={['Cashier', 'Bills', 'Sales']}
              rows={(d?.cashiers ?? []).map((c) => [c.name, c.bills, rs(c.sales)])}
            />
          }
        >
          <BarList
            empty="No sales in this range yet."
            items={(d?.cashiers ?? []).map((c) => ({
              key: c.name,
              label: c.name,
              value: n(c.sales),
              note: `${c.bills} bills`,
            }))}
          />
        </ChartCard>
        <ChartCard
          title="Counters"
          subtitle="Sales in the range; today's day shown beside each"
          busy={busy}
          table={
            <SimpleTable
              head={['Counter', 'Bills', 'Sales']}
              rows={(d?.counters ?? []).map((c) => [c.name, c.bills, rs(c.sales)])}
            />
          }
        >
          <BarList
            empty="No sales in this range yet."
            items={(d?.counters ?? []).map((c) => {
              const s = (shifts.data?.items ?? []).find((x) => x.counter.code === c.code);
              return {
                key: c.code,
                label: `${c.name}${s ? (s.status === 'OPEN' ? ' · open today' : ' · day end done') : ''}`,
                value: n(c.sales),
                note: `${c.bills} bills`,
              };
            })}
          />
        </ChartCard>
        <Card>
          <CardHeader>
            <CardTitle>Alerts</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-2 text-sm">
            {(alerts.data?.items ?? []).length === 0 ? (
              <p className="text-muted">No alerts.</p>
            ) : null}
            {(alerts.data?.items ?? []).map((a) => (
              <div key={a.id}>
                <Badge tone={a.severity === 'error' ? 'danger' : 'warn'}>
                  {a.kind.replace(/_/g, ' ').toLowerCase()}
                </Badge>{' '}
                {a.message}
                <div className="text-xs text-muted">{formatDateTime(a.createdAt)}</div>
              </div>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>System</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-1 text-sm">
            <div>Version {system.data?.version}</div>
            <div>
              Sync: {system.data?.sync.linked ? 'linked' : 'cloud not linked yet'} ·{' '}
              {system.data?.sync.pending ?? 0} changes waiting
            </div>
            <div>
              Last backup:{' '}
              {system.data?.lastBackup ? (
                <>
                  {formatDateTime(system.data.lastBackup.at)} (
                  {system.data.lastBackup.kind.toLowerCase()}){' '}
                  <Badge tone={system.data.lastBackup.status === 'OK' ? 'ok' : 'danger'}>
                    {system.data.lastBackup.status}
                  </Badge>
                </>
              ) : (
                'none yet'
              )}
            </div>
            {can('day_end.view') ? (
              <div>Cash in drawers now: Rs {formatMoney(String(drawers))}</div>
            ) : null}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

/** A headline number with its trend and the change against the period before. */
function StatTile({
  label,
  value,
  full,
  now,
  before,
  trend,
  note,
  hero,
  upIsBad,
  neutral,
}: {
  label: string;
  value: string;
  /** The exact amount, for the tooltip when the value is shortened. */
  full?: string;
  now?: number;
  before?: number;
  trend?: number[];
  note?: string;
  hero?: boolean;
  /** More is worse (returns). */
  upIsBad?: boolean;
  /** Up or down is neither good nor bad (discounts). */
  neutral?: boolean;
}) {
  const hasDelta = now !== undefined && before !== undefined;
  const pct = hasDelta && before! > 0 ? ((now! - before!) / before!) * 100 : null;
  const dir = !hasDelta ? 0 : now! > before! ? 1 : now! < before! ? -1 : 0;
  const good = neutral || dir === 0 ? null : dir > 0 !== Boolean(upIsBad);
  return (
    <Card className={cn('flex flex-col', hero && 'md:col-span-1')}>
      <div className="flex flex-1 flex-col gap-1 p-4">
        <div className="text-sm text-muted">{label}</div>
        <div
          className={cn('font-semibold tracking-tight', hero ? 'text-[28px] leading-9' : 'text-xl')}
          title={full}
        >
          {value}
        </div>
        {hasDelta ? (
          <div
            className={cn(
              'flex items-center gap-1 text-xs font-medium',
              good === null ? 'text-muted' : good ? 'text-ok' : 'text-danger',
            )}
          >
            {dir > 0 ? (
              <ArrowUpRight size={14} />
            ) : dir < 0 ? (
              <ArrowDownRight size={14} />
            ) : (
              <Minus size={14} />
            )}
            {pct === null
              ? before === 0 && now! > 0
                ? 'new this period'
                : 'no change'
              : `${pct > 0 ? '+' : ''}${Math.abs(pct) >= 100 ? pct.toFixed(0) : pct.toFixed(1)}%`}
            <span className="font-normal text-muted">vs before</span>
          </div>
        ) : note ? null : (
          <div className="text-xs text-muted">Now</div>
        )}
        {note ? <div className="text-xs text-muted">{note}</div> : null}
        {trend && trend.length > 1 ? (
          <div className="mt-auto pt-2">
            <Sparkline values={trend} />
          </div>
        ) : null}
      </div>
    </Card>
  );
}

type Grouping = 'hour' | 'day' | 'week' | 'month' | 'weekday';

const GROUPINGS: { id: Grouping; label: string }[] = [
  { id: 'hour', label: 'Hour' },
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'weekday', label: 'Weekday' },
];
/** Which groupings make sense for a range: a day has only hours; months need a long range. */
const AVAILABLE: Record<DashboardRange, Grouping[]> = {
  today: ['hour'],
  '7d': ['hour', 'day', 'weekday'],
  '30d': ['hour', 'day', 'week', 'weekday'],
  '90d': ['hour', 'day', 'week', 'weekday'],
  month: ['hour', 'day', 'week', 'weekday'],
  '12m': ['hour', 'day', 'week', 'month', 'weekday'],
};
const DEFAULT_GROUPING: Record<DashboardRange, Grouping> = {
  today: 'hour',
  '7d': 'day',
  '30d': 'day',
  '90d': 'week',
  month: 'day',
  '12m': 'month',
};

/** One sales chart: by hour, day, week, month or weekday, against the period before. */
function SalesCard({
  d,
  range,
  busy,
  grouping,
  onGrouping,
  hourLabel,
  hourTitle,
  nowHour,
}: {
  d: Dashboard;
  range: DashboardRange;
  busy: boolean;
  grouping: Grouping;
  onGrouping: (g: Grouping) => void;
  hourLabel: (h: number) => string;
  hourTitle: (h: number) => string;
  nowHour: number;
}) {
  const options = AVAILABLE[range];
  const by = options.includes(grouping) ? grouping : DEFAULT_GROUPING[range];
  const cur = d.totals.current;
  const subtitle = `${rs(cur.sales)} from ${cur.bills} bills`;
  const switcher =
    options.length > 1 ? (
      <div
        role="radiogroup"
        aria-label="Group sales by"
        className="inline-flex gap-0.5 rounded-[10px] border border-border bg-surface-2 p-0.5"
        onKeyDown={(e) => {
          const i = options.indexOf(by);
          if (e.key === 'ArrowRight') onGrouping(options[Math.min(options.length - 1, i + 1)]!);
          else if (e.key === 'ArrowLeft') onGrouping(options[Math.max(0, i - 1)]!);
          else return;
          e.preventDefault();
        }}
      >
        {GROUPINGS.filter((g) => options.includes(g.id)).map((g) => (
          <button
            key={g.id}
            type="button"
            role="radio"
            aria-checked={by === g.id}
            tabIndex={by === g.id ? 0 : -1}
            onClick={() => onGrouping(g.id)}
            className={cn(
              'h-7 rounded-[8px] px-2.5 text-xs transition-colors',
              by === g.id
                ? 'bg-surface font-medium text-text shadow-sm'
                : 'text-muted hover:text-text',
            )}
          >
            {g.label}
          </button>
        ))}
      </div>
    ) : null;

  if (by === 'hour' || by === 'weekday') {
    const hours = d.hourly;
    const weekdays = d.weekdays;
    const isHour = by === 'hour';
    const data = isHour
      ? hours.map((h) => ({
          label: hourLabel(h.hour),
          title: hourTitle(h.hour),
          value: n(h.sales),
          detail: `${h.bills} bills`,
        }))
      : weekdays.map((w) => ({
          label: WEEKDAYS[w.day - 1]!,
          title: `${WEEKDAYS[w.day - 1]} (${w.days} in range)`,
          value: n(w.average),
          detail: 'average a day',
        }));
    const best = data.reduce((b, x, i) => (x.value > (data[b]?.value ?? 0) ? i : b), 0);
    return (
      <ChartCard
        title={
          isHour
            ? range === 'today'
              ? 'Sales by hour today'
              : 'Sales by hour'
            : 'Sales by weekday'
        }
        subtitle={
          isHour
            ? `${subtitle}${range === 'today' ? '' : ' · every bill in the range, by its hour'}`
            : 'Average sales on each day of the week'
        }
        busy={busy}
        actions={switcher}
        table={
          isHour ? (
            <SimpleTable
              head={['Hour', 'Bills', 'Sales']}
              rows={hours.map((h) => [hourTitle(h.hour), h.bills, rs(h.sales)])}
            />
          ) : (
            <SimpleTable
              head={['Day', 'Days in range', 'Average sales']}
              rows={weekdays.map((w) => [WEEKDAYS[w.day - 1]!, w.days, rs(w.average)])}
            />
          )
        }
      >
        <ColumnChart
          ariaLabel={isHour ? 'Sales by hour' : 'Average sales by weekday'}
          height={260}
          empty="No sales in this range yet."
          highlight={
            isHour && range === 'today' && hours.some((h) => h.hour === nowHour && n(h.sales) > 0)
              ? hours.findIndex((h) => h.hour === nowHour)
              : best
          }
          data={data}
        />
      </ChartCard>
    );
  }

  // Day, week or month: the period as a line, the period before as a quiet dashed line.
  const current = groupSales(
    d.daily.map((x) => ({ date: x.date, value: x.future ? null : n(x.sales) })),
    by,
    d.monthStartDay,
  );
  let at = 0;
  const buckets = current.map((b) => {
    const from = d.daily.findIndex((x, i) => i >= at && x.date === b.start);
    const to = d.daily.findIndex((x, i) => i >= from && x.date === b.end);
    at = to + 1;
    const prev = d.daily
      .slice(from, to + 1)
      .reduce<
        number | null
      >((s, x) => (x.previousSales === null ? s : (s ?? 0) + n(x.previousSales)), null);
    const bills = d.daily.slice(from, to + 1).reduce((s, x) => s + x.bills, 0);
    return { ...b, previous: prev, bills };
  });
  const label = (b: (typeof buckets)[number]) => {
    if (by === 'day') return dayLabel(b.start);
    if (by === 'week') return dayLabel(b.start);
    const [y, m, day] = b.start.split('-').map(Number) as [number, number, number];
    const named = day >= d.monthStartDay || d.monthStartDay === 1 ? m : m === 1 ? 12 : m - 1;
    return `${MONTHS[named - 1]} ${String(named === 12 && m === 1 ? y - 1 : y).slice(2)}`;
  };
  // A week or month cut by the edge of the range says so, so a short one isn't misread.
  const full = (b: (typeof buckets)[number]) => {
    const days = Math.round((Date.parse(b.end) - Date.parse(b.start)) / 86_400_000) + 1;
    return by === 'week' ? days === 7 : days >= 28;
  };
  const title = (b: (typeof buckets)[number]) =>
    by === 'day'
      ? dayTitle(b.start)
      : `${dayTitle(b.start)} – ${dayTitle(b.end)}${full(b) ? '' : ` (part of the ${by})`}`;
  const unit = by === 'day' ? 'Day' : by === 'week' ? 'Week' : 'Month';
  return (
    <ChartCard
      title={`Sales by ${by}`}
      subtitle={subtitle}
      busy={busy}
      actions={switcher}
      legend={
        <div className="flex gap-4">
          <LegendItem label="This period" color="var(--accent)" />
          <LegendItem label={`Previous (${COMPARED[range]})`} color="var(--muted)" dashed />
        </div>
      }
      table={
        <SimpleTable
          head={[unit, 'Bills', 'Sales', 'Previous period']}
          rows={buckets
            .filter((b) => b.total !== null)
            .map((b) => [
              title(b),
              b.bills,
              rs(b.total ?? 0),
              b.previous === null ? '—' : rs(b.previous),
            ])}
        />
      }
    >
      <TrendChart
        height={260}
        seriesLabel="This period"
        previousLabel="Previous period"
        points={buckets.map((b) => ({
          label: label(b),
          title: title(b),
          value: b.total,
          previous: b.previous,
        }))}
      />
    </ChartCard>
  );
}
