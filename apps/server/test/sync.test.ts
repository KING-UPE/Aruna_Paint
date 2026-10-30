import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dropDatabase } from '../src/db';
import { withShopData } from '../src/core/dbscope';
import type { SyncTransport } from '../src/core/syncagent';
import {
  Client,
  createTestApp,
  PASSWORD,
  resetDb,
  setupShop,
  TEST_URL,
  type Shop,
} from './helpers';
import { createCatalog, type Catalog } from './fixtures';

const KEY = 'test-sync-key-0123456789';
const dbUrl = (suffix: string) => {
  const u = new URL(TEST_URL);
  u.pathname = `${u.pathname}${suffix}`;
  return u.toString();
};
const cloudUrl = dbUrl('_cloud');
const branchUrl = dbUrl('_branch');

let shopA: FastifyInstance;
let shopB: FastifyInstance;
let cloudApp: FastifyInstance;
let a: Shop;
let b: Shop;
let cat: Catalog;
/** The owner (Super Admin) on the online panel, looking at shop A. */
let owner: Client;

/** A shop server reaches the cloud app in-process, as it would over HTTPS. */
const to =
  (app: FastifyInstance): SyncTransport =>
  async (method, path, body, auth) => {
    const r = await app.inject({
      method,
      url: path,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { authorization: `Bearer ${auth.key}`, 'x-sync-node': auth.node },
    });
    return { status: r.statusCode, body: r.body ? (JSON.parse(r.body) as unknown) : null };
  };
const sync = (app: FastifyInstance) => app.deps.sync!.sync();
const nodeId = async (app: FastifyInstance) =>
  (
    (await app.deps.db.syncState.findUniqueOrThrow({ where: { key: 'node' } })).value as {
      id: string;
    }
  ).id;

/** Signs in to the online panel for one shop. */
async function online(username: string, shop: FastifyInstance) {
  const c = new Client(cloudApp);
  const r = await c.post('/api/auth/login', {
    username,
    password: PASSWORD,
    shopId: await nodeId(shop),
  });
  return { c, status: r.status, body: r.body };
}

/** Reads one shop's copy in the cloud directly. */
async function cloudCopy<T>(
  shop: FastifyInstance,
  fn: (db: FastifyInstance['deps']['db']) => Promise<T>,
) {
  const id = await nodeId(shop);
  await cloudApp.deps.shops!.open(id);
  return withShopData(id, () => fn(cloudApp.deps.db));
}

