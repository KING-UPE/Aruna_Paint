import { D, Decimal, money, type DecimalLike } from '../decimal';

export type DiscountType = 'PERCENT' | 'AMOUNT';

/** A discount as typed: "50" is Rs 50 per unit, "5%" is 5 percent. */
export interface DiscountInput {
  type: DiscountType;
  value: string;
}

export const NO_DISCOUNT: DiscountInput = { type: 'AMOUNT', value: '0' };

/** Parses the billing/purchase discount box: "50" → Rs 50, "5%" → 5 %, "" → none. */
export function parseDiscountText(text: string): DiscountInput | null {
  const t = text.trim().replace(/,/g, '');
  if (t === '') return NO_DISCOUNT;
  const percent = /^(\d+(?:\.\d{1,2})?)\s*%$/.exec(t);
  if (percent?.[1]) return { type: 'PERCENT', value: percent[1] };
  const amount = /^(?:rs\.?\s*)?(\d+(?:\.\d{1,2})?)$/i.exec(t);
  if (amount?.[1]) return { type: 'AMOUNT', value: amount[1] };
  return null;
}

export function discountToText(input: DiscountInput): string {
  return input.type === 'PERCENT' ? `${D(input.value).toString()}%` : D(input.value).toString();
}

/** Rupees per unit for a discount applied to `base` (a percentage is a share of the base). */
export function discountPerUnit(base: DecimalLike, input: DiscountInput): Decimal {
  const v = D(input.value);
  if (input.type === 'PERCENT') return money(D(base).times(v).dividedBy(100));
  return money(v);
}
