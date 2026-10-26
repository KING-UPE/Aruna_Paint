import { D, Decimal, money, qty, type DecimalLike } from '../decimal';
import { DomainError } from '../errors';
import { discountPerUnit, type DiscountInput } from './discount';

// ---------------------------------------------------------------------------
// Qty box
// ---------------------------------------------------------------------------

export type ParsedQty =
  | { kind: 'UNITS'; qty: string }
  /** A loose sale in liters from the product's mix paint stock. */
  | { kind: 'LOOSE'; liters: string; display: string };

export interface ParseQtyOptions {
  /** The product can be sold loose from mix paint. */
  allowLoose: boolean;
  /** Liters per can, used to turn part of a can (0.375) into liters. */
  packSize?: DecimalLike | null;
  /** L and kg take decimals; pieces and cans are whole numbers. */
  unitAllowsDecimal: boolean;
}

/**
 * Reads the Qty box at the counter. Typing 1 sells one can, 1L sells one liter, and a decimal
 * such as 0.375 is part of a can (shown as "= 1.5 L"), so a cashier can't sell the wrong amount.
 */
export function parseQtyInput(text: string, opts: ParseQtyOptions): ParsedQty {
  const t = text.trim().toUpperCase().replace(/\s+/g, '');
  const liters = /^(\d+(?:\.\d+)?|\.\d+)L$/.exec(t);
  if (liters?.[1]) {
    const l = D(liters[1]);
    if (opts.unitAllowsDecimal && !opts.allowLoose) return unitsQty(l, true);
    if (!opts.allowLoose)
      throw new DomainError('VALIDATION', 'This item is not sold loose.', 'qty');
    return looseQty(l);
  }
  if (!/^(\d+(?:\.\d+)?|\.\d+)$/.test(t)) {
    throw new DomainError('VALIDATION', 'Type a quantity, for example 2 or 1.5L.', 'qty');
  }
  const n = D(t);
  if (n.isInteger()) return unitsQty(n, opts.unitAllowsDecimal);
  if (opts.unitAllowsDecimal) return unitsQty(n, true);
  if (opts.allowLoose && opts.packSize && D(opts.packSize).greaterThan(0)) {
    return looseQty(n.times(D(opts.packSize)));
  }
  throw new DomainError('VALIDATION', 'Pieces and cans are whole numbers.', 'qty');
}

function unitsQty(n: Decimal, allowDecimal: boolean): ParsedQty {
  if (!n.greaterThan(0)) throw new DomainError('VALIDATION', 'Qty must be more than 0.', 'qty');
  if (!allowDecimal && !n.isInteger()) {
    throw new DomainError('VALIDATION', 'Pieces and cans are whole numbers.', 'qty');
  }
  if (n.decimalPlaces() > 3) throw new DomainError('VALIDATION', 'Use up to 3 decimals.', 'qty');
  return { kind: 'UNITS', qty: n.toFixed(3) };
}

function looseQty(l: Decimal): ParsedQty {
  if (!l.greaterThan(0)) throw new DomainError('VALIDATION', 'Liters must be more than 0.', 'qty');
  const rounded = qty(l);
  return { kind: 'LOOSE', liters: rounded.toFixed(3), display: `${trimZeros(rounded)} L` };
}

export function trimZeros(value: DecimalLike): string {
  const s = D(value).toFixed(3);
  return s.replace(/\.?0+$/, '');
}

// ---------------------------------------------------------------------------
// Line pricing
// ---------------------------------------------------------------------------

/** The prices of one batch (sub-product) that billing needs. */
export interface BatchPricing {
  rPrice: DecimalLike;
  wPrice: DecimalLike;
  /** Cost per unit; no line sells below it. */
  cost: DecimalLike;
  /** Purchase discount per unit: the most a line can get. */
  purchaseDiscount: DecimalLike;
  /** Default discount filled in at billing. */
  salesDiscount: DecimalLike;
}

export interface LinePriceResult {
  /** The R-price, or the W-price on a wholesale bill. */
  unitPrice: Decimal;
  discountPerUnit: Decimal;
  netUnitPrice: Decimal;
}

/**
 * Applies the line discount rules: at most the batch's purchase discount, never below cost,
 * never above the R-price. Wholesale lines take the W-price with no extra discount.
 */
export function priceLine(
  batch: BatchPricing,
  opts: { wholesale: boolean; discount?: DiscountInput | null },
): LinePriceResult {
  if (opts.wholesale) {
    const w = money(batch.wPrice);
    return { unitPrice: w, discountPerUnit: new Decimal(0), netUnitPrice: w };
  }
  const rPrice = money(batch.rPrice);
  const disc = opts.discount ? discountPerUnit(rPrice, opts.discount) : money(batch.salesDiscount);
  if (disc.isNegative())
    throw new DomainError('VALIDATION', 'Discount must be 0 or more.', 'discount');
  const cap = money(batch.purchaseDiscount);
  if (disc.greaterThan(cap)) {
    const maxPct = rPrice.greaterThan(0)
      ? cap.dividedBy(rPrice).times(100).toDecimalPlaces(1).toString()
      : '0';
    throw new DomainError(
      'DISCOUNT_ABOVE_LIMIT',
      `The most this item can get is ${maxPct}% off (max Rs ${cap.toFixed(2)}).`,
      'discount',
      { max: cap.toFixed(2) },
    );
  }
  const net = money(rPrice.minus(disc));
  if (net.lessThan(money(batch.cost))) {
    throw new DomainError('BELOW_COST', 'This discount sells the item below cost.', 'discount');
  }
  return { unitPrice: rPrice, discountPerUnit: disc, netUnitPrice: net };
}

