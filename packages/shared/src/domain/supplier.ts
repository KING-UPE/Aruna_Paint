import { D, Decimal, money, type DecimalLike } from '../decimal';

/**
 * Balance = Opening + Purchases − Payments − Purchase returns ± Adjustments.
 * A positive balance means the shop owes the supplier.
 */
export function supplierBalance(input: {
  opening: DecimalLike;
  purchases: DecimalLike;
  payments: DecimalLike;
  returns: DecimalLike;
  adjustments: DecimalLike;
}): Decimal {
  return money(
    D(input.opening)
      .plus(D(input.purchases))
      .minus(D(input.payments))
      .minus(D(input.returns))
      .plus(D(input.adjustments)),
  );
}

export interface OpenBill {
  id: string;
  date: string | Date;
  due: DecimalLike;
}

/** A payment settles the oldest bills first; anything over the balance is an advance. */
export function allocatePaymentOldestFirst(bills: OpenBill[], amount: DecimalLike) {
  const sorted = [...bills].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  let remaining = money(amount);
  const allocations: { billId: string; amount: Decimal }[] = [];
  for (const b of sorted) {
    if (!remaining.greaterThan(0)) break;
    const due = money(b.due);
    if (!due.greaterThan(0)) continue;
    const take = Decimal.min(due, remaining);
    allocations.push({ billId: b.id, amount: take });
    remaining = remaining.minus(take);
  }
  return { allocations, advance: money(remaining) };
}

/** Age buckets for supplier dues: 0–30, 31–60, 61–90, 90+ days. */
export function ageBucket(
  billDate: string | Date,
  asOf: string | Date = new Date(),
): '0-30' | '31-60' | '61-90' | '90+' {
  const days = Math.floor((new Date(asOf).getTime() - new Date(billDate).getTime()) / 86_400_000);
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}
