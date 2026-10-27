import { readFile, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, createTestApp, login, PINS, setupShop, valueId, type Shop } from './helpers';
import { createCatalog, postGrn, subProducts, type Catalog } from './fixtures';

let app: FastifyInstance;
let shop: Shop;
let cat: Catalog;
let thinner: string;
let brush: string;
let emulsionCan: string;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

/**
 * Stock for the plan's billing mock-up: Thinner 4L at R-price 2,600 with Rs 150 default discount,
 * White Emulsion sold loose at Rs 650 per liter, Brush 2 inch at Rs 450.
 */
beforeEach(async () => {
  shop = await setupShop(app);
  cat = await createCatalog(shop);
  await postGrn(shop, cat.supplierA, [
    {
      productId: cat.thinner,
      value: '2600',
      qty: '10',
      discount: { type: 'PERCENT', value: '10' },
      salesDiscount: { type: 'AMOUNT', value: '150' },
    },
    { productId: cat.brush, value: '450', qty: '10' },
    { productId: cat.emulsion, value: '2000', qty: '5' },
  ]);
  thinner = (await subProducts(shop, cat.thinner))[0]!.id;
  brush = (await subProducts(shop, cat.brush))[0]!.id;
  emulsionCan = (await subProducts(shop, cat.emulsion))[0]!.id;
  const t = await shop.stock.post('/api/mix-paint/transfers', {
    sourceSubProductId: emulsionCan,
    cans: 1,
    pricePerLiter: '650',
  });
  expect(t.status).toBe(200);
  for (const c of [shop.cashier, shop.cashier2]) {
    expect((await c.post('/api/shifts/open', { openingFloat: '5000' })).status).toBe(200);
  }
});

const mockupLines = () => [
  { kind: 'BATCH', subProductId: thinner, qty: '2' },
  { kind: 'LOOSE', productId: cat.emulsion, liters: '1.5' },
  { kind: 'BATCH', subProductId: brush, qty: '1' },
];

async function stockOf(subId: string) {
  const r = await shop.sa.get(`/api/sub-products/${subId}/stock`);
  return Object.fromEntries(
    r.body.items.map((i: { location: string; qty: string }) => [i.location, i.qty]),
  );
}