export interface SaleLineAmounts {
  gross: Decimal;
  discount: Decimal;
  amount: Decimal;
}

/** Per-line amounts; the discount is the gap so gross − discount always equals the amount. */
export function lineAmounts(
  unitPrice: DecimalLike,
  discountPerUnitValue: DecimalLike,
  q: DecimalLike,
): SaleLineAmounts {
  const gross = money(D(unitPrice).times(D(q)));
  const amount = money(D(unitPrice).minus(D(discountPerUnitValue)).times(D(q)));
  return { gross, discount: money(gross.minus(amount)), amount };
}

export interface SaleTotals {
  netItems: number;
  netQty: Decimal;
  gross: Decimal;
  discount: Decimal;
  netTotal: Decimal;
}

export function saleTotals(
  lines: { qty: DecimalLike; unitPrice: DecimalLike; discountPerUnit: DecimalLike }[],
): SaleTotals {
  let netQty = new Decimal(0);
  let gross = new Decimal(0);
  let amount = new Decimal(0);
  for (const l of lines) {
    const a = lineAmounts(l.unitPrice, l.discountPerUnit, l.qty);
    netQty = netQty.plus(D(l.qty));
    gross = gross.plus(a.gross);
    amount = amount.plus(a.amount);
  }
  return {
    netItems: lines.length,
    netQty: qty(netQty),
    gross: money(gross),
    discount: money(gross.minus(amount)),
    netTotal: money(amount),
  };
}

/** Cash only: an empty amount means exact cash; the cash given must cover the net total. */
export function computeChange(netTotal: DecimalLike, cashGiven: DecimalLike | null | undefined) {
  const net = money(netTotal);
  const given =
    cashGiven === null || cashGiven === undefined || cashGiven === '' ? net : money(cashGiven);
  if (given.lessThan(net)) {
    throw new DomainError('VALIDATION', `Cash given must cover Rs ${net.toFixed(2)}.`, 'cashGiven');
  }
  return { cashGiven: given, change: money(given.minus(net)) };
}

// ---------------------------------------------------------------------------
// Batches (multi-price pop-up and first-in, first-out)
// ---------------------------------------------------------------------------

export interface StockBatch {
  id: string;
  code: string;
  available: DecimalLike;
  /** Oldest stock sells first. */
  firstReceivedAt: string | Date;
  rPrice: DecimalLike;
  wPrice: DecimalLike;
  salesPrice: DecimalLike;
}

export function sortBatchesFifo<T extends StockBatch>(batches: T[]): T[] {
  return [...batches].sort((a, b) => {
    const ta = new Date(a.firstReceivedAt).getTime();
    const tb = new Date(b.firstReceivedAt).getTime();
    if (ta !== tb) return ta - tb;
    return a.code.localeCompare(b.code, undefined, { numeric: true });
  });
}

/** The pop-up opens only when two or more in-stock batches have different prices. */
export function needsPricePopup(batches: StockBatch[], wholesale: boolean): boolean {
  const inStock = batches.filter((b) => D(b.available).greaterThan(0));
  if (inStock.length < 2) return false;
  const keys = new Set(
    inStock.map((b) =>
      wholesale
        ? money(b.wPrice).toFixed(2)
        : `${money(b.rPrice).toFixed(2)}|${money(b.salesPrice).toFixed(2)}`,
    ),
  );
  return keys.size > 1;
}

export interface BatchAllocation {
  batchId: string;
  qty: Decimal;
}

/**
 * Takes `wanted` from the chosen batch first (or the oldest), then fills the rest from the next
 * oldest batches, each at its own price.
 */
export function allocateFifo(
  batches: StockBatch[],
  wanted: DecimalLike,
  startBatchId?: string,
): BatchAllocation[] {
  const sorted = sortBatchesFifo(batches).filter((b) => D(b.available).greaterThan(0));
  if (startBatchId) {
    const idx = sorted.findIndex((b) => b.id === startBatchId);
    if (idx > 0) sorted.unshift(...sorted.splice(idx, 1));
  }
  let remaining = D(wanted);
  const out: BatchAllocation[] = [];
  for (const b of sorted) {
    if (!remaining.greaterThan(0)) break;
    const take = Decimal.min(remaining, D(b.available));
    out.push({ batchId: b.id, qty: qty(take) });
    remaining = remaining.minus(take);
  }
  if (remaining.greaterThan(0)) {
    const have = sorted.reduce((s, b) => s.plus(D(b.available)), new Decimal(0));
    throw new DomainError('INSUFFICIENT_STOCK', `Only ${trimZeros(have)} in stock here.`, 'qty', {
      available: have.toFixed(3),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

/**
 * The refund is the cash the customer actually paid for those units, after line discounts.
 * The last units returned take whatever is left of the line amount, so rounding never drifts.
 */
export function returnRefund(
  line: {
    soldQty: DecimalLike;
    returnedQty: DecimalLike;
    amount: DecimalLike;
    refundedAmount: DecimalLike;
  },
  returnQty: DecimalLike,
): Decimal {
  const sold = D(line.soldQty);
  const returnable = sold.minus(D(line.returnedQty));
  const r = D(returnQty);
  if (!r.greaterThan(0))
    throw new DomainError('VALIDATION', 'Return qty must be more than 0.', 'qty');
  if (r.greaterThan(returnable)) {
    throw new DomainError('VALIDATION', `Only ${trimZeros(returnable)} can be returned.`, 'qty', {
      returnable: returnable.toFixed(3),
    });
  }
  if (r.equals(returnable)) return money(D(line.amount).minus(D(line.refundedAmount)));
  return money(D(line.amount).times(r).dividedBy(sold));
}
