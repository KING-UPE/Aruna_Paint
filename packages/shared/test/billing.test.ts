import { describe, expect, it } from 'vitest';
import {
  allocateFifo,
  computeChange,
  DomainError,
  lineAmounts,
  needsPricePopup,
  parseDiscountText,
  parseQtyInput,
  priceLine,
  returnRefund,
  saleTotals,
} from '../src';

describe('qty box', () => {
  const paint = { allowLoose: true, packSize: '4', unitAllowsDecimal: false };
  it('1 sells one can and 1L sells one liter', () => {
    expect(parseQtyInput('1', paint)).toEqual({ kind: 'UNITS', qty: '1.000' });
    expect(parseQtyInput('1L', paint)).toEqual({ kind: 'LOOSE', liters: '1.000', display: '1 L' });
  });
  it('1.5L and part of a can (0.375) are loose liters', () => {
    expect(parseQtyInput('1.5L', paint)).toMatchObject({
      kind: 'LOOSE',
      liters: '1.500',
      display: '1.5 L',
    });
    expect(parseQtyInput('0.375', paint)).toMatchObject({
      kind: 'LOOSE',
      liters: '1.500',
      display: '1.5 L',
    });
    expect(parseQtyInput('1.5 l', paint)).toMatchObject({ kind: 'LOOSE', liters: '1.500' });
  });
  it('pieces must be whole for items not sold loose', () => {
    const brush = { allowLoose: false, unitAllowsDecimal: false };
    expect(() => parseQtyInput('1.5', brush)).toThrow(DomainError);
    expect(() => parseQtyInput('1L', brush)).toThrow(/not sold loose/);
    expect(parseQtyInput('3', brush)).toEqual({ kind: 'UNITS', qty: '3.000' });
  });
  it('L and kg take decimals', () => {
    const thinner = { allowLoose: false, unitAllowsDecimal: true };
    expect(parseQtyInput('2.25', thinner)).toEqual({ kind: 'UNITS', qty: '2.250' });
    expect(parseQtyInput('2.25L', thinner)).toEqual({ kind: 'UNITS', qty: '2.250' });
  });
  it('rejects zero and junk', () => {
    expect(() => parseQtyInput('0', paint)).toThrow();
    expect(() => parseQtyInput('abc', paint)).toThrow();
  });
});

describe('discount box', () => {
  it('50 is rupees and 5% is percent', () => {
    expect(parseDiscountText('50')).toEqual({ type: 'AMOUNT', value: '50' });
    expect(parseDiscountText('5%')).toEqual({ type: 'PERCENT', value: '5' });
    expect(parseDiscountText('')).toEqual({ type: 'AMOUNT', value: '0' });
    expect(parseDiscountText('abc')).toBeNull();
  });
});

describe('line pricing', () => {
  const batch = {
    rPrice: '2000',
    wPrice: '1600',
    cost: '1800',
    purchaseDiscount: '200',
    salesDiscount: '100',
  };
  it('pre-fills the sales discount set at purchase', () => {
    const p = priceLine(batch, { wholesale: false });
    expect(p.discountPerUnit.toFixed(2)).toBe('100.00');
    expect(p.netUnitPrice.toFixed(2)).toBe('1900.00');
  });
  it('allows up to the purchase discount', () => {
    expect(
      priceLine(batch, {
        wholesale: false,
        discount: { type: 'AMOUNT', value: '200' },
      }).netUnitPrice.toFixed(2),
    ).toBe('1800.00');
    expect(
      priceLine(batch, {
        wholesale: false,
        discount: { type: 'PERCENT', value: '10' },
      }).discountPerUnit.toFixed(2),
    ).toBe('200.00');
  });
  it('blocks a discount above the purchase discount', () => {
    expect(() =>
      priceLine(batch, { wholesale: false, discount: { type: 'AMOUNT', value: '201' } }),
    ).toThrow(/most this item/);
  });
  it('blocks selling below cost', () => {
    const tight = { ...batch, purchaseDiscount: '300' };
    expect(() =>
      priceLine(tight, { wholesale: false, discount: { type: 'AMOUNT', value: '250' } }),
    ).toThrow(/below cost/);
  });
  it('wholesale takes the W-price with no extra discount', () => {
    const p = priceLine(batch, { wholesale: true, discount: { type: 'AMOUNT', value: '50' } });
    expect(p.unitPrice.toFixed(2)).toBe('1600.00');
    expect(p.discountPerUnit.toFixed(2)).toBe('0.00');
  });
});