async function freshDb(url: string) {
  const admin = new URL(url);
  const name = admin.pathname.slice(1);
  admin.pathname = '/postgres';
  const pg = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
  await dropDatabase(pg, name);
  await pg.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  await pg.$disconnect();
  execSync('npx prisma migrate deploy', {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

async function link(app: FastifyInstance, shopKey = KEY) {
  await app.deps.db.setting.upsert({
    where: { key: 'cloud' },
    create: { key: 'cloud', value: { url: 'https://cloud.example', shopKey } },
    update: { value: { url: 'https://cloud.example', shopKey } },
  });
  app.deps.settings.invalidate();
}

beforeAll(async () => {
  await freshDb(cloudUrl);
  await freshDb(branchUrl);
  cloudApp = await createTestApp({ databaseUrl: cloudUrl, mode: 'cloud', syncKey: KEY });
  shopA = await createTestApp({}, { syncTransport: to(cloudApp) });
  shopB = await createTestApp({ databaseUrl: branchUrl }, { syncTransport: to(cloudApp) });
}, 180_000);

afterAll(async () => {
  await shopA.close();
  await shopB.close();
  await cloudApp.close();
});

beforeEach(async () => {
  await cloudApp.deps.shops!.reset();
  await resetDb(cloudApp);
  a = await setupShop(shopA);
  cat = await createCatalog(a);
  b = await setupShop(shopB);
  const shopSettings = (await b.sa.get('/api/settings')).body.shop;
  await b.sa.put('/api/settings/shop', { ...shopSettings, shopName: 'Aruna Paint Kurunegala' });
  await link(shopA);
  await link(shopB);
  expect((await sync(shopA)).lastError).toBe('');
  expect((await sync(shopB)).lastError).toBe('');
  owner = (await online('owner', shopA)).c;
}, 60_000);

const commands = async (c: Client) => (await c.get('/api/sync/status')).body.commands;

describe('online panel for several shops', () => {
  it('each shop gets its own copy; only those given the online panel can open it', async () => {
    const shops = (await new Client(cloudApp).get('/api/cloud/shops')).body.items;
    expect(shops.map((s: { name: string }) => s.name).sort()).toEqual([
      'Aruna Paint Kurunegala',
      'Pannala Aruna Paint Center',
    ]);
    // Shop A's products are A's; shop B has none.
    const products = (await owner.get('/api/products')).body.items;
    expect(products.map((p: { name: string }) => p.name)).toContain('Thinner 4L');
    const ownerB = (await online('owner', shopB)).c;
    expect((await ownerB.get('/api/products')).body.items).toEqual([]);

    // Cashiers and Stock Managers aren't given it by default; an Admin is.
    expect((await online('cashier', shopA)).status).toBe(403);
    expect((await online('stock', shopA)).status).toBe(403);
    // The Super Admin gives one Stock Manager the online panel, at the shop.
    await a.sa.patch(`/api/users/${a.ids.stock}`, {
      permissionOverrides: [{ permission: 'cloud.access', granted: true }],
    });
    await sync(shopA);
    const stock = await online('stock', shopA);
    expect(stock.status).toBe(200);
    expect((await stock.c.get('/api/products')).status).toBe(200);
  });

  it('Admins only look: the stock as of the last sync, and nothing changes', async () => {
    const admin = await online('admin', shopA);
    expect(admin.status).toBe(200);
    const me = (await admin.c.get('/api/auth/me')).body;
    expect(me.permissions).toContain('products.view');
    expect(me.permissions).not.toContain('products.edit');
    expect(me.permissions).not.toContain('suppliers.edit');
    const view = 'The online panel is view-only. Changes are made at the shop.';
    const r = await admin.c.post(`/api/users/${a.ids.cashier}/reset-password`, {
      password: 'x1234567',
    });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe(view);
    expect((await admin.c.put(`/api/suppliers/${cat.supplierA}`, {})).body.error.message).toBe(
      view,
    );
    // The Admin sees only their shop, with when it last synced.
    const nodes = (await admin.c.get('/api/sync/status')).body.nodes;
    expect(nodes.map((n: { name: string }) => n.name)).toEqual(['Pannala Aruna Paint Center']);
    expect(nodes[0].lastPushAt).toBeTruthy();
    expect((await admin.c.get('/api/system/status')).body.sync.lastSyncedAt).toBeTruthy();
  });

  it('the Super Admin sees every shop, and changes only what an Admin can’t', async () => {
    const nodes = (await owner.get('/api/sync/status')).body.nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes.find((n: { current: boolean }) => n.current).name).toBe(
      'Pannala Aruna Paint Center',
    );
    expect(nodes[0]).toMatchObject({ today: { bills: 0, total: '0.00' } });
    expect(nodes[0].counters.map((c: { code: string }) => c.code)).toEqual(['C1', 'C2']);
    // Billing, stock, products and suppliers stay at the shop.
    const shopOnly = 'This can only be done at the shop.';
    expect((await owner.post('/api/sales', { lines: [] })).body.error.message).toBe(shopOnly);
    expect((await owner.put(`/api/suppliers/${cat.supplierA}`, {})).body.error.message).toBe(
      shopOnly,
    );
    // So do the shop's own link to the cloud, and recovery codes.
    expect((await owner.put('/api/settings/cloud', { url: '', shopKey: '' })).status).toBe(403);
    const anon = new Client(cloudApp);
    expect((await anon.post('/api/auth/recover', { username: 'owner' })).status).toBe(403);
  });

  it('a password and PIN reset online reach that shop only, when it next connects', async () => {
    const id = a.ids.cashier!;
    expect(
      (await owner.post(`/api/users/${id}/reset-password`, { password: 'brandnew123' })).status,
    ).toBe(200);
    expect((await owner.post(`/api/users/${id}/reset-pin`, { pin: '9876' })).status).toBe(200);
    expect((await commands(owner)).map((c: { status: string }) => c.status)).toEqual([
      'PENDING',
      'PENDING',
    ]);
    const login = (app: FastifyInstance) =>
      new Client(app).post('/api/auth/login', { username: 'cashier', password: 'brandnew123' });
    expect((await login(shopA)).status).toBe(401);

    await sync(shopA);
    expect((await login(shopA)).status).toBe(200);
    expect((await shopA.deps.db.user.findUniqueOrThrow({ where: { id } })).pinHmac).toBeTruthy();
    expect((await commands(owner)).map((c: { status: string }) => c.status)).toEqual([
      'APPLIED',
      'APPLIED',
    ]);
    // Shop B is another shop: its cashier is untouched.
    await sync(shopB);
    expect((await login(shopB)).status).toBe(401);
  });

  it('settings changed online apply when the shop connects; changed at both ends, the Super Admin decides', async () => {
    const receipt = (await owner.get('/api/settings')).body.receipt;
    const put = (c: Client, footerEn: string) =>
      c.put('/api/settings/receipt', { ...receipt, footerEn });
    expect((await put(owner, 'Thank you, come again!')).status).toBe(200);
    await sync(shopA);
    expect((await a.sa.get('/api/settings')).body.receipt.footerEn).toBe('Thank you, come again!');

    // Offline, the shop changes the footer, and so does the Super Admin online.
    await link(shopA, 'a-wrong-key');
    await put(a.sa, 'Shop footer');
    await put(owner, 'Online footer');
    expect((await sync(shopA)).online).toBe(false);
    await link(shopA);
    await sync(shopA);
    const [c] = await commands(owner);
    expect(c.status).toBe('CONFLICT');
    expect(c.conflicts[0]).toMatchObject({ table: 'settings', field: 'value' });

    expect(
      (await owner.post(`/api/sync/commands/${c.id}/resolve`, { action: 'APPLY' })).status,
    ).toBe(200);
    await sync(shopA);
    expect((await a.sa.get('/api/settings')).body.receipt.footerEn).toBe('Online footer');
    expect((await commands(owner))[0].status).toBe('APPLIED');
  });

  it('different fields changed at each end are both kept; "Keep shop version" puts the panel back', async () => {
    const id = a.ids.cashier!;
    await link(shopA, 'a-wrong-key');
    // At the shop: a new name. Online: a new PIN, then a different name.
    await a.sa.patch(`/api/users/${id}`, { fullName: 'Nimal Perera' });
    await owner.post(`/api/users/${id}/reset-pin`, { pin: '6543' });
    await owner.patch(`/api/users/${id}`, { fullName: 'Nimal P.' });
    await link(shopA);
    await sync(shopA);
    expect((await shopA.deps.db.user.findUniqueOrThrow({ where: { id } })).fullName).toBe(
      'Nimal Perera',
    );
    const [rename, pin] = await commands(a.sa);
    expect(pin.status).toBe('APPLIED');
    expect(rename.status).toBe('CONFLICT');
    expect(rename.conflicts[0]).toMatchObject({
      field: 'full_name',
      online: 'Nimal P.',
      shop: 'Nimal Perera',
    });

    const r = await a.sa.post(`/api/sync/commands/${rename.id}/resolve`, { action: 'DISCARD' });
    expect(r.body.status).toBe('DISCARDED');
    await sync(shopA);
    expect((await commands(owner))[0].status).toBe('DISCARDED');
    const seen = await cloudCopy(shopA, (db) => db.user.findUniqueOrThrow({ where: { id } }));
    expect(seen.fullName).toBe('Nimal Perera');
  });

  it('an online change that clashes at the shop is not applied, and the panel shows the shop again', async () => {
    const roles = (await a.sa.get('/api/roles')).body.items;
    const cashierRole = roles.find((x: { code: string }) => x.code === 'CASHIER').id;
    const user = {
      username: 'nimal',
      fullName: 'Nimal',
      password: PASSWORD,
      roleIds: [cashierRole],
      mustChangePassword: false,
    };
    await link(shopA, 'a-wrong-key');
    expect((await a.sa.post('/api/users', { ...user, pin: '7777' })).status).toBe(200);
    expect((await owner.post('/api/users', { ...user, pin: '7778' })).status).toBe(200);
    await link(shopA);
    await sync(shopA);
    const [c] = await commands(owner);
    expect(c.status).toBe('FAILED');
    expect(c.message).toMatch(/clashes with something already at the shop/);
    const atShop = await shopA.deps.db.user.findFirstOrThrow({ where: { username: 'nimal' } });
    const nimals = await cloudCopy(shopA, (db) =>
      db.user.findMany({ where: { username: 'nimal' } }),
    );
    expect(nimals.map((u) => u.id)).toEqual([atShop.id]);
  });

  it('putting a user in test mode online reaches the shop', async () => {
    const id = a.ids.cashier!;
    expect((await owner.post(`/api/users/${id}/test-mode`, { on: true })).status).toBe(200);
    expect((await a.cashier.get('/api/auth/me')).body.testMode).toBe(false);
    await sync(shopA);
    expect((await a.cashier.get('/api/auth/me')).body.testMode).toBe(true);
    await shopA.deps.testMode.ready();
    await shopA.deps.testMode.setUser({ userId: null }, id, false);
  }, 60_000);

  it('offline, changes wait at the shop and go up once the cloud answers again', async () => {
    await link(shopA, 'a-wrong-key');
    const s = (await a.sa.get(`/api/suppliers/${cat.supplierB}`)).body;
    await a.sa.put(`/api/suppliers/${cat.supplierB}`, {
      name: s.name,
      phones: s.phones,
      address: 'Changed offline',
      email: s.email,
      creditDays: s.creditDays,
      openingBalance: s.openingBalance,
      active: s.active,
      reps: s.reps,
    });
    const off = await sync(shopA);
    expect(off.online).toBe(false);
    expect(off.lastError).toBe('Wrong shop key. Check Settings → Cloud at the shop.');
    expect(off.waiting).toBeGreaterThan(0);
    await link(shopA);
    expect(await sync(shopA)).toMatchObject({ online: true, waiting: 0, lastError: '' });
    expect((await owner.get(`/api/suppliers/${cat.supplierB}`)).body.address).toBe(
      'Changed offline',
    );
  });

  it('an update brings new migrations to every shop’s copy in the cloud', async () => {
    const id = await nodeId(shopA);
    // A copy made before the last migration: the column is missing and so is the note.
    await cloudCopy(shopA, async (db) => {
      await db.$executeRawUnsafe('ALTER TABLE sync_nodes DROP COLUMN db_name');
      await db.$executeRawUnsafe(
        `UPDATE sync_state SET value = jsonb_set(value, '{names}', (value->'names') - '20261030150000_cloud_shops') WHERE key = 'schema'`,
      );
    });
    // The next start opens it and catches up.
    await cloudApp.deps.shops!.close();
    expect(await cloudApp.deps.shops!.open(id)).toBe(true);
    const [col] = await cloudCopy(
      shopA,
      (db) =>
        db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM information_schema.columns
         WHERE table_name = 'sync_nodes' AND column_name = 'db_name'`,
    );
    expect(col!.n).toBe(1);
    expect((await owner.get('/api/products')).status).toBe(200);
  });
});
