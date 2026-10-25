import DecimalJs from 'decimal.js';

/**
 * Money is Decimal(14,2) and quantities Decimal(14,3) — never floating point.
 * Every calculation in the app goes through this clone so rounding is always half-up.
 */
export const Decimal = DecimalJs.clone({
  precision: 40,
  rounding: DecimalJs.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});
export type Decimal = DecimalJs;

/** Anything that prints as a number: our Decimal, Prisma.Decimal, strings and numbers. */
export type DecimalLike = DecimalJs | string | number | { toString(): string };

export function D(value: DecimalLike | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  if (value instanceof Decimal) return value;
  return new Decimal(typeof value === 'object' ? value.toString() : value);
}

export const ZERO = new Decimal(0);

/** Round to 2 decimals, half-up. */
export function money(value: DecimalLike | null | undefined): Decimal {
  return D(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Round to 3 decimals, half-up. */
export function qty(value: DecimalLike | null | undefined): Decimal {
  return D(value).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
}

/** Canonical API string for money: "1250.00". */
export function moneyStr(value: DecimalLike | null | undefined): string {
  return money(value).toFixed(2);
}

/** Canonical API string for quantities: "1.500". */
export function qtyStr(value: DecimalLike | null | undefined): string {
  return qty(value).toFixed(3);
}

export function sum(values: Iterable<DecimalLike>): Decimal {
  let total = new Decimal(0);
  for (const v of values) total = total.plus(D(v));
  return total;
}

export function isWhole(value: DecimalLike): boolean {
  return D(value).isInteger();
}

export function decimalPlaces(value: DecimalLike): number {
  return D(value).decimalPlaces();
}

export function minDec(a: DecimalLike, b: DecimalLike): Decimal {
  return Decimal.min(D(a), D(b));
}

export function maxDec(a: DecimalLike, b: DecimalLike): Decimal {
  return Decimal.max(D(a), D(b));
}
