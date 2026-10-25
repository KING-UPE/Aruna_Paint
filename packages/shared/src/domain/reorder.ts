import { D, Decimal, qty, type DecimalLike } from '../decimal';

/**
 * For an item at or below its reorder level:
 * suggested = average daily sales × (lead days + cover days) − stock − on order,
 * rounded up to whole packs and at least the reorder qty.
 */
export function suggestReorderQty(input: {
  avgDailySales: DecimalLike;
  leadDays: number;
  coverDays: number;
  stock: DecimalLike;
  onOrder: DecimalLike;
  reorderLevel: DecimalLike;
  reorderQty: DecimalLike;
  packSize?: number;
}): Decimal {
  const stock = D(input.stock);
  if (stock.greaterThan(D(input.reorderLevel))) return new Decimal(0);
  const need = D(input.avgDailySales)
    .times(input.leadDays + input.coverDays)
    .minus(stock)
    .minus(D(input.onOrder));
  let suggested = Decimal.max(need, D(input.reorderQty));
  const pack = Math.max(1, Math.trunc(input.packSize ?? 1));
  suggested = suggested.dividedBy(pack).ceil().times(pack);
  return qty(suggested);
}

export function daysOfStockLeft(stock: DecimalLike, avgDailySales: DecimalLike): Decimal | null {
  const avg = D(avgDailySales);
  if (!avg.greaterThan(0)) return null;
  return D(stock).dividedBy(avg).toDecimalPlaces(1);
}
