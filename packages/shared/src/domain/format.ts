import { D, type DecimalLike } from '../decimal';
import { SHOP_TIME_ZONE } from './numbering';

const moneyFmt = new Intl.NumberFormat('en-LK', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 1250 → "1,250.00". */
export function formatMoney(value: DecimalLike | null | undefined): string {
  return moneyFmt.format(
    D(value ?? 0)
      .toDecimalPlaces(2)
      .toNumber(),
  );
}

/** 1250 → "Rs 1,250.00". */
export function formatRs(value: DecimalLike | null | undefined): string {
  const v = D(value ?? 0);
  return v.isNegative() ? `−Rs ${formatMoney(v.abs())}` : `Rs ${formatMoney(v)}`;
}

/** Quantities without trailing zeros: 1.500 → "1.5". */
export function formatQty(value: DecimalLike | null | undefined): string {
  const s = D(value ?? 0).toFixed(3);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Dates as DD/MM/YYYY in the shop's time zone. */
export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T00:00:00+05:30`)
      : new Date(value);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: SHOP_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

/** 12- or 24-hour time, a setting. */
export function formatTime(value: Date | string, hour12 = false): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: SHOP_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  }).format(new Date(value));
}

export function formatDateTime(value: Date | string, hour12 = false): string {
  return `${formatDate(value)} ${formatTime(value, hour12)}`;
}
