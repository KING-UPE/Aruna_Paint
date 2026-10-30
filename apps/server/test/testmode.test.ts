import { readFile, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTestData } from '../src/core/dbscope';
import { findPgTool } from '../src/core/pgtools';
import { Client, createTestApp, setupShop, type Shop } from './helpers';
import { createCatalog, postGrn, subProducts, type Catalog } from './fixtures';

let app: FastifyInstance;
let shop: Shop;
let cat: Catalog;
let thinner: string;
const dir = '/tmp/aruna-test-receipts-testmode';
const DRAWER_KICK = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  shop = await setupShop(app);
  cat = await createCatalog(shop);
  await postGrn(shop, cat.supplierA, [{ productId: cat.thinner, value: '2600', qty: '10' }]);
  thinner = (await subProducts(shop, cat.thinner))[0]!.id;
  await rm(dir, { recursive: true, force: true });
  await app.deps.db.counter.update({
    where: { code: 'C1' },
    data: { printer: { driver: 'file', path: dir } },
  });
});

const sell = (c: Client, qty: string) =>
  c.post('/api/sales', {
    lines: [{ kind: 'BATCH', subProductId: thinner, qty }],
    cashGiven: '30000',
  });
const realStock = async () =>
  (
    await app.deps.db.stockBalance.findFirstOrThrow({ where: { subProductId: thinner } })
  ).qty.toString();
const testStock = () => withTestData(realStock);
const testMode = (c: Client, userId: string, on: boolean) =>
  c.post(`/api/users/${userId}/test-mode`, { on });

describe('test mode, per user', () => {
  it('a user in test mode works on the copy while everyone else keeps working on the real data', async () => {
    // Only the Super Admin switches accounts, and never a Super Admin.
    expect((await testMode(shop.admin, shop.ids.cashier!, true)).status).toBe(403);
    const owner = await app.deps.db.user.findFirstOrThrow({ where: { username: 'owner' } });
    expect((await testMode(shop.sa, owner.id, true)).status).toBe(409);

    const on = await testMode(shop.sa, shop.ids.cashier!, true);
    expect(on.status).toBe(200);
    expect(on.body.users.map((u: { username: string }) => u.username)).toEqual(['cashier']);
    expect(on.body.copyMadeAt).toBeTruthy();
    expect((await shop.cashier.get('/api/auth/me')).body.testMode).toBe(true);
    expect((await shop.cashier2.get('/api/auth/me')).body.testMode).toBe(false);

    // Cashier 1 tests: TEST number, TEST slip, no drawer kick.
    const test = await sell(shop.cashier, '2');
    expect(test.status).toBe(200);
    expect(test.body.no).toBe('TEST-INV-000001');
    const txt = await readFile(`${dir}/TEST-INV-000001.txt`, 'utf8');
    expect(txt).toContain('TEST MODE - NOT A REAL BILL');
    const c1 = await app.deps.db.counter.findUniqueOrThrow({ where: { code: 'C1' } });
    expect(app.deps.printer.lastJobs.get(c1.id)!.includes(DRAWER_KICK)).toBe(false);

    // At the same time cashier 2 sells for real.
    const real = await sell(shop.cashier2, '1');
    expect(real.body.no).toBe('INV-000001');
    expect(await realStock()).toBe('9');
    expect(await testStock()).toBe('8');
    expect(await app.deps.db.sale.count({ where: { no: { startsWith: 'TEST-' } } })).toBe(0);

    // Back on the real data: the test bill stays out of it, the next number is the next real one.
    const off = await testMode(shop.sa, shop.ids.cashier!, false);
    expect(off.body.users).toEqual([]);
    expect((await sell(shop.cashier, '1')).body.no).toBe('INV-000002');
    expect(await realStock()).toBe('8');
    const log = await app.deps.db.auditLog.findMany({
      where: { action: { startsWith: 'testmode.' } },
      orderBy: { at: 'asc' },
    });
    expect(log.map((l) => l.action)).toEqual(['testmode.user_on', 'testmode.user_off']);
    expect(log[1]!.after).toMatchObject({ testBills: 1, testSales: '5,200.00' });
  }, 60_000);

  it('stays on after a restart until switched off; Refresh starts again from the real data', async () => {
    await testMode(shop.sa, shop.ids.cashier!, true);
    expect((await sell(shop.cashier, '2')).body.no).toBe('TEST-INV-000001');

    // A restarted server keeps the cashier on the same copy.
    const again = await createTestApp();
    try {
      const cashier = new Client(again, shop.cashier.cookie);
      expect((await sell(cashier, '1')).body.no).toBe('TEST-INV-000002');
    } finally {
      await again.close();
    }
    expect(await testStock()).toBe('7');

    await sell(shop.cashier2, '1');
    const r = await shop.sa.post('/api/test-mode/refresh', {});
    expect(r.status).toBe(200);
    // The fresh copy is today's real data: 10 − cashier 2's real sale.
    expect(await testStock()).toBe('9');
    expect((await sell(shop.cashier, '1')).body.no).toBe('TEST-INV-000002');
  }, 60_000);

  it('finds pg_dump for backups in the usual install folder, not only on PATH', () => {
    // A Windows install doesn't put PostgreSQL on PATH; the install folder is searched too.
    const path = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(findPgTool('pg_dump', '')).toMatch(/postgresql\/\d+\/bin\/pg_dump$/);
    } finally {
      process.env.PATH = path;
    }
    expect(findPgTool('pg_dump', '/no/such/folder')).toBeNull();
  });
});