describe('a sale, start to finish', () => {
  it('rings up the plan mock-up: net total Rs 6,325.00, change from Rs 7,000', async () => {
    const r = await shop.cashier.post('/api/sales', { lines: mockupLines(), cashGiven: '7000' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      no: 'INV-000001',
      netTotal: '6325.00',
      cashGiven: '7000.00',
      change: '675.00',
    });
    const sale = (await shop.cashier.get(`/api/sales/${r.body.id}`)).body;
    expect(sale).toMatchObject({
      itemCount: 3,
      totalQty: '4.500',
      gross: '6625.00',
      discount: '300.00',
      netTotal: '6325.00',
    });
    expect(sale.lines.map((l: { name: string; amount: string }) => [l.name, l.amount])).toEqual([
      ['Thinner 4L', '4900.00'],
      ['White Emulsion (Mix Paint), loose', '975.00'],
      ['Brush 2 inch', '450.00'],
    ]);
    // Cashiers never see cost on a bill.
    expect(sale.lines[0].unitCost).toBeUndefined();
    expect(await stockOf(thinner)).toEqual({ Shop: '8.000' });
    const mix = (await shop.stock.get(`/api/mix-paint/${cat.mixEmulsion}`)).body;
    expect(mix.litersHere).toBe('2.500');
  });

  it('prints the 80 mm receipt with totals, change and savings, and opens the drawer', async () => {
    const dir = '/tmp/aruna-test-receipts';
    await rm(dir, { recursive: true, force: true });
    await app.deps.db.counter.update({
      where: { code: 'C1' },
      data: { printer: { driver: 'file', path: dir } },
    });
    const r = await shop.cashier.post('/api/sales', {
      lines: mockupLines(),
      cashGiven: '7000',
      customerName: 'Sunil',
    });
    expect(r.body.print).toEqual({ printed: true });
    const txt = await readFile(`${dir}/INV-000001.txt`, 'utf8');
    expect(txt).toContain('PANNALA ARUNA PAINT CENTER');
    expect(txt).toContain('INVOICE INV-000001');
    expect(txt).toContain('Customer: Sunil');
    expect(txt).toContain('1.5 L x 650.00');
    expect(txt).toMatch(/NET TOTAL\s+6,325.00/);
    expect(txt).toMatch(/Change\s+675.00/);
    expect(txt).toContain('You saved Rs 300.00');
    const bin = await readFile(`${dir}/INV-000001.bin`);
    expect(bin.includes(Buffer.from([0x1b, 0x70, 0x00]))).toBe(true);
  });

  it('an empty cash amount means exact cash; less than the total is refused', async () => {
    const exact = await shop.cashier.post('/api/sales', {
      lines: [{ kind: 'BATCH', subProductId: brush, qty: '1' }],
    });
    expect(exact.body).toMatchObject({ cashGiven: '450.00', change: '0.00' });
    const short = await shop.cashier.post('/api/sales', {
      lines: [{ kind: 'BATCH', subProductId: brush, qty: '1' }],
      cashGiven: '400',
    });
    expect(short.status).toBe(400);
    expect(short.body.error.field).toBe('cashGiven');
  });

  it('starts the day itself on the first bill, stops after the day end, and needs a counter PC', async () => {
    // The owner changed this on main: a counter with no open day opens one (float 0) on its
    // first invoice instead of asking for the float first.
    await app.deps.db.counter.create({
      data: { code: 'C3', name: 'Counter 3', locationId: shop.ids.shop! },
    });
    const c3 = new Client(app);
    await login(c3, 'cashier2', 'C3');
    const first = await c3.post('/api/sales', {
      lines: [{ kind: 'BATCH', subProductId: brush, qty: '1' }],
    });
    expect(first.status).toBe(200);
    expect((await c3.get('/api/shifts/current')).body.shift).toMatchObject({
      status: 'OPEN',
      openingFloat: '0.00',
      billCount: 1,
    });
    // One day end per counter per date: once it is done, the counter bills no more today.
    await shop.cashier.post('/api/shifts/current/close', { denominations: {} });
    const r = await shop.cashier.post('/api/sales', {
      lines: [{ kind: 'BATCH', subProductId: brush, qty: '1' }],
    });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe('The day end for today is already done on this counter.');
    // A login that names no counter now falls back to the first active one (owner's change on
    // main), so billing is refused only when the shop has no active counter at all.
    await app.deps.db.counter.updateMany({ data: { active: false } });
    const noCounterPc = new Client(app);
    await login(noCounterPc, 'admin');
    const noCounter = await noCounterPc.post('/api/sales', {
      lines: [{ kind: 'BATCH', subProductId: brush, qty: '1' }],
    });
    expect(noCounter.status).toBe(409);
    expect(noCounter.body.error.details.needCounter).toBe(true);
  });

  it('invoice numbers have no gaps when a bill fails', async () => {
    const fail = await shop.cashier.post('/api/sales', {
      lines: [{ kind: 'BATCH', subProductId: brush, qty: '99' }],
    });
    expect(fail.status).toBe(422);
    expect(fail.body.error.field).toBe('lines.0.qty');
    const ok = await shop.cashier.post('/api/sales', {
      lines: [{ kind: 'BATCH', subProductId: brush, qty: '1' }],
    });
    expect(ok.body.no).toBe('INV-000001');
    const status = (await shop.cashier.get('/api/billing/status')).body;
    expect(status.nextNumbers.INVOICE).toBe('INV-000002');
    expect(status.today).toEqual({ total: '450', bills: 1 });
  });
});

