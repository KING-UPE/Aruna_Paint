import { shopDateParts } from './numbering';

/**
 * A business month that starts on a set day (the 1st by default, or e.g. the 25th). The month
 * is named after the month it starts in: with a start day of 25, "October 2026" runs from
 * 25 Oct to 24 Nov. Dates are calendar dates (YYYY-MM-DD) in the shop's time zone.
 */
export interface MonthPeriod {
  year: number;
  month: number;
  /** First day, inclusive. */
  start: string;
  /** Last day, inclusive. */
  end: string;
  /** First day of the next period (exclusive end). */
  nextStart: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

function ymd(year: number, month: number, day: number): string {
  // Normalise month overflow (month 13 → January next year).
  const d = new Date(Date.UTC(year, month - 1, day));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function clampStartDay(day: number): number {
  return Math.min(28, Math.max(1, Math.trunc(day || 1)));
}

export function monthPeriod(year: number, month: number, startDay = 1): MonthPeriod {
  const d = clampStartDay(startDay);
  const start = ymd(year, month, d);
  const nextStart = ymd(year, month + 1, d);
  const endDate = new Date(`${nextStart}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  return { year, month, start, end: endDate.toISOString().slice(0, 10), nextStart };
}

/** The period that contains a moment (today by default). */
export function periodContaining(at: Date = new Date(), startDay = 1): MonthPeriod {
  const p = shopDateParts(at);
  const y = Number(p.yyyy);
  const m = Number(p.mm);
  const day = Number(p.dd);
  return day >= clampStartDay(startDay)
    ? monthPeriod(y, m, startDay)
    : monthPeriod(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1, startDay);
}

/** Start and exclusive end as instants (shop midnight), for database ranges. */
export function periodInstants(p: MonthPeriod): { from: Date; to: Date } {
  return {
    from: new Date(`${p.start}T00:00:00+05:30`),
    to: new Date(`${p.nextStart}T00:00:00+05:30`),
  };
}

export const DASHBOARD_RANGES = ['today', '7d', '30d', '90d', 'month', '12m'] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

export interface DateRange {
  /** First day, inclusive (YYYY-MM-DD, shop time). */
  start: string;
  /** Day after the last day (exclusive). */
  nextStart: string;
  /** Every day in the range, in order. */
  days: string[];
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(start: string, nextStart: string): string[] {
  const out: string[] = [];
  for (let d = start; d < nextStart; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The dashboard's date range and the one it is compared with: the same number of days just
 * before ("last 7 days" against the 7 before them), or the previous business month for "This
 * month" (which follows the month start day). A month still running includes the days to come,
 * so the chart shows the whole month.
 */
export function dashboardRanges(
  range: DashboardRange,
  today: string,
  monthStartDay = 1,
): { current: DateRange; previous: DateRange } {
  if (range === 'month') {
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const start = clampStartDay(monthStartDay);
    const cur =
      d >= start
        ? monthPeriod(y, m, start)
        : monthPeriod(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1, start);
    const prev = monthPeriod(
      cur.month === 1 ? cur.year - 1 : cur.year,
      cur.month === 1 ? 12 : cur.month - 1,
      start,
    );
    return {
      current: {
        start: cur.start,
        nextStart: cur.nextStart,
        days: daysBetween(cur.start, cur.nextStart),
      },
      previous: {
        start: prev.start,
        nextStart: prev.nextStart,
        days: daysBetween(prev.start, prev.nextStart),
      },
    };
  }
  const n =
    range === 'today' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 365;
  const nextStart = addDays(today, 1);
  const start = addDays(nextStart, -n);
  const prevStart = addDays(start, -n);
  return {
    current: { start, nextStart, days: daysBetween(start, nextStart) },
    previous: { start: prevStart, nextStart: start, days: daysBetween(prevStart, start) },
  };
}

export type SalesGrouping = 'day' | 'week' | 'month';

export interface SalesBucket {
  /** First and last day of the bucket that fall inside the range. */
  start: string;
  end: string;
  /** Sum of the days that have happened; null when every day is still to come. */
  total: number | null;
}

/** The business month a calendar date falls in (by its first day). */
function monthStartOf(date: string, startDay: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const s = clampStartDay(startDay);
  return d >= s
    ? monthPeriod(y, m, s).start
    : monthPeriod(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1, s).start;
}

/** Monday of the week a date falls in. */
function weekStartOf(date: string): string {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

/**
 * Days added up into weeks (Monday to Sunday) or business months (from the month start day),
 * for the one sales chart. Days still to come count as nothing; a bucket of only such days is
 * null so the line stops at today.
 */
export function groupSales(
  days: { date: string; value: number | null }[],
  by: SalesGrouping,
  monthStartDay = 1,
): SalesBucket[] {
  if (by === 'day') return days.map((d) => ({ start: d.date, end: d.date, total: d.value }));
  const out: SalesBucket[] = [];
  let key = '';
  for (const d of days) {
    const k = by === 'week' ? weekStartOf(d.date) : monthStartOf(d.date, monthStartDay);
    if (k !== key) {
      out.push({ start: d.date, end: d.date, total: null });
      key = k;
    }
    const b = out[out.length - 1]!;
    b.end = d.date;
    if (d.value !== null) b.total = (b.total ?? 0) + d.value;
  }
  return out;
}
