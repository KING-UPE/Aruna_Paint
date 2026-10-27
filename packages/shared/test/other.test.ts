import { describe, expect, it } from 'vitest';
import {
  allocatePaymentOldestFirst,
  cansToLiters,
  computeMonthlyClosing,
  costPerLiter,
  assertMixPrice,
  nextMainCode,
  normalizePhone,
  renderNumber,
  sequenceScope,
  subProductCode,
  mixPaintCode,
  suggestReorderQty,
  supplierBalance,
  validateNumberFormat,
  weightedAverageCost,
  nameKey,
  codeKey,
  formatRs,
  formatDate,
  formatQty,
  resolvePermissions,
  assignablePermissions,
  isSuperAdminOnly,
  normalizeCombo,
  validateKeyAssignment,
  eventToCombo,
  shopDate,
} from '../src';

describe('mix paint', () => {
  it('MP-20001 holds 2 L at Rs 500; adding one 4 L can at Rs 1,800 gives Rs 466.67 per L', () => {
    const perL = costPerLiter('1800', '4');
    expect(perL.toFixed(2)).toBe('450.00');
    const liters = cansToLiters(1, '4');
    expect(liters.toFixed(1)).toBe('4.0');
    expect(
      weightedAverageCost({
        oldLiters: '2',
        oldCost: '500',
        addLiters: liters,
        addCost: perL,
      }).toFixed(2),
    ).toBe('466.67');
  });
  it('whole cans only', () => {
    expect(() => cansToLiters('1.5', '4')).toThrow(/whole cans/);
  });
  it('the price per liter never goes below the average cost', () => {
    expect(() => assertMixPrice('466', '466.67')).toThrow();
    expect(() => assertMixPrice('650', '466.67')).not.toThrow();
  });
});

describe('monthly closing (plan example)', () => {
  const r = computeMonthlyClosing({
    netSales: '2450000',
    costOfGoodsSold: '1960000',
    dailyExpenses: '18000',
    rules: [
      { id: 'sal', name: 'Salaries', kind: 'FIXED', value: '120000', sortOrder: 1 },
      { id: 'rent', name: 'Rent', kind: 'FIXED', value: '45000', sortOrder: 2 },
      { id: 'elec', name: 'Electricity and water', kind: 'VARIABLE', value: '13000', sortOrder: 3 },
      { id: 'sav', name: 'Savings', kind: 'PERCENT', value: '20', sortOrder: 4 },
      { id: 'dev', name: 'Shop development', kind: 'PERCENT', value: '5', sortOrder: 5 },
    ],
    actuals: { elec: '14000' },
  });
  it('matches every line of the example', () => {
    expect(r.grossProfit.toFixed(0)).toBe('490000');
    expect(r.remainingAfterFixed.toFixed(0)).toBe('293000');
    const byId = Object.fromEntries(
      r.lines.filter((l) => l.ruleId).map((l) => [l.ruleId, l.amount.toFixed(0)]),
    );
    expect(byId).toEqual({
      sal: '-120000',
      rent: '-45000',
      elec: '-14000',
      sav: '-58600',
      dev: '-14650',
    });
    expect(r.balance.toFixed(0)).toBe('219750');
  });
  it('a percentage can be based on net sales or gross profit', () => {
    const x = computeMonthlyClosing({
      netSales: '1000',
      costOfGoodsSold: '600',
      dailyExpenses: '0',
      rules: [
        { id: 'p', name: 'P', kind: 'PERCENT', value: '10', base: 'NET_SALES', sortOrder: 1 },
      ],
    });
    expect(x.balance.toFixed(0)).toBe('300');
  });
});

describe('suppliers', () => {
  it('Balance = Opening + Purchases − Payments − Returns ± Adjustments', () => {
    expect(
      supplierBalance({
        opening: '1000',
        purchases: '5000',
        payments: '3000',
        returns: '500',
        adjustments: '-100',
      }).toFixed(2),
    ).toBe('2400.00');
  });
  it('payments settle the oldest bills first and the rest is an advance', () => {
    const r = allocatePaymentOldestFirst(
      [
        { id: 'new', date: '2026-10-10', due: '1000' },
        { id: 'old', date: '2026-09-01', due: '500' },
      ],
      '2000',
    );
    expect(r.allocations.map((a) => [a.billId, a.amount.toFixed(0)])).toEqual([
      ['old', '500'],
      ['new', '1000'],
    ]);
    expect(r.advance.toFixed(0)).toBe('500');
  });
});

