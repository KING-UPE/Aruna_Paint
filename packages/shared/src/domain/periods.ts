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
