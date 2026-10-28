import { readFile, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findPgTool } from '../src/core/pgtools';
import { createTestApp, PASSWORD, setupShop, type Shop } from './helpers';
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
afterEach(async () => {
  if (app.deps.testMode.isOn()) await app.deps.testMode.turnOff({ userId: shop.ids.admin! });
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

const stockOf = async (subId: string) =>
  (await shop.sa.get(`/api/sub-products/${subId}/stock`)).body.items[0]?.qty;

describe('test mode', () => {
  it('works on a copy with TEST receipts, then goes back to the real data where it stopped', async () => {
    // Only the Super Admin turns it on, and only with the password again.
    expect((await shop.admin.post('/api/test-mode/on', { password: PASSWORD })).status).toBe(403);
    expect((await shop.sa.post('/api/test-mode/on', { password: 'nope' })).status).toBe(401);
    const on = await shop.sa.post('/api/test-mode/on', { password: PASSWORD });
    expect(on.status).toBe(200);
    expect(on.body.on).toBe(true);
    expect((await shop.cashier.get('/api/test-mode')).body).toMatchObject({
      on: true,
      byName: 'Owner',
    });

    // Billing works as normal, but the number and the slip say TEST and the drawer stays shut.
    const sale = await shop.cashier.post('/api/sales', {
      lines: [{ kind: 'BATCH', subProductId: thinner, qty: '2' }],
      cashGiven: '6000',
    });
    expect(sale.status).toBe(200);
    expect(sale.body.no).toBe('TEST-INV-000001');
    const txt = await readFile(`${dir}/TEST-INV-000001.txt`, 'utf8');
    expect(txt).toContain('TEST MODE - NOT A REAL BILL');
    const c1 = await app.deps.db.counter.findUniqueOrThrow({ where: { code: 'C1' } });
    expect(app.deps.printer.lastJobs.get(c1.id)!.includes(DRAWER_KICK)).toBe(false);
    expect(await stockOf(thinner)).toBe('8.000');
    // Backups pause: the real data isn't changing.
    expect((await shop.sa.post('/api/backups', {})).status).toBe(409);

    const off = await shop.sa.post('/api/test-mode/off', {});
    expect(off.status).toBe(200);
    expect(off.body.on).toBe(false);
    // Nothing from the test is in the real data, and the next real bill takes the next real number.
    expect(await stockOf(thinner)).toBe('10.000');
    expect(await app.deps.db.sale.count()).toBe(0);
    const real = await shop.cashier.post('/api/sales', {
      lines: [{ kind: 'BATCH', subProductId: thinner, qty: '1' }],
      cashGiven: '3000',
    });
    expect(real.body.no).toBe('INV-000001');
    // The switch itself is kept in the real activity log, with what was done meanwhile.
    const log = await app.deps.db.auditLog.findMany({
      where: { action: { startsWith: 'testmode.' } },
      orderBy: { at: 'asc' },
    });
    expect(log.map((l) => l.action)).toEqual(['testmode.on', 'testmode.off']);
    expect(log[1]!.after).toMatchObject({ testBills: 1, testSales: '5,200.00' });
  }, 60_000);

  it('is a plain switch: it stays on, even after a restart, until the Super Admin turns it off', async () => {
    await app.deps.testMode.turnOn({ userId: shop.ids.admin!, name: 'Owner' });
    // A restarted server carries on in test mode, on the copy.
    const again = await createTestApp();
    try {
      expect(again.deps.testMode.isOn()).toBe(true);
      const [row] = await again.deps.db.$queryRaw<
        { db: string }[]
      >`SELECT current_database() AS db`;
      expect(row!.db).toMatch(/_testmode$/);
    } finally {
      await again.close();
    }
    expect(app.deps.testMode.isOn()).toBe(true);
    await app.deps.testMode.turnOff({ userId: shop.ids.admin! });
    expect(app.deps.testMode.isOn()).toBe(false);
    const [row] = await app.deps.db.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    expect(row!.db).not.toMatch(/_testmode$/);
  }, 60_000);

  it('finds pg_dump in the usual install folder, and says plainly what to set when it is missing', async () => {
    // A Windows install doesn't put PostgreSQL on PATH; the install folder is searched too.
    const path = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(findPgTool('pg_dump', '')).toMatch(/postgresql\/\d+\/bin\/pg_dump$/);
    } finally {
      process.env.PATH = path;
    }
    expect(findPgTool('pg_dump', '/no/such/folder')).toBeNull();

    const broken = await createTestApp({ pgBinDir: '/no/such/folder' });
    try {
      const r = await broken.inject({
        method: 'POST',
        url: '/api/test-mode/on',
        payload: { password: PASSWORD },
        headers: { cookie: shop.sa.cookie },
      });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.message).toBe(
        "PostgreSQL's pg_dump is not in PG_BIN_DIR (/no/such/folder). Check that folder in apps/server/.env and restart the server.",
      );
      expect(broken.deps.testMode.isOn()).toBe(false);
    } finally {
      await broken.close();
    }
  }, 60_000);
});
