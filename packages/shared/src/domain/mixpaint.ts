import { D, Decimal, money, qty, type DecimalLike } from '../decimal';
import { DomainError } from '../errors';

/** Whole cans only: 1 can × 4 L = 4 L. */
export function cansToLiters(cans: DecimalLike, packSize: DecimalLike): Decimal {
  const c = D(cans);
  if (!c.isInteger() || !c.greaterThan(0)) {
    throw new DomainError('VALIDATION', 'Move whole cans only.', 'cans');
  }
  if (!D(packSize).greaterThan(0)) {
    throw new DomainError('VALIDATION', 'The product has no pack size in liters.', 'packSize');
  }
  return qty(c.times(D(packSize)));
}

/** A can's cost per liter from its actual price. */
export function costPerLiter(canActualPrice: DecimalLike, packSize: DecimalLike): Decimal {
  return money(D(canActualPrice).dividedBy(D(packSize)));
}

/** New average cost per liter = (old L × old cost + new L × new cost) ÷ total L. */
export function weightedAverageCost(input: {
  oldLiters: DecimalLike;
  oldCost: DecimalLike;
  addLiters: DecimalLike;
  addCost: DecimalLike;
}): Decimal {
  const oldL = Decimal.max(D(input.oldLiters), 0);
  const addL = D(input.addLiters);
  const total = oldL.plus(addL);
  if (!total.greaterThan(0)) return money(input.addCost);
  return money(
    oldL
      .times(D(input.oldCost))
      .plus(addL.times(D(input.addCost)))
      .dividedBy(total),
  );
}

/** The price per liter can be kept or changed, but never below the average cost. */
export function assertMixPrice(pricePerLiter: DecimalLike, averageCost: DecimalLike): void {
  if (money(pricePerLiter).lessThan(money(averageCost))) {
    throw new DomainError(
      'BELOW_COST',
      'The price per liter cannot be below the average cost.',
      'pricePerLiter',
    );
  }
}
