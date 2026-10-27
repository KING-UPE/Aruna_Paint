import { describe, expect, it } from 'vitest';
import { monthPeriod, periodContaining, periodInstants } from '../src';

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