describe('reorder', () => {
  it('suggests average sales × (lead + cover) − stock − on order, rounded up to packs', () => {
    const q = suggestReorderQty({
      avgDailySales: '2',
      leadDays: 3,
      coverDays: 7,
      stock: '4',
      onOrder: '0',
      reorderLevel: '5',
      reorderQty: '6',
      packSize: 12,
    });
    expect(q.toFixed(0)).toBe('24');
  });
  it('at least the reorder qty, and nothing when above the level', () => {
    expect(
      suggestReorderQty({
        avgDailySales: '0',
        leadDays: 3,
        coverDays: 7,
        stock: '1',
        onOrder: '0',
        reorderLevel: '5',
        reorderQty: '6',
      }).toFixed(0),
    ).toBe('6');
    expect(
      suggestReorderQty({
        avgDailySales: '9',
        leadDays: 3,
        coverDays: 7,
        stock: '6',
        onOrder: '0',
        reorderLevel: '5',
        reorderQty: '6',
      }).toFixed(0),
    ).toBe('0');
  });
});

describe('number formats', () => {
  const date = new Date('2026-10-24T10:42:00+05:30');
  it('renders the starting formats', () => {
    expect(renderNumber('INV-{NNNNNN}', { date, seq: 4512 })).toBe('INV-004512');
    expect(renderNumber('GRN-{YYYY}-{NNNNN}', { date, seq: 125 })).toBe('GRN-2026-00125');
    expect(renderNumber('DE-{YYYY}{MM}{DD}-{COUNTER}', { date, counter: 'C1' })).toBe(
      'DE-20261024-C1',
    );
    expect(renderNumber('A{YY}-INV-{NNNN}', { date, seq: 125 })).toBe('A26-INV-0125');
  });
  it('a yearly format counts per year', () => {
    expect(sequenceScope('GRN-{YYYY}-{NNNNN}', { date })).toBe('GRN-2026-#');
    expect(sequenceScope('INV-{NNNNNN}', { date })).toBe('INV-#');
  });
  it('uses the shop time zone for the date', () => {
    // 20:00 UTC on the 23rd is already the 24th in Sri Lanka.
    expect(shopDate(new Date('2026-10-23T20:00:00Z'))).toBe('2026-10-24');
  });
  it('validates formats', () => {
    expect(validateNumberFormat('INVOICE', 'INV-{NNNNNN}')).toEqual([]);
    expect(validateNumberFormat('INVOICE', 'INV-NNNNNN')).not.toEqual([]);
    expect(validateNumberFormat('INVOICE', 'INV-{NNN}-{NNN}')).not.toEqual([]);
    expect(validateNumberFormat('INVOICE', 'INV-{XX}{NNN}')).not.toEqual([]);
    expect(validateNumberFormat('DAY_END', 'DE-{YYYY}{MM}{DD}-{COUNTER}')).toEqual([]);
  });
});

describe('codes', () => {
  it('new items get the next 5-digit code and old codes are kept', () => {
    expect(nextMainCode([])).toBe('10001');
    expect(nextMainCode(['10001', '10050', 'PNT-7', '1234'])).toBe('10051');
  });
  it('builds sub and mix paint codes', () => {
    expect(subProductCode('10001', 5)).toBe('10001-05');
    expect(mixPaintCode('20001')).toBe('MP-20001');
  });
});

describe('text', () => {
  it('names ignore capitals and extra spaces; codes ignore capitals and spaces', () => {
    expect(nameKey('  White   Emulsion ')).toBe('white emulsion');
    expect(codeKey('inv 0045 12')).toBe('INV004512');
  });
  it('phones are stored as 0XXXXXXXXX', () => {
    expect(normalizePhone('+94 77 123 4567')).toBe('0771234567');
    expect(normalizePhone('077-123-4567')).toBe('0771234567');
    expect(normalizePhone('12345')).toBeNull();
  });
  it('formats rupees, quantities and dates', () => {
    expect(formatRs('1250')).toBe('Rs 1,250.00');
    expect(formatQty('1.500')).toBe('1.5');
    expect(formatQty('2.000')).toBe('2');
    expect(formatDate('2026-10-24')).toBe('24/10/2026');
  });
});

