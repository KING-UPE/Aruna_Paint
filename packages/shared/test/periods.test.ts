import { describe, expect, it } from 'vitest';
import { dashboardRanges, groupSales, monthPeriod, periodContaining, periodInstants } from '../src';

describe('month periods', () => {
  it('the 1st gives the calendar month', () => {
    expect(monthPeriod(2026, 2, 1)).toMatchObject({
      start: '2026-02-01',
      end: '2026-02-28',
      nextStart: '2026-03-01',
    });
  });
  it('the 25th runs to the 24th of next month, across the year end', () => {
    expect(monthPeriod(2026, 10, 25)).toMatchObject({ start: '2026-10-25', end: '2026-11-24' });
    expect(monthPeriod(2026, 12, 25)).toMatchObject({
      start: '2026-12-25',
      end: '2027-01-24',
      nextStart: '2027-01-25',
    });
  });
  it('finds the period containing a date in Sri Lanka time', () => {
    expect(periodContaining(new Date('2026-10-27T06:00:00Z'), 25)).toMatchObject({
      year: 2026,
      month: 10,
    });
    expect(periodContaining(new Date('2026-10-20T06:00:00Z'), 25)).toMatchObject({
      year: 2026,
      month: 9,
    });
    expect(periodContaining(new Date('2026-01-10T06:00:00Z'), 25)).toMatchObject({
      year: 2025,
      month: 12,
    });
    // 20:00 UTC on 24 Oct is already 25 Oct in Colombo.
    expect(periodContaining(new Date('2026-10-24T20:00:00Z'), 25)).toMatchObject({ month: 10 });
  });
  it('instants start at shop midnight', () => {
    const { from, to } = periodInstants(monthPeriod(2026, 10, 25));
    expect(from.toISOString()).toBe('2026-10-24T18:30:00.000Z');
    expect(to.toISOString()).toBe('2026-11-24T18:30:00.000Z');
  });
});

describe('dashboard ranges', () => {
  it('last 7 days ends today and is compared with the 7 days before', () => {
    const r = dashboardRanges('7d', '2026-10-27');
    expect(r.current).toMatchObject({ start: '2026-10-21', nextStart: '2026-10-28' });
    expect(r.current.days).toHaveLength(7);
    expect(r.previous).toMatchObject({ start: '2026-10-14', nextStart: '2026-10-21' });
  });

  it('today is compared with yesterday', () => {
    const r = dashboardRanges('today', '2026-03-01');
    expect(r.current.days).toEqual(['2026-03-01']);
    expect(r.previous.days).toEqual(['2026-02-28']);
  });

  it('this month follows the month start day and shows the whole month', () => {
    const r = dashboardRanges('month', '2026-10-27', 25);
    expect(r.current).toMatchObject({ start: '2026-10-25', nextStart: '2026-11-25' });
    expect(r.current.days).toHaveLength(31);
    expect(r.previous).toMatchObject({ start: '2026-09-25', nextStart: '2026-10-25' });
    // Before the start day it is still last month's period.
    expect(dashboardRanges('month', '2026-01-10', 25).current.start).toBe('2025-12-25');
  });
});

describe('dashboard 12 months', () => {
  it('is the last 365 days against the 365 before', () => {
    const r = dashboardRanges('12m', '2026-10-27');
    expect(r.current.days).toHaveLength(365);
    expect(r.current.start).toBe('2025-10-28');
    expect(r.previous.nextStart).toBe('2025-10-28');
  });
});

describe('sales grouping', () => {
  const days = (start: string, n: number, value: (i: number) => number | null) =>
    Array.from({ length: n }, (_, i) => {
      const d = new Date(`${start}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      return { date: d.toISOString().slice(0, 10), value: value(i) };
    });

  it('weeks run Monday to Sunday; a part week at the edge stays a part week', () => {
    // Thu 22 Oct 2026 for 10 days: Thu–Sun, then Mon 26 – Sat 31.
    const w = groupSales(
      days('2026-10-22', 10, () => 100),
      'week',
    );
    expect(w).toEqual([
      { start: '2026-10-22', end: '2026-10-25', total: 400 },
      { start: '2026-10-26', end: '2026-10-31', total: 600 },
    ]);
  });

  it('months follow the month start day, and days to come do not count', () => {
    const m = groupSales(
      days('2026-09-20', 40, (i) => (i < 30 ? 10 : null)),
      'month',
      25,
    );
    expect(m.map((b) => [b.start, b.end, b.total])).toEqual([
      ['2026-09-20', '2026-09-24', 50],
      ['2026-09-25', '2026-10-24', 250],
      ['2026-10-25', '2026-10-29', null],
    ]);
  });
});
