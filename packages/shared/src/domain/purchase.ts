import { D, Decimal, money, qty, type DecimalLike } from '../decimal';
import type { RuleIssue } from '../errors';
import { discountPerUnit, NO_DISCOUNT, type DiscountInput } from './discount';

/**
 * One GRN line, as typed on the purchase screen.
 * Value, Qty, Free and the purchase discount are in the buying unit (a box for boxed items);
 * prices that are sold at the counter (R-price, W-price, sales discount, sales price) are per
 * stock unit (a piece for boxed items).
 */
export interface PurchaseLineInput {
  /** Market price per buying unit on the supplier's list. */
  value: DecimalLike;
  qty: DecimalLike;
  free?: DecimalLike;
  /** Purchase discount per buying unit: % of Value or Rs. */
  discount?: DiscountInput;
  /** Pieces per box for items bought in boxes and sold singly; 1 otherwise. */
  piecesPerBox?: number;
  /** Per stock unit; defaults to Value ÷ pieces per box. */
  rPrice?: DecimalLike | null;
  /** Per stock unit; defaults to the sales price. */
  wPrice?: DecimalLike | null;
  /** Per stock unit: % of R-price or Rs. */
  salesDiscount?: DiscountInput;
  /** Per stock unit; when typed it wins and the sales discount follows from it. */
  salesPrice?: DecimalLike | null;
}

export interface PurchaseLineResult {
  piecesPerBox: number;
  /** Purchase discount per buying unit, Rs. */
  discountPerBuyingUnit: Decimal;
  /** Value − Discount, per buying unit. */
  costPerBuyingUnit: Decimal;
  /** Cost × Qty. */
  amount: Decimal;
  /** (Qty + Free) in stock units. */
  stockQty: Decimal;
  /** The rest is per stock unit. */
  marketValue: Decimal;
  purchaseDiscount: Decimal;
  cost: Decimal;
  /** Amount ÷ (Qty + Free): what each unit really cost, free items included. */
  actualPrice: Decimal;
  rPrice: Decimal;
  wPrice: Decimal;
  salesDiscount: Decimal;
  salesPrice: Decimal;
  /** Sales price − Actual price. */
  margin: Decimal;
}

export function computePurchaseLine(input: PurchaseLineInput): PurchaseLineResult {
  const ppb = Math.max(1, Math.trunc(input.piecesPerBox ?? 1));
  const value = money(input.value);
  const q = qty(input.qty);
  const free = qty(input.free ?? 0);

  const discountPerBuyingUnit = discountPerUnit(value, input.discount ?? NO_DISCOUNT);
  const costPerBuyingUnit = money(value.minus(discountPerBuyingUnit));
  const amount = money(costPerBuyingUnit.times(q));
  const stockQty = qty(q.plus(free).times(ppb));

  const marketValue = money(value.dividedBy(ppb));
  const purchaseDiscount = money(discountPerBuyingUnit.dividedBy(ppb));
  const cost = money(costPerBuyingUnit.dividedBy(ppb));
  const actualPrice = stockQty.isZero() ? cost : money(amount.dividedBy(stockQty));

  const rPrice = input.rPrice != null && input.rPrice !== '' ? money(input.rPrice) : marketValue;

  let salesPrice: Decimal;
  let salesDiscount: Decimal;
  if (input.salesPrice != null && input.salesPrice !== '') {
    salesPrice = money(input.salesPrice);
    salesDiscount = money(rPrice.minus(salesPrice));
  } else {
    salesDiscount = discountPerUnit(rPrice, input.salesDiscount ?? NO_DISCOUNT);
    salesPrice = money(rPrice.minus(salesDiscount));
  }

  const wPrice = input.wPrice != null && input.wPrice !== '' ? money(input.wPrice) : salesPrice;
  const margin = money(salesPrice.minus(actualPrice));

  return {
    piecesPerBox: ppb,
    discountPerBuyingUnit,
    costPerBuyingUnit,
    amount,
    stockQty,
    marketValue,
    purchaseDiscount,
    cost,
    actualPrice,
    rPrice,
    wPrice,
    salesDiscount,
    salesPrice,
    margin,
  };
}