describe('discounts and prices', () => {
  it('a line gets at most its batch purchase discount and never sells below cost', async () => {
    const line = (value: string) => [
      { kind: 'BATCH', subProductId: thinner, qty: '1', discount: { type: 'AMOUNT', value } },
    ];
    expect((await shop.cashier.post('/api/sales', { lines: line('260') })).status).toBe(200);
    const over = await shop.cashier.post('/api/sales', { lines: line('261') });
    expect(over.status).toBe(422);
    expect(over.body.error).toMatchObject({
      code: 'DISCOUNT_ABOVE_LIMIT',
      field: 'lines.0.discount',
    });
    const pct = await shop.cashier.post('/api/sales', {
      lines: [
        {
          kind: 'BATCH',
          subProductId: thinner,
          qty: '1',
          discount: { type: 'PERCENT', value: '5' },
        },
      ],
    });
    expect(pct.body.netTotal).toBe('2470.00');
  });

  it('wholesale bills take the W-price with no extra discount', async () => {
    const r = await shop.cashier.post('/api/sales', {
      wholesale: true,
      lines: [
        {
          kind: 'BATCH',
          subProductId: thinner,
          qty: '2',
          discount: { type: 'AMOUNT', value: '100' },
        },
      ],
    });
    // W-price defaulted to the sales price at purchase: 2,600 − 150.
    expect(r.body.netTotal).toBe('4900.00');
    const sale = (await shop.cashier.get(`/api/sales/${r.body.id}`)).body;
    expect(sale.wholesale).toBe(true);
    expect(sale.lines[0]).toMatchObject({ unitPrice: '2450.00', discountPerUnit: '0.00' });
  });

  it('pieces are whole numbers', async () => {
    const r = await shop.cashier.post('/api/sales', {
      lines: [{ kind: 'BATCH', subProductId: brush, qty: '1.5' }],
    });
    expect(r.status).toBe(400);
  });
});

describe('loose paint', () => {
  it('changing the price per liter needs an Admin PIN and never goes below the average cost', async () => {
    const line = (p: string) => [
      { kind: 'LOOSE', productId: cat.emulsion, liters: '1', pricePerLiter: p },
    ];
    const noPin = await shop.cashier.post('/api/sales', { lines: line('600') });
    expect(noPin.body.error.code).toBe('APPROVAL_REQUIRED');
    const stockPin = await shop.cashier.post('/api/sales', {
      lines: line('600'),
      approval: { pin: PINS.stock },
    });
    expect(stockPin.body.error.code).toBe('APPROVAL_REQUIRED');
    const below = await shop.cashier.post('/api/sales', {
      lines: line('400'),
      approval: { pin: PINS.admin },
    });
    expect(below.body.error).toMatchObject({ code: 'BELOW_COST', field: 'lines.0.pricePerLiter' });
    const ok = await shop.cashier.post('/api/sales', {
      lines: line('600'),
      approval: { pin: PINS.admin },
    });
    expect(ok.body.netTotal).toBe('600.00');
    const sale = (await shop.cashier.get(`/api/sales/${ok.body.id}`)).body;
    expect(sale.lines[0].priceApprover).toBe('Admin');
  });

  it('cannot sell more liters than the mix paint holds; a can must be opened first', async () => {
    const r = await shop.cashier.post('/api/sales', {
      lines: [{ kind: 'LOOSE', productId: cat.emulsion, liters: '5' }],
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
    const open = await shop.cashier.post('/api/mix-paint/transfers', {
      sourceSubProductId: emulsionCan,
      cans: 1,
      approval: { pin: PINS.stock },
    });
    expect(open.body.litersHere).toBe('8.000');
    expect(
      (
        await shop.cashier.post('/api/sales', {
          lines: [{ kind: 'LOOSE', productId: cat.emulsion, liters: '5' }],
        })
      ).status,
    ).toBe(200);
  });
});

describe('two counters', () => {
  it("can't sell the last can twice", async () => {
    const reason = await valueId(shop.admin, 'reasons', 'Damaged');
    await shop.admin.post('/api/adjustments', {
      lines: [{ subProductId: brush, qty: '-9', reasonId: reason }],
    });
    const bill = { lines: [{ kind: 'BATCH', subProductId: brush, qty: '1' }] };
    const [a, b] = await Promise.all([
      shop.cashier.post('/api/sales', bill),
      shop.cashier2.post('/api/sales', bill),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 422]);
    expect(await stockOf(brush)).toEqual({});
  });
});

describe('quotations', () => {
  it('F4 issues a quotation with no stock change and a validity date', async () => {
    const q = await shop.cashier.post('/api/sales', {
      kind: 'QUOTATION',
      lines: mockupLines(),
      customerName: 'Kamal',
    });
    expect(q.status).toBe(200);
    expect(q.body.no).toBe('QT-000001');
    expect(q.body.validUntil).toBeTruthy();
    expect(await stockOf(thinner)).toEqual({ Shop: '10.000' });
  });

  it('converting re-checks stock and holds the quoted price until the validity date', async () => {
    const q = await shop.cashier.post('/api/sales', {
      kind: 'QUOTATION',
      lines: [{ kind: 'BATCH', subProductId: thinner, qty: '2' }],
    });
    expect(q.body.netTotal).toBe('4900.00');
    await shop.admin.post(`/api/products/${cat.thinner}/prices`, {
      rPrice: '2800',
      salesDiscount: { type: 'AMOUNT', value: '150' },
      wPrice: '2500',
    });
    const inv = await shop.cashier.post(`/api/sales/${q.body.id}/convert`, { cashGiven: '5000' });
    expect(inv.status).toBe(200);
    expect(inv.body).toMatchObject({ no: 'INV-000001', netTotal: '4900.00', change: '100.00' });
    expect(await stockOf(thinner)).toEqual({ Shop: '8.000' });
    const again = await shop.cashier.post(`/api/sales/${q.body.id}/convert`, {});
    expect(again.status).toBe(409);
    const list = (await shop.cashier.get('/api/sales?kind=QUOTATION')).body.items;
    expect(list[0].convertedTo).toBe('INV-000001');
  });
});

describe('hold and recall', () => {
  it('F7 parks a bill without reserving stock and F8 brings it back', async () => {
    const held = await shop.cashier.post('/api/sales/hold', {
      lines: mockupLines(),
      customerName: 'Nimal',
    });
    expect(held.status).toBe(200);
    expect(await stockOf(thinner)).toEqual({ Shop: '10.000' });
    const list = (await shop.cashier2.get('/api/sales/held')).body.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ customerName: 'Nimal', netTotal: '6325.00' });
    expect(list[0].lines[1]).toEqual({
      kind: 'LOOSE',
      productId: cat.emulsion,
      liters: '1.500',
      pricePerLiter: null,
    });
    const paid = await shop.cashier.post('/api/sales', {
      lines: list[0].lines,
      heldSaleId: list[0].id,
      cashGiven: '6325',
    });
    expect(paid.status).toBe(200);
    expect((await shop.cashier.get('/api/sales/held')).body.items).toEqual([]);
  });
});