describe('bill totals (plan billing mock-up)', () => {
  // Thinner 4L 2 × 2,600 less 150 each; Emulsion loose 1.5 L × 650; Brush 1 × 450.
  const lines = [
    { qty: '2', unitPrice: '2600', discountPerUnit: '150' },
    { qty: '1.5', unitPrice: '650', discountPerUnit: '0' },
    { qty: '1', unitPrice: '450', discountPerUnit: '0' },
  ];
  it('shows net items, net quantity, gross, discount and net total', () => {
    const t = saleTotals(lines);
    expect(t.netItems).toBe(3);
    expect(t.netQty.toFixed(1)).toBe('4.5');
    expect(t.gross.toFixed(2)).toBe('6625.00');
    expect(t.discount.toFixed(2)).toBe('300.00');
    expect(t.netTotal.toFixed(2)).toBe('6325.00');
  });
  it('line amount for the thinner is 4,900', () => {
    expect(lineAmounts('2600', '150', '2').amount.toFixed(2)).toBe('4900.00');
  });
  it('loose line 1.5 L × Rs 650 = Rs 975', () => {
    expect(lineAmounts('650', '0', '1.5').amount.toFixed(2)).toBe('975.00');
  });
});

describe('cash payment', () => {
  it('an empty amount means exact cash', () => {
    const c = computeChange('6325', '');
    expect(c.cashGiven.toFixed(2)).toBe('6325.00');
    expect(c.change.toFixed(2)).toBe('0.00');
  });
  it('shows the change', () => {
    expect(computeChange('6325', '7000').change.toFixed(2)).toBe('675.00');
  });
  it('the cash given must cover the net total', () => {
    expect(() => computeChange('6325', '6000')).toThrow(/must cover/);
  });
});

describe('batches', () => {
  const batches = [
    {
      id: 'b2',
      code: '10001-02',
      available: '3',
      firstReceivedAt: '2026-09-01',
      rPrice: '2600',
      wPrice: '2450',
      salesPrice: '2450',
    },
    {
      id: 'b1',
      code: '10001-01',
      available: '2',
      firstReceivedAt: '2026-08-01',
      rPrice: '2400',
      wPrice: '2300',
      salesPrice: '2300',
    },
    {
      id: 'b4',
      code: '10001-04',
      available: '0',
      firstReceivedAt: '2026-07-01',
      rPrice: '2600',
      wPrice: '2450',
      salesPrice: '2450',
    },
  ];
  it('opens the pop-up only for two or more in-stock prices', () => {
    expect(needsPricePopup(batches, false)).toBe(true);
    expect(needsPricePopup([batches[0]!, batches[2]!], false)).toBe(false);
    const samePrice = [
      batches[0]!,
      { ...batches[1]!, rPrice: '2600', salesPrice: '2450', wPrice: '2450' },
    ];
    expect(needsPricePopup(samePrice, false)).toBe(false);
  });
  it('fills from the oldest batch, then the next, each at its own price', () => {
    // "2 from 10001-01 at Rs 2,300 and 3 from 10001-02 at Rs 2,450"
    const a = allocateFifo(batches, '5');
    expect(a.map((x) => [x.batchId, x.qty.toFixed(0)])).toEqual([
      ['b1', '2'],
      ['b2', '3'],
    ]);
  });
  it('typing a sub code starts from that batch', () => {
    const a = allocateFifo(batches, '4', 'b2');
    expect(a.map((x) => [x.batchId, x.qty.toFixed(0)])).toEqual([
      ['b2', '3'],
      ['b1', '1'],
    ]);
  });
  it('refuses more than the stock here', () => {
    expect(() => allocateFifo(batches, '6')).toThrow(/Only 5 in stock/);
  });
});

describe('returns', () => {
  const line = { soldQty: '3', returnedQty: '0', amount: '1000', refundedAmount: '0' };
  it('refunds what the customer paid for those units', () => {
    expect(returnRefund(line, '1').toFixed(2)).toBe('333.33');
  });
  it('the last units take what is left, so totals never drift', () => {
    expect(
      returnRefund({ ...line, returnedQty: '1', refundedAmount: '333.33' }, '2').toFixed(2),
    ).toBe('666.67');
  });
  it('allows up to sold minus already returned', () => {
    expect(() =>
      returnRefund({ ...line, returnedQty: '2', refundedAmount: '666.66' }, '2'),
    ).toThrow(/Only 1 can be returned/);
  });
});
