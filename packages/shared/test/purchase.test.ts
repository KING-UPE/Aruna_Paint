import { describe, expect, it } from 'vitest';
import {
  computePurchaseLine,
  computePurchaseTotals,
  maxSalesDiscountPercent,
  subProductMatches,
  supplierTotalMatches,
  validatePurchaseLine,
} from '../src';

describe('purchase line (plan worked example)', () => {
  // Value Rs 2,000, Qty 10, Free 2 and Discount 10% give Cost Rs 1,800, Amount Rs 18,000 and
  // Actual price Rs 1,500. With R-price Rs 2,000 and a 5% sales discount, the Sales price is
  // Rs 1,900 and the Margin Rs 400 per unit.
  const input = {
    value: '2000',
    qty: '10',
    free: '2',
    discount: { type: 'PERCENT' as const, value: '10' },
    salesDiscount: { type: 'PERCENT' as const, value: '5' },
  };
  const r = computePurchaseLine(input);

  it('calculates cost, amount and actual price', () => {
    expect(r.cost.toFixed(2)).toBe('1800.00');
    expect(r.amount.toFixed(2)).toBe('18000.00');
    expect(r.actualPrice.toFixed(2)).toBe('1500.00');
    expect(r.stockQty.toFixed(3)).toBe('12.000');
  });

  it('defaults R-price to Value and derives sales price and margin', () => {
    expect(r.rPrice.toFixed(2)).toBe('2000.00');
    expect(r.salesDiscount.toFixed(2)).toBe('100.00');
    expect(r.salesPrice.toFixed(2)).toBe('1900.00');
    expect(r.margin.toFixed(2)).toBe('400.00');
  });

  it('caps the counter discount at the purchase discount (Rs 200)', () => {
    expect(r.purchaseDiscount.toFixed(2)).toBe('200.00');
  });

  it('passes validation with the W-price defaulting to the sales price', () => {
    expect(r.wPrice.toFixed(2)).toBe('1900.00');
    expect(validatePurchaseLine(input, r)).toEqual([]);
  });

  it('rejects a sales discount above the purchase discount', () => {
    const bad = { ...input, salesDiscount: { type: 'AMOUNT' as const, value: '250' } };
    const issues = validatePurchaseLine(bad);
    expect(issues.map((i) => i.code)).toContain('DISCOUNT_ABOVE_LIMIT');
    expect(issues.map((i) => i.code)).toContain('BELOW_COST');
  });

  it('rejects a W-price outside actual price and R-price', () => {
    expect(validatePurchaseLine({ ...input, wPrice: '1400' }).map((i) => i.field)).toContain(
      'wPrice',
    );
    expect(validatePurchaseLine({ ...input, wPrice: '2100' }).map((i) => i.field)).toContain(
      'wPrice',
    );
    expect(validatePurchaseLine({ ...input, wPrice: '1500' })).toEqual([]);
  });

  it('rejects zero qty and discounts over 100%', () => {
    expect(validatePurchaseLine({ ...input, qty: '0' }).map((i) => i.field)).toContain('qty');
    expect(
      validatePurchaseLine({ ...input, discount: { type: 'PERCENT', value: '120' } }).map(
        (i) => i.field,
      ),
    ).toContain('discount');
  });

  it('a typed sales price wins over the sales discount', () => {
    const t = computePurchaseLine({ ...input, salesPrice: '1950' });
    expect(t.salesDiscount.toFixed(2)).toBe('50.00');
    expect(t.margin.toFixed(2)).toBe('450.00');
  });
});

describe('the most sales discount, as the GRN screen shows it', () => {
  // The shop's example: Value Rs 1,000, Discount 36%, R-price Rs 1,000. The purchase discount is
  // Rs 360, so the sales discount may be up to 36%, the same as the purchase discount.
  const line = { value: '1000', qty: '10', discount: { type: 'PERCENT' as const, value: '36' } };
  it('a 36% discount allows a 36% sales discount, not 360', () => {
    expect(maxSalesDiscountPercent(computePurchaseLine(line))?.toString()).toBe('36');
    const at36 = { ...line, salesDiscount: { type: 'PERCENT' as const, value: '36' } };
    expect(validatePurchaseLine(at36)).toEqual([]);
    const at37 = { ...line, salesDiscount: { type: 'PERCENT' as const, value: '37' } };
    expect(validatePurchaseLine(at37)[0]?.message).toBe(
      'Sales discount cannot be more than the purchase discount (max 36%, Rs 360.00).',
    );
  });
  it('is the same money when the R-price is higher, so a smaller percent', () => {
    expect(
      maxSalesDiscountPercent(computePurchaseLine({ ...line, rPrice: '1200' }))?.toString(),
    ).toBe('30');
    // Rounded down, so the figure shown always passes.
    const third = { value: '300', qty: '1', discount: { type: 'AMOUNT' as const, value: '100' } };
    const max = maxSalesDiscountPercent(computePurchaseLine(third))!;
    expect(max.toString()).toBe('33.33');
    expect(
      validatePurchaseLine({ ...third, salesDiscount: { type: 'PERCENT', value: max.toString() } }),
    ).toEqual([]);
  });
});

describe('boxed items', () => {
  it('2 boxes of 12 enter stock as 24 pieces, each costing the box cost ÷ 12', () => {
    const r = computePurchaseLine({ value: '1200', qty: '2', piecesPerBox: 12 });
    expect(r.stockQty.toFixed(3)).toBe('24.000');
    expect(r.cost.toFixed(2)).toBe('100.00');
    expect(r.actualPrice.toFixed(2)).toBe('100.00');
    expect(r.amount.toFixed(2)).toBe('2400.00');
    expect(r.rPrice.toFixed(2)).toBe('100.00');
  });

  it('free boxes lower the actual price per piece', () => {
    const r = computePurchaseLine({ value: '1200', qty: '2', free: '1', piecesPerBox: 12 });
    expect(r.stockQty.toFixed(3)).toBe('36.000');
    expect(r.actualPrice.toFixed(2)).toBe('66.67');
  });
});

describe('purchase footer', () => {
  it('invoice discount and transport change only the net total', () => {
    const t = computePurchaseTotals({
      lineAmounts: ['18000', '2400'],
      invoiceDiscount: '400',
      otherCharges: '500',
    });
    expect(t.subtotal.toFixed(2)).toBe('20400.00');
    expect(t.netTotal.toFixed(2)).toBe('20500.00');
  });

  it('the supplier invoice total must match within Rs 1', () => {
    expect(supplierTotalMatches('20500', '20500.99')).toBe(true);
    expect(supplierTotalMatches('20500', '20501')).toBe(true);
    expect(supplierTotalMatches('20500', '20501.01')).toBe(false);
  });
});

describe('sub-product matching', () => {
  const base = {
    supplierId: 'a',
    cost: '2400',
    rPrice: '2600',
    wPrice: '2450',
    salesPrice: '2450',
    expiryDate: null,
  };
  it('matches on supplier, cost, prices and expiry', () => {
    expect(subProductMatches(base, { ...base, cost: '2400.00' })).toBe(true);
  });
  it('a new cost or a new expiry date makes a new sub-product', () => {
    expect(subProductMatches(base, { ...base, cost: '2500' })).toBe(false);
    expect(subProductMatches(base, { ...base, expiryDate: '2027-01-01' })).toBe(false);
    expect(subProductMatches(base, { ...base, supplierId: 'b' })).toBe(false);
  });
});