describe('void and reprint', () => {
  it('void needs a reason and an Admin PIN, stays visible stamped VOID and returns the stock', async () => {
    const sale = await shop.cashier.post('/api/sales', { lines: mockupLines() });
    const reason = await valueId(shop.cashier, 'reasons', 'Wrong entry');
    const noPin = await shop.cashier.post(`/api/sales/${sale.body.id}/void`, { reasonId: reason });
    expect(noPin.body.error.code).toBe('APPROVAL_REQUIRED');
    const ok = await shop.cashier.post(`/api/sales/${sale.body.id}/void`, {
      reasonId: reason,
      approval: { pin: PINS.admin },
    });
    expect(ok.status).toBe(200);
    const detail = (await shop.cashier.get(`/api/sales/${sale.body.id}`)).body;
    expect(detail.status).toBe('VOID');
    expect(detail.void).toMatchObject({ by: 'Cashier', approver: 'Admin', reason: 'Wrong entry' });
    expect(await stockOf(thinner)).toEqual({ Shop: '10.000' });
    expect(
      (
        await shop.cashier.post(`/api/sales/${sale.body.id}/void`, {
          reasonId: reason,
          approval: { pin: PINS.admin },
        })
      ).status,
    ).toBe(409);
  });

  it('only today’s bills can be voided', async () => {
    const sale = await shop.cashier.post('/api/sales', {
      lines: [{ kind: 'BATCH', subProductId: brush, qty: '1' }],
    });
    await app.deps.db.sale.update({
      where: { id: sale.body.id },
      data: { completedAt: new Date(Date.now() - 2 * 86_400_000) },
    });
    const reason = await valueId(shop.cashier, 'reasons', 'Wrong entry');
    const r = await shop.admin.post(`/api/sales/${sale.body.id}/void`, { reasonId: reason });
    expect(r.status).toBe(409);
  });

  it('reprints are numbered from #2 and logged', async () => {
    const sale = await shop.cashier.post('/api/sales', {
      lines: [{ kind: 'BATCH', subProductId: brush, qty: '1' }],
    });
    expect((await shop.cashier.post(`/api/sales/${sale.body.id}/reprint`)).body.copyNo).toBe(2);
    expect((await shop.cashier.post(`/api/sales/${sale.body.id}/reprint`)).body.copyNo).toBe(3);
    const detail = (await shop.cashier.get(`/api/sales/${sale.body.id}`)).body;
    expect(detail.reprints.map((r: { copyNo: number }) => r.copyNo)).toEqual([2, 3]);
    const log = (await shop.sa.get(`/api/audit-log?action=sale.reprint&entityId=${sale.body.id}`))
      .body;
    expect(log.total).toBe(2);
  });
});