/** The purchase-line rules from the plan; an empty list means the line can be posted. */
export function validatePurchaseLine(
  input: PurchaseLineInput,
  result: PurchaseLineResult = computePurchaseLine(input),
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const value = D(input.value);
  const q = D(input.qty);
  const free = D(input.free ?? 0);

  if (value.isNegative()) {
    issues.push({ code: 'VALIDATION', field: 'value', message: 'Value must be 0 or more.' });
  }
  if (!q.greaterThan(0)) {
    issues.push({ code: 'VALIDATION', field: 'qty', message: 'Qty must be more than 0.' });
  }
  if (free.isNegative()) {
    issues.push({ code: 'VALIDATION', field: 'free', message: 'Free must be 0 or more.' });
  }
  const discount = input.discount ?? NO_DISCOUNT;
  if (
    discount.type === 'PERCENT' &&
    (D(discount.value).isNegative() || D(discount.value).greaterThan(100))
  ) {
    issues.push({
      code: 'VALIDATION',
      field: 'discount',
      message: 'Discount must be between 0 and 100%.',
    });
  }
  if (
    discount.type === 'AMOUNT' &&
    (D(discount.value).isNegative() || D(discount.value).greaterThan(value))
  ) {
    issues.push({
      code: 'VALIDATION',
      field: 'discount',
      message: 'Discount cannot be more than the Value.',
    });
  }
  if (result.salesDiscount.isNegative()) {
    issues.push({
      code: 'PRICE_ABOVE_R_PRICE',
      field: 'salesPrice',
      message: 'Sales price cannot be above the R-price.',
    });
  } else if (result.salesDiscount.greaterThan(result.purchaseDiscount)) {
    issues.push({
      code: 'DISCOUNT_ABOVE_LIMIT',
      field: 'salesDiscount',
      message: `Sales discount cannot be more than the purchase discount (Rs ${result.purchaseDiscount.toFixed(2)}).`,
    });
  }
  if (result.salesPrice.lessThan(result.cost)) {
    issues.push({
      code: 'BELOW_COST',
      field: 'salesPrice',
      message: 'Sales price cannot be below the cost.',
    });
  }
  if (result.wPrice.lessThan(result.actualPrice) || result.wPrice.greaterThan(result.rPrice)) {
    issues.push({
      code: 'VALIDATION',
      field: 'wPrice',
      message: 'W-price must be between the actual price and the R-price.',
    });
  }
  return issues;
}

export interface PurchaseFooterInput {
  lineAmounts: DecimalLike[];
  invoiceDiscount?: DecimalLike;
  otherCharges?: DecimalLike;
}

/** Invoice discount and transport change the net total and supplier balance, never item costs. */
export function computePurchaseTotals(input: PurchaseFooterInput) {
  const subtotal = money(input.lineAmounts.reduce<Decimal>((s, a) => s.plus(D(a)), new Decimal(0)));
  const invoiceDiscount = money(input.invoiceDiscount ?? 0);
  const otherCharges = money(input.otherCharges ?? 0);
  const netTotal = money(subtotal.minus(invoiceDiscount).plus(otherCharges));
  return { subtotal, invoiceDiscount, otherCharges, netTotal };
}

/** The supplier's invoice total must match the net total within Rs 1 before posting. */
export function supplierTotalMatches(
  netTotal: DecimalLike,
  supplierInvoiceTotal: DecimalLike,
): boolean {
  return D(netTotal).minus(D(supplierInvoiceTotal)).abs().lessThanOrEqualTo(1);
}

/** The fields a posted line must match for its stock to join an existing sub-product. */
export interface SubProductMatchKey {
  supplierId: string | null;
  cost: DecimalLike;
  rPrice: DecimalLike;
  wPrice: DecimalLike;
  salesPrice: DecimalLike;
  expiryDate: string | null;
}

export function subProductMatches(a: SubProductMatchKey, b: SubProductMatchKey): boolean {
  return (
    a.supplierId === b.supplierId &&
    D(a.cost).equals(D(b.cost)) &&
    D(a.rPrice).equals(D(b.rPrice)) &&
    D(a.wPrice).equals(D(b.wPrice)) &&
    D(a.salesPrice).equals(D(b.salesPrice)) &&
    (a.expiryDate ?? null) === (b.expiryDate ?? null)
  );
}