describe('permissions', () => {
  it('combines ticked roles', () => {
    const p = resolvePermissions([{ code: 'STOCK_MANAGER' }, { code: 'CASHIER' }]);
    expect(p.has('billing.create')).toBe(true);
    expect(p.has('purchases.create')).toBe(true);
    expect(p.has('cost.item')).toBe(true);
    expect(p.has('cost.totals')).toBe(false);
  });
  it('cost privacy: Admins and Cashiers see neither cost nor totals', () => {
    for (const code of ['ADMIN', 'CASHIER']) {
      const p = resolvePermissions([{ code }]);
      expect(p.has('cost.item')).toBe(false);
      expect(p.has('cost.totals')).toBe(false);
    }
    expect(resolvePermissions([{ code: 'SUPER_ADMIN' }]).has('cost.totals')).toBe(true);
  });
  it('a cashier needs an approver to void a bill', () => {
    expect(resolvePermissions([{ code: 'CASHIER' }]).has('bill_history.approve')).toBe(false);
    expect(resolvePermissions([{ code: 'ADMIN' }]).has('bill_history.approve')).toBe(true);
  });
  it('custom roles use stored permissions and never Super Admin-only ones', () => {
    expect(
      resolvePermissions([{ code: 'CUSTOM_1', permissions: ['stock.view'] }]).toArray(),
    ).toEqual(['stock.view']);
    expect(assignablePermissions()).not.toContain('users.create');
    expect(assignablePermissions()).not.toContain('cost.totals');
    expect(isSuperAdminOnly('settings.edit')).toBe(true);
  });
});

describe('shortcuts', () => {
  it('normalizes combos', () => {
    expect(normalizeCombo('shift+ctrl+k')).toBe('Ctrl+Shift+K');
    expect(normalizeCombo('+')).toBe('+');
    expect(normalizeCombo('Ctrl++')).toBe('Ctrl++');
    expect(normalizeCombo('del')).toBe('Delete');
    expect(
      eventToCombo({ key: 'k', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }),
    ).toBe('Ctrl+K');
    expect(
      eventToCombo({ key: '+', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false }),
    ).toBe('+');
    expect(
      eventToCombo({ key: 'F10', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }),
    ).toBe('F10');
  });
  it('blocks reserved keys and keys already used on the screen', () => {
    expect(validateKeyAssignment('billing', 'pay', 'F5', [])).toMatch(/reserved/);
    expect(validateKeyAssignment('billing', 'pay', 'F7', [])).toMatch(/Hold bill/);
    expect(validateKeyAssignment('billing', 'pay', 'Ctrl+K', [])).toMatch(/Command palette/);
    expect(validateKeyAssignment('billing', 'pay', 'F12', [])).toMatch(/reserved/);
    expect(validateKeyAssignment('billing', 'pay', 'Ctrl+9', [])).toBeNull();
    expect(
      validateKeyAssignment('billing', 'hold', 'F10', [
        { screen: 'billing', action: 'pay', keys: 'Ctrl+9' },
      ]),
    ).toBeNull();
  });
});

describe('permission overrides', () => {
  it('a user can lose one permission of a ticked role, or gain one from outside it', async () => {
    const { resolvePermissions } = await import('../src');
    const p = resolvePermissions(
      [{ code: 'CASHIER' }],
      [
        { permission: 'returns.create', granted: false },
        { permission: 'stock.view', granted: true },
      ],
    );
    expect(p.has('returns.create')).toBe(false);
    expect(p.has('stock.view')).toBe(true);
    expect(p.has('billing.create')).toBe(true);
  });
  it('Super Admin-only permissions are never given by an override; a Super Admin keeps all', async () => {
    const { resolvePermissions } = await import('../src');
    expect(
      resolvePermissions([{ code: 'ADMIN' }], [{ permission: 'users.edit', granted: true }]).has(
        'users.edit',
      ),
    ).toBe(false);
    expect(
      resolvePermissions(
        [{ code: 'SUPER_ADMIN' }],
        [{ permission: 'billing.create', granted: false }],
      ).has('billing.create'),
    ).toBe(true);
  });
  it('a customized built-in role uses its stored permissions', async () => {
    const { resolvePermissions } = await import('../src');
    const p = resolvePermissions([
      { code: 'ADMIN', customized: true, permissions: ['stock.view'] },
    ]);
    expect(p.toArray()).toEqual(['stock.view']);
  });
});