describe('bill history', () => {
  it('finds bills by any part of the number, customer and amount', async () => {
    await shop.cashier.post('/api/sales', {
      lines: [{ kind: 'BATCH', subProductId: brush, qty: '1' }],
      customerName: 'Ruwan',
    });
    await shop.cashier.post('/api/sales', {
      lines: [{ kind: 'BATCH', subProductId: brush, qty: '2' }],
    });
    const byNo = (await shop.cashier.get('/api/sales?q=0002')).body.items;
    expect(byNo.map((s: { no: string }) => s.no)).toEqual(['INV-000002']);
    const byCustomer = (await shop.cashier.get('/api/sales?customer=ruw')).body.items;
    expect(byCustomer.map((s: { no: string }) => s.no)).toEqual(['INV-000001']);
    const byAmount = (await shop.cashier.get('/api/sales?amount=900')).body.items;
    expect(byAmount.map((s: { no: string }) => s.no)).toEqual(['INV-000002']);
    const customers = (await shop.cashier.get('/api/billing/customers?q=ru')).body.items;
    expect(customers.map((c: { name: string }) => c.name)).toEqual(['Ruwan']);
  });
});

describe('renaming a product', () => {
  it('old bills show the new code and name, and the Super Admin sees what changed', async () => {
    const sale = await shop.cashier.post('/api/sales', { lines: mockupLines(), cashGiven: '7000' });
    expect(sale.status).toBe(200);
    const p = (await shop.stock.get(`/api/products/${cat.thinner}`)).body.product;
    const body = {
      name: 'Thinner Extra 4L',
      code: '30001',
      unitId: p.unit.id,
      packSize: p.packSize,
      categoryId: p.category?.id,
      brandId: p.brand?.id,
      confirmCodeChange: true,
    };
    expect((await shop.stock.put(`/api/products/${cat.thinner}`, body)).status).toBe(200);
    const bill = (await shop.cashier.get(`/api/sales/${sale.body.id}`)).body;
    const line = bill.lines.find((l: { subProductId: string }) => l.subProductId === thinner);
    expect(line).toMatchObject({ code: '30001-01', name: 'Thinner Extra 4L' });
    // Totals never change.
    expect(bill.netTotal).toBe('6325.00');

    const history = await shop.sa.get(`/api/products/${cat.thinner}/renames`);
    expect(history.status).toBe(200);
    expect(history.body.items[0].changes).toEqual(
      expect.arrayContaining([
        { field: 'code', from: p.code, to: '30001' },
        { field: 'name', from: p.name, to: 'Thinner Extra 4L' },
      ]),
    );
    expect(history.body.items[0].note).toMatch(/1 line on old bills/);
    expect((await shop.admin.get(`/api/products/${cat.thinner}/renames`)).status).toBe(403);
  });
});

