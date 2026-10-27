import type { FastifyInstance } from 'fastify';
import { D } from '@aruna/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, PINS, setupShop, valueId, type Shop } from './helpers';
import { createCatalog, postGrn, subProducts, TODAY, type Catalog } from './fixtures';

let app: FastifyInstance;
let shop: Shop;
let cat: Catalog;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  shop = await setupShop(app);
  cat = await createCatalog(shop);
});

const worked = (productId: string) => ({
  productId,
  value: '2000',
  qty: '10',
  free: '2',
  discount: { type: 'PERCENT' as const, value: '10' },
  salesDiscount: { type: 'PERCENT' as const, value: '5' },
});

describe('suppliers', () => {
  it('gets the next SUP- code, stores phones in one format and warns on a similar name', async () => {
    const list = (await shop.stock.get('/api/suppliers')).body.items;
    expect(list.map((s: { code: string }) => s.code).sort()).toEqual(['SUP-0001', 'SUP-0002']);
    expect(list.find((s: { name: string }) => s.name === 'Supplier B').phones).toEqual([
      '0777654321',
    ]);
    const dup = await shop.stock.post('/api/suppliers', {
      name: 'supplier  a',
      phones: ['0711111111'],
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.warning).toBe(true);
    const ok = await shop.stock.post('/api/suppliers', {
      name: 'supplier  a',
      phones: ['0711111111'],
      confirmSimilarName: true,
    });
    expect(ok.status).toBe(200);
    expect((await shop.stock.post('/api/suppliers', { name: 'X', phones: ['123'] })).status).toBe(
      400,
    );
  });

  it('search finds suppliers by code, name or phone and shows the balance', async () => {
    const byPhone = (await shop.stock.get('/api/suppliers?q=0777654321')).body.items;
    expect(byPhone.map((s: { name: string }) => s.name)).toEqual(['Supplier B']);
    expect(byPhone[0].balance).toBe('0.00');
  });
});

describe('products', () => {
  it('new items get 5-digit codes and a loose-sale paint gets its mix paint item', async () => {
    const p = (await shop.stock.get(`/api/products/${cat.emulsion}`)).body;
    expect(p.product.code).toBe('10002');
    expect(p.product.mixProduct.code).toBe('MP-10002');
    const mix = (await shop.stock.get(`/api/products/${cat.mixEmulsion}`)).body;
    expect(mix.product.name).toBe('White Emulsion (Mix Paint)');
    expect(mix.product.unit.name).toBe('L');
    expect(mix.subProducts.map((s: { code: string }) => s.code)).toEqual(['MP-10002']);
    expect(mix.feeders.map((f: { code: string }) => f.code)).toEqual(['10002']);
  });

  it('the quick editor changes the product and each sub-product code and name in one save', async () => {
    await postGrn(shop, cat.supplierA, [{ productId: cat.thinner, value: '2600', qty: '2' }]);
    await postGrn(shop, cat.supplierA, [{ productId: cat.thinner, value: '2700', qty: '2' }]);
    const [a, b] = await subProducts(shop, cat.thinner);
    const body = {
      code: '30001',
      name: 'Thinner 4L Extra',
      subProducts: [
        { id: a!.id, code: '30001-01', name: 'Thinner 4L Extra' },
        { id: b!.id, code: 'TH-SPECIAL', name: 'Thinner 4L (old stock)' },
      ],
    };
    // A new main code asks first, as in the full editor.
    expect((await shop.admin.patch(`/api/products/${cat.thinner}/names`, body)).status).toBe(409);
    const r = await shop.admin.patch(`/api/products/${cat.thinner}/names`, {
      ...body,
      confirmCodeChange: true,
    });
    expect(r.status).toBe(200);
    expect(r.body.product).toMatchObject({ code: '30001', name: 'Thinner 4L Extra' });
    // Admins never get cost back.
    expect(r.body.subProducts[0].costPrice).toBeUndefined();
    const subs = await subProducts(shop, cat.thinner);
    expect(subs.map((x) => [x.code, x.name])).toEqual([
      ['30001-01', 'Thinner 4L Extra'],
      ['TH-SPECIAL', 'Thinner 4L (old stock)'],
    ]);
    // A sub code already in use is refused, under that row.
    const dup = await shop.admin.patch(`/api/products/${cat.thinner}/names`, {
      code: '30001',
      name: 'Thinner 4L Extra',
      subProducts: [{ id: b!.id, code: '30001-01', name: 'Thinner 4L (old stock)' }],
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.field).toBe('subProducts.0.code');
    const history = (await shop.sa.get(`/api/products/${cat.thinner}/renames`)).body.items;
    expect(history[0]).toMatchObject({
      subProduct: 'TH-SPECIAL',
      // The new main code had already made it 30001-02.
      changes: [{ field: 'code', from: '30001-02', to: 'TH-SPECIAL' }],
    });
  });

  it('changing a main code renames sub and mix paint codes after a confirmation', async () => {
    await postGrn(shop, cat.supplierA, [{ productId: cat.emulsion, value: '2000', qty: '2' }]);
    const p = (await shop.stock.get(`/api/products/${cat.emulsion}`)).body.product;
    const body = {
      name: p.name,
      code: '20001',
      unitId: p.unit.id,
      packSize: '4',
      allowLooseSale: true,
      categoryId: p.category.id,
      brandId: p.brand.id,
    };
    const ask = await shop.stock.put(`/api/products/${cat.emulsion}`, body);
    expect(ask.status).toBe(409);
    const ok = await shop.stock.put(`/api/products/${cat.emulsion}`, {
      ...body,
      confirmCodeChange: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.subProducts.map((s: { code: string }) => s.code)).toEqual(['20001-01']);
    expect(ok.body.product.mixProduct.code).toBe('MP-20001');
  });

  it('search forgives word order and typos, and finds sub codes', async () => {
    await postGrn(shop, cat.supplierA, [worked(cat.thinner)]);
    const names = async (q: string) =>
      (await shop.stock.get(`/api/products/search?q=${encodeURIComponent(q)}`)).body.items.map(
        (i: { name: string }) => i.name,
      );
    expect(await names('thin 4')).toContain('Thinner 4L');
    expect(await names('4l thinner')).toContain('Thinner 4L');
    expect(await names('thiner')).toContain('Thinner 4L');
    expect(await names('dulux')).toEqual(
      expect.arrayContaining(['Thinner 4L', 'White Emulsion 4L']),
    );
    const sub = (await shop.stock.get('/api/products/search?q=10001-01')).body.items[0];
    expect(sub.name).toBe('Thinner 4L');
    expect(sub.matchedSubProductId).toBeTruthy();
  });
});

describe('purchases (GRN)', () => {
  it('posts the worked example: sub-product 10001-01, 12 in stock, supplier owes Rs 18,000', async () => {
    const grn = await postGrn(shop, cat.supplierA, [worked(cat.thinner)]);
    expect(grn.no).toMatch(/^GRN-\d{4}-00001$/);
    const subs = await subProducts(shop, cat.thinner);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      code: '10001-01',
      totalStock: '12.000',
      rPrice: '2000.00',
      salesPrice: '1900.00',
      actualPrice: '1500.00',
      costPrice: '1800.00',
    });
    const supplier = (await shop.stock.get(`/api/suppliers/${cat.supplierA}`)).body;
    expect(supplier.balance).toBe('18000.00');
  });

  it('reuses a matching sub-product and makes a new code when anything differs', async () => {
    await postGrn(shop, cat.supplierA, [worked(cat.thinner)]);
    await postGrn(shop, cat.supplierA, [worked(cat.thinner)]);
    await postGrn(shop, cat.supplierA, [{ ...worked(cat.thinner), value: '2100' }]);
    await postGrn(shop, cat.supplierB, [worked(cat.thinner)]);
    await postGrn(shop, cat.supplierA, [{ ...worked(cat.thinner), expiryDate: '2030-01-01' }]);
    const subs = await subProducts(shop, cat.thinner);
    expect(subs.map((s) => [s.code, s.totalStock])).toEqual([
      ['10001-01', '24.000'],
      ['10001-02', '12.000'],
      ['10001-03', '12.000'],
      ['10001-04', '12.000'],
    ]);
  });

  it('a matching sub-product at zero stock is reused, and comes back into view', async () => {
    await postGrn(shop, cat.supplierA, [worked(cat.thinner)]);
    const [sub] = await subProducts(shop, cat.thinner);
    const reason = await valueId(shop.admin, 'reasons', 'Damaged');
    const adj = await shop.admin.post('/api/adjustments', {
      lines: [{ subProductId: sub!.id, qty: '-12', reasonId: reason }],
    });
    expect(adj.status).toBe(200);
    expect((await subProducts(shop, cat.thinner))[0]!.hidden).toBe(true);
    await postGrn(shop, cat.supplierA, [worked(cat.thinner)]);
    const subs = await subProducts(shop, cat.thinner);
    expect(subs.map((s) => [s.code, s.totalStock, s.hidden])).toEqual([
      ['10001-01', '12.000', false],
    ]);
  });

  it('boxed items enter stock as pieces at the box cost ÷ pieces', async () => {
    await postGrn(shop, cat.supplierA, [{ productId: cat.sandpaper, value: '1200', qty: '2' }]);
    const [sub] = await subProducts(shop, cat.sandpaper);
    expect(sub).toMatchObject({ totalStock: '24.000', costPrice: '100.00', rPrice: '100.00' });
  });

  it('the supplier invoice total must match within Rs 1, and a repeated invoice no warns', async () => {
    const base = {
      supplierId: cat.supplierA,
      supplierInvoiceNo: 'A-100',
      date: TODAY(),
      lines: [worked(cat.thinner)],
    };
    const bad = await shop.stock.post('/api/purchases', {
      ...base,
      supplierInvoiceTotal: '18002',
      post: true,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.field).toBe('supplierInvoiceTotal');
    const ok = await shop.stock.post('/api/purchases', {
      ...base,
      supplierInvoiceTotal: '18000.50',
      post: true,
    });
    expect(ok.status).toBe(200);
    const dup = await shop.stock.post('/api/purchases', {
      ...base,
      supplierInvoiceTotal: '18000',
      post: true,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.existing).toBe(ok.body.no);
    // The failed attempt rolled back, so its GRN number is free again.
    const confirmed = await shop.stock.post('/api/purchases', {
      ...base,
      supplierInvoiceTotal: '18000',
      post: { confirmDuplicateInvoice: true },
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.no).toMatch(/-00002$/);
  });

  it('refuses a sales price below cost or a W-price outside its range, under the line', async () => {
    const r = await shop.stock.post('/api/purchases', {
      supplierId: cat.supplierA,
      date: TODAY(),
      supplierInvoiceTotal: '18000',
      lines: [{ ...worked(cat.thinner), salesPrice: '1700' }],
      post: true,
    });
    expect(r.status).toBe(422);
    expect(r.body.error.field).toBe('lines.0.salesDiscount');
  });

  it('the sales discount can never be more than the purchase discount, not even on a draft', async () => {
    // Purchase discount 10% of Rs 2,000 = Rs 200; a 12% sales discount is Rs 240.
    const over = {
      ...worked(cat.thinner),
      salesDiscount: { type: 'PERCENT' as const, value: '12' },
    };
    for (const post of [true, undefined]) {
      const r = await shop.stock.post('/api/purchases', {
        supplierId: cat.supplierA,
        date: TODAY(),
        supplierInvoiceTotal: '18000',
        lines: [over],
        post,
      });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('DISCOUNT_ABOVE_LIMIT');
      expect(r.body.error.field).toBe('lines.0.salesDiscount');
      expect(r.body.error.message).toContain('Rs 200.00');
    }
    await postGrn(shop, cat.supplierA, [worked(cat.thinner)]);
    const later = await shop.admin.post(`/api/products/${cat.thinner}/prices`, {
      salesDiscount: { type: 'AMOUNT', value: '201' },
    });
    expect(later.status).toBe(422);
    expect(later.body.error.code).toBe('DISCOUNT_ABOVE_LIMIT');
  });

  it('invoice discount and transport change the supplier balance, never item costs', async () => {
    await postGrn(shop, cat.supplierA, [worked(cat.thinner)], {
      invoiceDiscount: '500',
      otherCharges: '300',
    });
    expect((await subProducts(shop, cat.thinner))[0]!.actualPrice).toBe('1500.00');
    expect((await shop.stock.get(`/api/suppliers/${cat.supplierA}`)).body.balance).toBe('17800.00');
  });

  it('paid now settles this GRN and the rest goes to the supplier balance', async () => {
    const grn = await postGrn(shop, cat.supplierA, [worked(cat.thinner)], {}, { paidNow: '5000' });
    const p = (await shop.stock.get(`/api/purchases/${grn.id}`)).body;
    expect(p.paidAmount).toBe('5000.00');
    expect(p.due).toBe('13000.00');
    expect((await shop.stock.get(`/api/suppliers/${cat.supplierA}`)).body.balance).toBe('13000.00');
  });

  it('drafts change nothing until posted', async () => {
    const r = await shop.stock.post('/api/purchases', {
      supplierId: cat.supplierA,
      date: TODAY(),
      supplierInvoiceTotal: '18000',
      lines: [worked(cat.thinner)],
    });
    expect(r.status).toBe(200);
    expect(await subProducts(shop, cat.thinner)).toEqual([]);
    const posted = await shop.stock.post(`/api/purchases/${r.body.id}/post`, {});
    expect(posted.status).toBe(200);
    expect((await subProducts(shop, cat.thinner))[0]!.totalStock).toBe('12.000');
  });

  it('a posted purchase reopens for editing only while its stock is unmoved', async () => {
    const grn = await postGrn(shop, cat.supplierA, [worked(cat.thinner)]);
    expect((await shop.stock.post(`/api/purchases/${grn.id}/reopen`)).status).toBe(200);
    expect((await subProducts(shop, cat.thinner))[0]!.totalStock).toBe('0.000');
    expect((await shop.stock.get(`/api/suppliers/${cat.supplierA}`)).body.balance).toBe('0.00');
    expect((await shop.stock.post(`/api/purchases/${grn.id}/post`, {})).status).toBe(200);

    const reason = await valueId(shop.admin, 'reasons', 'Damaged');
    const [sub] = await subProducts(shop, cat.thinner);
    await shop.admin.post('/api/adjustments', {
      lines: [{ subProductId: sub!.id, qty: '-1', reasonId: reason }],
    });
    const blocked = await shop.stock.post(`/api/purchases/${grn.id}/reopen`);
    expect(blocked.status).toBe(409);
  });

  it('only an Admin reverses a posted purchase; a Stock Manager needs an Admin PIN', async () => {
    const grn = await postGrn(shop, cat.supplierA, [worked(cat.thinner)]);
    const noPin = await shop.stock.post(`/api/purchases/${grn.id}/reverse`, {
      reason: 'Wrong supplier',
    });
    expect(noPin.status).toBe(403);
    expect(noPin.body.error.code).toBe('APPROVAL_REQUIRED');
    const cashierPin = await shop.stock.post(`/api/purchases/${grn.id}/reverse`, {
      reason: 'Wrong supplier',
      approval: { pin: PINS.cashier },
    });
    expect(cashierPin.body.error.message).toMatch(/can't approve/);
    const ok = await shop.stock.post(`/api/purchases/${grn.id}/reverse`, {
      reason: 'Wrong supplier',
      approval: { pin: PINS.admin },
    });
    expect(ok.status).toBe(200);
    expect((await subProducts(shop, cat.thinner))[0]!.totalStock).toBe('0.000');
    const log = (await shop.sa.get(`/api/audit-log?entityId=${grn.id}&action=purchase.reverse`))
      .body.items[0];
    expect(log.user.fullName).toBe('Stock');
    expect(log.approver.fullName).toBe('Admin');
  });
});

describe('cost privacy', () => {
  it("Stock Managers see each product's cost; Admins and Cashiers don't", async () => {
    const grn = await postGrn(shop, cat.supplierA, [worked(cat.thinner)]);
    const asStock = (await shop.stock.get(`/api/products/${cat.thinner}`)).body.subProducts[0];
    const asAdmin = (await shop.admin.get(`/api/products/${cat.thinner}`)).body.subProducts[0];
    expect(asStock.costPrice).toBe('1800.00');
    expect(asStock.margin).toBe('400.00');
    expect(asAdmin.costPrice).toBeUndefined();
    expect(asAdmin.actualPrice).toBeUndefined();
    expect(asAdmin.margin).toBeUndefined();
    const purchaseAsAdmin = (await shop.admin.get(`/api/purchases/${grn.id}`)).body;
    expect(purchaseAsAdmin.lines[0].cost).toBeUndefined();
    expect(purchaseAsAdmin.lines[0].salesPrice).toBe('1900.00');
    expect((await shop.cashier.get(`/api/products/${cat.thinner}`)).status).toBe(403);
  });
});

describe('supplier payments and activity log', () => {
  it('pays the oldest bills first, warns when paying more than the balance and keeps an advance', async () => {
    const g1 = await postGrn(shop, cat.supplierA, [
      { productId: cat.brush, value: '100', qty: '10' },
    ]);
    const g2 = await postGrn(shop, cat.supplierA, [
      { productId: cat.brush, value: '100', qty: '5' },
    ]);
    const pay = await shop.stock.post('/api/supplier-payments', {
      supplierId: cat.supplierA,
      date: TODAY(),
      method: 'CASH',
      amount: '1200',
    });
    expect(pay.status).toBe(200);
    expect(pay.body.allocations).toEqual([
      { purchaseId: g1.id, amount: '1000.00' },
      { purchaseId: g2.id, amount: '200.00' },
    ]);
    expect(pay.body.balance).toBe('300.00');
    const over = await shop.stock.post('/api/supplier-payments', {
      supplierId: cat.supplierA,
      date: TODAY(),
      method: 'CASH',
      amount: '500',
    });
    expect(over.status).toBe(409);
    expect(over.body.error.details.advance).toBe('200.00');
    const adv = await shop.stock.post('/api/supplier-payments', {
      supplierId: cat.supplierA,
      date: TODAY(),
      method: 'CASH',
      amount: '500',
      confirmAdvance: true,
    });
    expect(adv.body.balance).toBe('-200.00');
  });

  it('cheques go to the register; a bounced cheque puts the amount back', async () => {
    await postGrn(shop, cat.supplierA, [{ productId: cat.brush, value: '100', qty: '10' }]);
    const pay = await shop.stock.post('/api/supplier-payments', {
      supplierId: cat.supplierA,
      date: TODAY(),
      method: 'CHEQUE',
      amount: '1000',
      cheque: { number: '123456', bank: 'BOC', chequeDate: '2030-01-15' },
    });
    expect(pay.status).toBe(200);
    expect(pay.body.balance).toBe('0.00');
    const cheques = (await shop.stock.get('/api/cheques?status=PENDING')).body.items;
    expect(cheques).toHaveLength(1);
    await shop.stock.post(`/api/cheques/${cheques[0].id}/status`, { status: 'BOUNCED' });
    expect((await shop.stock.get(`/api/suppliers/${cat.supplierA}`)).body.balance).toBe('1000.00');
  });

  it('the activity log shows opening, running and closing balances', async () => {
    await shop.stock.put(`/api/suppliers/${cat.supplierA}`, {
      name: 'Supplier A',
      phones: ['0771234567'],
      openingBalance: '500',
    });
    await postGrn(shop, cat.supplierA, [{ productId: cat.brush, value: '100', qty: '10' }]);
    await shop.stock.post('/api/supplier-payments', {
      supplierId: cat.supplierA,
      date: TODAY(),
      method: 'CASH',
      amount: '700',
    });
    const log = (await shop.stock.get(`/api/suppliers/${cat.supplierA}/ledger?from=${TODAY()}`))
      .body;
    expect(log.openingBalance).toBe('500.00');
    expect(log.entries.map((e: { type: string; balance: string }) => [e.type, e.balance])).toEqual([
      ['PURCHASE', '1500.00'],
      ['PAYMENT', '800.00'],
    ]);
    expect(log.closingBalance).toBe('800.00');
    // Once there are entries, the opening balance is fixed.
    const change = await shop.stock.put(`/api/suppliers/${cat.supplierA}`, {
      name: 'Supplier A',
      phones: ['0771234567'],
      openingBalance: '0',
    });
    expect(change.status).toBe(409);
  });
});

describe('mix paint', () => {
  it('follows the plan example: 2 L at Rs 500 plus a 4 L can at Rs 1,800 averages Rs 466.67', async () => {
    await postGrn(shop, cat.supplierA, [{ productId: cat.emulsion, value: '2000', qty: '5' }]);
    const [can1] = await subProducts(shop, cat.emulsion);
    // First can: 4 L at Rs 500 per L, priced at Rs 650 per L.
    const t1 = await shop.stock.post('/api/mix-paint/transfers', {
      sourceSubProductId: can1!.id,
      cans: 1,
      pricePerLiter: '650',
    });
    expect(t1.status).toBe(200);
    expect(t1.body).toMatchObject({
      liters: '4.000',
      newAverageCost: '500.00',
      pricePerLiter: '650.00',
      litersHere: '4.000',
    });
    // Dried paint: 2 L written off as MP wastage (a write-off needs an Admin).
    const wastage = await valueId(shop.stock, 'reasons', 'MP wastage');
    const mixSub = t1.body.mixSubProductId;
    const w = await shop.stock.post('/api/adjustments', {
      lines: [{ subProductId: mixSub, qty: '-2', reasonId: wastage }],
      approval: { pin: PINS.admin },
    });
    expect(w.status).toBe(200);
    // A new batch at Rs 1,800 a can (Rs 450 per L).
    await postGrn(shop, cat.supplierA, [{ productId: cat.emulsion, value: '1800', qty: '2' }]);
    const can2 = (await subProducts(shop, cat.emulsion)).find((s) => s.costPrice === '1800.00')!;
    const t2 = await shop.stock.post('/api/mix-paint/transfers', {
      sourceSubProductId: can2.id,
      cans: 1,
    });
    expect(t2.status).toBe(200);
    expect(t2.body).toMatchObject({
      liters: '4.000',
      newAverageCost: '466.67',
      pricePerLiter: '650.00',
      litersHere: '6.000',
    });
    const status = (await shop.stock.get(`/api/mix-paint/${cat.mixEmulsion}`)).body;
    expect(status).toMatchObject({
      litersHere: '6.000',
      pricePerLiter: '650.00',
      averageCost: '466.67',
    });
    expect(
      (await shop.admin.get(`/api/mix-paint/${cat.mixEmulsion}`)).body.averageCost,
    ).toBeUndefined();
  });

  it('with no price typed, the first can takes its own sales price per liter; an Admin can price the whole can', async () => {
    await postGrn(shop, cat.supplierA, [
      { productId: cat.emulsion, value: '2000', qty: '3', rPrice: '2600' },
    ]);
    const [can] = await subProducts(shop, cat.emulsion);
    const first = await shop.stock.post('/api/mix-paint/transfers', {
      sourceSubProductId: can!.id,
      cans: 1,
    });
    expect(first.status).toBe(200);
    expect(first.body.pricePerLiter).toBe(D(can!.salesPrice).dividedBy(4).toFixed(2));
    // Later cans keep the current price unless a new one is given.
    const kept = await shop.stock.post('/api/mix-paint/transfers', {
      sourceSubProductId: can!.id,
      cans: 1,
    });
    expect(kept.body.pricePerLiter).toBe(first.body.pricePerLiter);
    // A price for the whole 4 L can: Rs 2,800 is Rs 700 per liter.
    const byCan = await shop.stock.post('/api/mix-paint/transfers', {
      sourceProductId: cat.emulsion,
      cans: 1,
      adminCanPrice: '2800',
    });
    expect(byCan.status).toBe(200);
    expect(byCan.body.pricePerLiter).toBe('700.00');
  });

  it('never prices below the new average cost', async () => {
    await postGrn(shop, cat.supplierA, [{ productId: cat.emulsion, value: '2000', qty: '1' }]);
    const [can] = await subProducts(shop, cat.emulsion);
    const r = await shop.stock.post('/api/mix-paint/transfers', {
      sourceSubProductId: can!.id,
      cans: 1,
      pricePerLiter: '450',
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('BELOW_COST');
  });

  it('a cashier opens a can only with a Stock Manager or Admin PIN', async () => {
    await postGrn(shop, cat.supplierA, [{ productId: cat.emulsion, value: '2000', qty: '1' }]);
    const [can] = await subProducts(shop, cat.emulsion);
    const body = { sourceSubProductId: can!.id, cans: 1, pricePerLiter: '650' };
    const noPin = await shop.cashier.post('/api/mix-paint/transfers', body);
    expect(noPin.body.error.code).toBe('APPROVAL_REQUIRED');
    const ok = await shop.cashier.post('/api/mix-paint/transfers', {
      ...body,
      approval: { pin: PINS.stock },
    });
    expect(ok.status).toBe(200);
    const list = (await shop.stock.get('/api/mix-paint/transfers')).body.items;
    expect(list[0]).toMatchObject({ fromCounter: true, by: 'Cashier', approvedBy: 'Stock' });
  });

  it('cannot move more cans than are in stock', async () => {
    await postGrn(shop, cat.supplierA, [{ productId: cat.emulsion, value: '2000', qty: '1' }]);
    const [can] = await subProducts(shop, cat.emulsion);
    const r = await shop.stock.post('/api/mix-paint/transfers', {
      sourceSubProductId: can!.id,
      cans: 2,
      pricePerLiter: '650',
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
  });
});

describe('stock moves', () => {
  it('transfers between locations, never more than the source holds', async () => {
    await postGrn(shop, cat.supplierA, [{ productId: cat.brush, value: '100', qty: '10' }]);
    const store = (
      await shop.sa.post('/api/values/locations', { name: 'Store', code: 'ST', kind: 'WAREHOUSE' })
    ).body.id;
    const [sub] = await subProducts(shop, cat.brush);
    const tooMany = await shop.stock.post('/api/transfers', {
      fromLocationId: shop.ids.shop,
      toLocationId: store,
      lines: [{ subProductId: sub!.id, qty: '11' }],
    });
    expect(tooMany.status).toBe(422);
    const ok = await shop.stock.post('/api/transfers', {
      fromLocationId: shop.ids.shop,
      toLocationId: store,
      lines: [{ subProductId: sub!.id, qty: '4' }],
    });
    expect(ok.body.no).toBe('TR-000001');
    const where = (await shop.stock.get(`/api/sub-products/${sub!.id}/stock`)).body.items;
    expect(where.map((w: { location: string; qty: string }) => [w.location, w.qty]).sort()).toEqual(
      [
        ['Shop', '6.000'],
        ['Store', '4.000'],
      ],
    );
    const same = await shop.stock.post('/api/transfers', {
      fromLocationId: store,
      toLocationId: store,
      lines: [{ subProductId: sub!.id, qty: '1' }],
    });
    expect(same.status).toBe(400);
  });

  it('adding stock needs no approval; write-offs need an Admin', async () => {
    await postGrn(shop, cat.supplierA, [{ productId: cat.brush, value: '100', qty: '10' }]);
    const [sub] = await subProducts(shop, cat.brush);
    const reason = await valueId(shop.stock, 'reasons', 'Count correction');
    expect(
      (
        await shop.stock.post('/api/adjustments', {
          lines: [{ subProductId: sub!.id, qty: '2', reasonId: reason }],
        })
      ).status,
    ).toBe(200);
    const off = await shop.stock.post('/api/adjustments', {
      lines: [{ subProductId: sub!.id, qty: '-1', reasonId: reason }],
    });
    expect(off.body.error.code).toBe('APPROVAL_REQUIRED');
    const petty = await valueId(shop.stock, 'reasons', 'Petty expense');
    const wrongReason = await shop.stock.post('/api/adjustments', {
      lines: [{ subProductId: sub!.id, qty: '1', reasonId: petty }],
    });
    expect(wrongReason.status).toBe(400);
  });

  it('the bin card shows every movement with a running balance', async () => {
    await postGrn(shop, cat.supplierA, [{ productId: cat.brush, value: '100', qty: '10' }]);
    const [sub] = await subProducts(shop, cat.brush);
    const reason = await valueId(shop.stock, 'reasons', 'Count correction');
    await shop.stock.post('/api/adjustments', {
      lines: [{ subProductId: sub!.id, qty: '3', reasonId: reason }],
    });
    const card = (await shop.stock.get(`/api/sub-products/${sub!.id}/bin-card`)).body;
    expect(card.rows.map((r: { type: string; balance: string }) => [r.type, r.balance])).toEqual([
      ['PURCHASE', '10.000'],
      ['ADJUSTMENT', '13.000'],
    ]);
    expect(card.rows[0].unitCost).toBe('100.00');
    expect(
      (await shop.admin.get(`/api/sub-products/${sub!.id}/bin-card`)).body.rows[0].unitCost,
    ).toBeUndefined();
  });

  it('stock can never go below zero, even directly in the database', async () => {
    await postGrn(shop, cat.supplierA, [{ productId: cat.brush, value: '100', qty: '1' }]);
    await expect(app.deps.db.$executeRaw`UPDATE stock_balances SET qty = -1`).rejects.toThrow();
  });
});

describe('prices', () => {
  it('changes one or all sub-products at once with history, never below cost', async () => {
    await postGrn(shop, cat.supplierA, [worked(cat.thinner)]);
    await postGrn(shop, cat.supplierB, [worked(cat.thinner)]);
    const subs = await subProducts(shop, cat.thinner);
    const low = await shop.admin.post(`/api/products/${cat.thinner}/prices`, {
      salesPrice: '1700',
    });
    expect(low.status).toBe(422);
    const ok = await shop.admin.post(`/api/products/${cat.thinner}/prices`, {
      rPrice: '2100',
      salesDiscount: { type: 'AMOUNT', value: '150' },
      wPrice: '1800',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.changed).toHaveLength(2);
    const after = await subProducts(shop, cat.thinner);
    expect(after.map((s) => s.salesPrice)).toEqual(['1950.00', '1950.00']);
    const history = (await shop.admin.get(`/api/sub-products/${subs[0]!.id}/price-history`)).body
      .items;
    expect(history[0].salesPrice).toEqual(['1900.00', '1950.00']);
  });
});

describe('stock view', () => {
  it('filters low stock, out of stock and by supplier', async () => {
    await postGrn(shop, cat.supplierA, [{ productId: cat.thinner, value: '2000', qty: '3' }]);
    await postGrn(shop, cat.supplierB, [{ productId: cat.brush, value: '100', qty: '10' }]);
    const low = (await shop.stock.get('/api/products?lowStock=1')).body.items.map(
      (p: { code: string }) => p.code,
    );
    expect(low).toEqual(['10001']);
    const out = (await shop.stock.get('/api/products?outOfStock=1&type=STANDARD')).body.items.map(
      (p: { code: string }) => p.code,
    );
    expect(out.sort()).toEqual(['10002', '10004']);
    const bySupplier = (
      await shop.stock.get(`/api/products?supplierId=${cat.supplierB}`)
    ).body.items.map((p: { name: string }) => p.name);
    expect(bySupplier).toEqual(['Brush 2 inch']);
  });
});