describe('returns', () => {
  it('refunds what was paid after the line discount and restocks the same batch', async () => {
    const sale = await shop.cashier.post('/api/sales', { lines: mockupLines(), cashGiven: '7000' });
    const detail = (await shop.cashier.get(`/api/sales/${sale.body.id}`)).body;
    const reason = await valueId(shop.cashier, 'reasons', 'Customer changed mind');
    const r = await shop.cashier.post('/api/returns', {
      saleId: sale.body.id,
      lines: [
        { saleLineId: detail.lines[0].id, qty: '1', reasonId: reason, disposition: 'RESTOCK' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ no: 'SR-000001', refundTotal: '2450.00' });
    expect(await stockOf(thinner)).toEqual({ Shop: '9.000' });
    const after = (await shop.cashier.get(`/api/sales/${sale.body.id}`)).body;
    expect(after.lines[0]).toMatchObject({ returnedQty: '1.000', returnableQty: '1.000' });
    expect(after.refundedTotal).toBe('2450.00');
    const over = await shop.cashier.post('/api/returns', {
      saleId: sale.body.id,
      lines: [
        { saleLineId: detail.lines[0].id, qty: '2', reasonId: reason, disposition: 'RESTOCK' },
      ],
    });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toMatch(/Only 1 can be returned/);
  });

  it('damaged units go to the Damaged location; loose paint cannot be returned', async () => {
    const sale = await shop.cashier.post('/api/sales', { lines: mockupLines(), cashGiven: '7000' });
    const detail = (await shop.cashier.get(`/api/sales/${sale.body.id}`)).body;
    const reason = await valueId(shop.cashier, 'reasons', 'Damaged');
    const dmg = await shop.cashier.post('/api/returns', {
      saleId: sale.body.id,
      lines: [
        { saleLineId: detail.lines[2].id, qty: '1', reasonId: reason, disposition: 'DAMAGED' },
      ],
    });
    expect(dmg.status).toBe(200);
    expect(await stockOf(brush)).toEqual({ Shop: '9.000', Damaged: '1.000' });
    const loose = await shop.cashier.post('/api/returns', {
      saleId: sale.body.id,
      lines: [
        { saleLineId: detail.lines[1].id, qty: '1', reasonId: reason, disposition: 'RESTOCK' },
      ],
    });
    expect(loose.status).toBe(400);
    expect(loose.body.error.message).toMatch(/Loose/);
  });

  it('a hidden zero-stock sub-product reappears when its units come back', async () => {
    const sale = await shop.cashier.post('/api/sales', {
      lines: [{ kind: 'BATCH', subProductId: brush, qty: '10' }],
    });
    expect((await subProducts(shop, cat.brush))[0]!.hidden).toBe(true);
    const detail = (await shop.cashier.get(`/api/sales/${sale.body.id}`)).body;
    const reason = await valueId(shop.cashier, 'reasons', 'Wrong item');
    await shop.cashier.post('/api/returns', {
      saleId: sale.body.id,
      lines: [
        { saleLineId: detail.lines[0].id, qty: '2', reasonId: reason, disposition: 'RESTOCK' },
      ],
    });
    expect((await subProducts(shop, cat.brush))[0]!.hidden).toBe(false);
  });

  it('old-system bills without an invoice are Admin only', async () => {
    const reason = await valueId(shop.cashier, 'reasons', 'Damaged');
    const body = {
      oldBillRef: 'OLD-4471',
      lines: [
        { subProductId: brush, qty: '1', refund: '400', reasonId: reason, disposition: 'RESTOCK' },
      ],
    };
    expect((await shop.cashier.post('/api/returns', body)).body.error.code).toBe(
      'APPROVAL_REQUIRED',
    );
    const ok = await shop.cashier.post('/api/returns', { ...body, approval: { pin: PINS.admin } });
    expect(ok.body.refundTotal).toBe('400.00');
    expect(await stockOf(brush)).toEqual({ Shop: '11.000' });
  });
});

describe('day end', () => {
  it('expects float + sales − refunds + cash in − cash out and records the counted difference', async () => {
    const sale = await shop.cashier.post('/api/sales', { lines: mockupLines(), cashGiven: '7000' });
    const detail = (await shop.cashier.get(`/api/sales/${sale.body.id}`)).body;
    const ret = await valueId(shop.cashier, 'reasons', 'Customer changed mind');
    await shop.cashier.post('/api/returns', {
      saleId: sale.body.id,
      lines: [{ saleLineId: detail.lines[2].id, qty: '1', reasonId: ret, disposition: 'RESTOCK' }],
    });
    const petty = await valueId(shop.cashier, 'reasons', 'Petty expense');
    const out = await shop.cashier.post('/api/shifts/current/cash', {
      kind: 'OUT',
      amount: '200',
      reasonId: petty,
      note: 'Tea',
    });
    expect(out.status).toBe(200);
    const current = (await shop.cashier.get('/api/shifts/current')).body.shift;
    // 5,000 + 6,325 − 450 − 200
    expect(current).toMatchObject({
      cashSales: '6325.00',
      cashRefunds: '450.00',
      cashOut: '200.00',
      expectedCash: '10675.00',
    });
    const close = await shop.cashier.post('/api/shifts/current/close', {
      denominations: { '5000': 2, '500': 1, '100': 1, '50': 1, '20': 1 },
    });
    expect(close.status).toBe(200);
    expect(close.body.summary).toMatchObject({
      status: 'CLOSED',
      countedCash: '10670.00',
      difference: '-5.00',
    });
    expect(close.body.summary.no).toMatch(/^DE-\d{8}-C1$/);
    // The day-end backup runs right after.
    await app.deps.backups.close();
    const backups = (await shop.sa.get('/api/backups')).body.items;
    expect(backups[0]).toMatchObject({ kind: 'DAY_END', status: 'OK' });
    // One day end per counter per day.
    expect((await shop.cashier.post('/api/shifts/open', { openingFloat: '0' })).status).toBe(409);
  });

  it("cashiers see their own counter's day; Admins see every counter", async () => {
    expect(
      (await shop.cashier.get('/api/shifts')).body.items.map(
        (s: { counter: { code: string } }) => s.counter.code,
      ),
    ).toEqual(['C1']);
    expect(
      (await shop.admin.get('/api/shifts')).body.items
        .map((s: { counter: { code: string } }) => s.counter.code)
        .sort(),
    ).toEqual(['C1', 'C2']);
  });
});

describe('billing lookup', () => {
  it('returns in-stock batches oldest first with the discount cap but no cost', async () => {
    await postGrn(shop, cat.supplierB, [{ productId: cat.thinner, value: '2700', qty: '3' }]);
    const items = (await shop.cashier.get('/api/billing/items?q=thinner')).body.items;
    const t = items.find((i: { name: string }) => i.name === 'Thinner 4L');
    expect(
      t.batches.map((b: { code: string; maxDiscount: string }) => [b.code, b.maxDiscount]),
    ).toEqual([
      ['10001-01', '260.00'],
      ['10001-02', '0.00'],
    ]);
    expect(t.batches[0].costPrice).toBeUndefined();
    expect(t.stockHere).toBe('13.000');
    const emulsionHits = (await shop.cashier.get('/api/billing/items?q=emulsion')).body.items;
    const emulsion = emulsionHits.find((i: { code: string }) => i.code === '10002');
    expect(emulsion.allowLooseSale).toBe(true);
    expect(emulsion.mix).toMatchObject({
      code: 'MP-10002',
      litersHere: '4.000',
      pricePerLiter: '650.00',
    });
    // Since the owner's change on main, the mix paint item is also listed on its own, sold by the
    // liter from its MP code, still without cost.
    const mixItem = emulsionHits.find((i: { code: string }) => i.code === 'MP-10002');
    expect(mixItem.name).toBe('White Emulsion (Mix Paint)');
    expect(mixItem.batches.map((b: { code: string }) => b.code)).toEqual(['MP-10002']);
    expect(mixItem.batches[0].costPrice).toBeUndefined();
    const bySub = (await shop.cashier.get('/api/billing/items?q=10001-02')).body.items[0];
    expect(bySub.matchedSubProductId).toBe(t.batches[1].id);
  });
});

describe('sync outbox', () => {
  it('captures the bill, its lines and the stock moves in the same transaction', async () => {
    await shop.cashier.post('/api/sales', { lines: mockupLines() });
    const tables = await app.deps.db.syncOutbox.groupBy({ by: ['tableName'], _count: true });
    const names = tables.map((t) => t.tableName);
    expect(names).toEqual(
      expect.arrayContaining([
        'sales',
        'sale_lines',
        'stock_movements',
        'stock_balances',
        'audit_logs',
      ]),
    );
    expect(names).not.toContain('sessions');
  });
});
