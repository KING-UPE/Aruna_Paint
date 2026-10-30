import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SyncTransport } from '../src/core/syncagent';
import {
  Client,
  createTestApp,
  login,
  PASSWORD,
  resetDb,
  setupShop,
  TEST_URL,
  type Shop,
} from './helpers';
import { createCatalog, type Catalog } from './fixtures';

const KEY = 'test-sync-key-0123456789';
const cloudUrl = (() => {
  const u = new URL(TEST_URL);
  u.pathname = `${u.pathname}_cloud`;
  return u.toString();
})();

let shopApp: FastifyInstance;
let cloudApp: FastifyInstance;
let shop: Shop;
let cat: Catalog;
let online: Client;

/** The shop server reaches the cloud app in-process, as it would over HTTPS. */
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
const sync = () => shopApp.deps.sync!.sync();

beforeAll(async () => {
  const admin = new URL(cloudUrl);
  const name = admin.pathname.slice(1);
  admin.pathname = '/postgres';
  const pg = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
  await pg.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await pg.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  await pg.$disconnect();
  execSync('npx prisma migrate deploy', {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: cloudUrl },
    stdio: 'pipe',
  });
  cloudApp = await createTestApp({ databaseUrl: cloudUrl, mode: 'cloud', syncKey: KEY });
  shopApp = await createTestApp({}, { syncTransport: to(cloudApp) });
}, 120_000);

afterAll(async () => {
  await shopApp.close();
  await cloudApp.close();
});

beforeEach(async () => {
  await resetDb(cloudApp);
  shop = await setupShop(shopApp);
  cat = await createCatalog(shop);
  await shopApp.deps.db.setting.upsert({
    where: { key: 'cloud' },
    create: { key: 'cloud', value: { url: 'https://cloud.example', shopKey: KEY } },
    update: { value: { url: 'https://cloud.example', shopKey: KEY } },
  });
  shopApp.deps.settings.invalidate();
  await sync();
  online = new Client(cloudApp);
  await login(online, 'owner');
});

const supplierBody = async (c: Client, id: string) => {
  const s = (await c.get(`/api/suppliers/${id}`)).body;
  return {
    name: s.name,
    phones: s.phones,
    address: s.address,
    email: s.email,
    creditDays: s.creditDays,
    openingBalance: s.openingBalance,
    active: s.active,
    reps: s.reps,
  };
};
const commands = async (c: Client) => (await c.get('/api/sync/status')).body.commands;

describe('shop ⇄ cloud sync', () => {
  it('the first sync fills the cloud; only Admins and the Super Admin use it', async () => {
    const st = await shopApp.deps.sync!.status();
    expect(st).toMatchObject({ linked: true, online: true, waiting: 0, lastError: '' });
    expect(await cloudApp.deps.db.user.count()).toBe(await shopApp.deps.db.user.count());
    const products = (await online.get('/api/products')).body.items;
    expect(products.map((p: { name: string }) => p.name)).toContain('Thinner 4L');

    // Cashiers work at the shop only.
    const cashier = new Client(cloudApp);
    const r = await cashier.post('/api/auth/login', { username: 'cashier', password: PASSWORD });
    expect(r.status).toBe(403);
    // Billing needs the counters.
    expect((await online.post('/api/sales', { lines: [] })).status).toBe(403);

    // Each machine, when it last synced, and its counters.
    const nodes = (await online.get('/api/sync/status')).body.nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ name: 'Pannala Aruna Paint Center', waiting: 0 });
    expect(nodes[0].lastPushAt).toBeTruthy();
    expect(nodes[0].counters.map((c: { code: string }) => c.code)).toEqual(['C1', 'C2']);
  });

  it('a password and PIN reset online reach the shop at the next sync', async () => {
    const id = shop.ids.cashier!;
    expect(
      (await online.post(`/api/users/${id}/reset-password`, { password: 'brandnew123' })).status,
    ).toBe(200);
    expect((await online.post(`/api/users/${id}/reset-pin`, { pin: '9876' })).status).toBe(200);
    const waiting = await commands(online);
    expect(waiting.map((c: { status: string }) => c.status)).toEqual(['PENDING', 'PENDING']);
    expect(waiting[1].summary).toBe('user.reset_password');

    // Not yet at the shop.
    const before = new Client(shopApp);
    expect(
      (await before.post('/api/auth/login', { username: 'cashier', password: 'brandnew123' }))
        .status,
    ).toBe(401);

    await sync();
    const after = new Client(shopApp);
    expect(
      (await after.post('/api/auth/login', { username: 'cashier', password: 'brandnew123' }))
        .status,
    ).toBe(200);
    const pinShop = (await shopApp.deps.db.user.findUniqueOrThrow({ where: { id } })).pinHmac;
    const pinCloud = (await cloudApp.deps.db.user.findUniqueOrThrow({ where: { id } })).pinHmac;
    expect(pinShop).toBe(pinCloud);
    expect((await commands(online)).map((c: { status: string }) => c.status)).toEqual([
      'APPLIED',
      'APPLIED',
    ]);
    // The shop's audit log shows who did it online.
    const log = await shopApp.deps.db.auditLog.findFirst({
      where: { action: 'user.reset_password' },
    });
    expect(log?.userId).not.toBeNull();
  });

  it('different fields changed on each side are both kept; the same field waits for the Super Admin', async () => {
    const id = cat.supplierA;
    // Offline at the shop: a new address.
    const atShop = await supplierBody(shop.sa, id);
    expect(
      (await shop.sa.put(`/api/suppliers/${id}`, { ...atShop, address: 'No 5, Kandy Road' }))
        .status,
    ).toBe(200);
    // Online meanwhile: a new email, then a different address.
    const atCloud = await supplierBody(online, id);
    await online.put(`/api/suppliers/${id}`, { ...atCloud, email: 'orders@a.lk' });
    await online.put(`/api/suppliers/${id}`, {
      ...atCloud,
      email: 'orders@a.lk',
      address: 'No 9, Galle Road',
    });

    await sync();
    let s = await shopApp.deps.db.supplier.findUniqueOrThrow({ where: { id } });
    expect(s.email).toBe('orders@a.lk');
    expect(s.address).toBe('No 5, Kandy Road');
    const [second, first] = await commands(online);
    expect(first.status).toBe('APPLIED');
    expect(second.status).toBe('CONFLICT');
    expect(second.conflicts).toEqual([
      expect.objectContaining({
        table: 'suppliers',
        field: 'address',
        was: '',
        online: 'No 9, Galle Road',
        shop: 'No 5, Kandy Road',
      }),
    ]);

    // Only the Super Admin answers; the shop follows at the next sync.
    const adminOnline = new Client(cloudApp);
    await login(adminOnline, 'admin');
    expect(
      (await adminOnline.post(`/api/sync/commands/${second.id}/resolve`, { action: 'APPLY' }))
        .status,
    ).toBe(403);
    expect(
      (await online.post(`/api/sync/commands/${second.id}/resolve`, { action: 'APPLY' })).status,
    ).toBe(200);
    await sync();
    s = await shopApp.deps.db.supplier.findUniqueOrThrow({ where: { id } });
    expect(s.address).toBe('No 9, Galle Road');
    expect((await commands(online))[0].status).toBe('APPLIED');
  });

  it('"Keep shop version" at the shop puts the cloud back to the shop’s value', async () => {
    const id = cat.supplierA;
    const body = await supplierBody(shop.sa, id);
    await shop.sa.put(`/api/suppliers/${id}`, { ...body, address: 'Shop address' });
    await online.put(`/api/suppliers/${id}`, { ...body, address: 'Online address' });
    await sync();
    const [c] = await commands(shop.sa);
    expect(c.status).toBe('CONFLICT');

    const r = await shop.sa.post(`/api/sync/commands/${c.id}/resolve`, { action: 'DISCARD' });
    expect(r.body.status).toBe('DISCARDED');
    await sync();
    expect((await commands(online))[0].status).toBe('DISCARDED');
    const cloudRow = await cloudApp.deps.db.supplier.findUniqueOrThrow({ where: { id } });
    expect(cloudRow.address).toBe('Shop address');
  });

  it('an online change that clashes at the shop is not applied, and the cloud shows the shop again', async () => {
    // A user "nimal" is made at the shop while offline, and another "nimal" online.
    const roles = (await shop.sa.get('/api/roles')).body.items;
    const cashierRole = roles.find((x: { code: string }) => x.code === 'CASHIER').id;
    const user = {
      username: 'nimal',
      fullName: 'Nimal',
      password: PASSWORD,
      roleIds: [cashierRole],
      mustChangePassword: false,
    };
    expect((await shop.sa.post('/api/users', { ...user, pin: '7777' })).status).toBe(200);
    expect((await online.post('/api/users', { ...user, pin: '7778' })).status).toBe(200);

    await sync();
    const [c] = await commands(online);
    expect(c.status).toBe('FAILED');
    expect(c.message).toMatch(/clashes with something already at the shop/);
    const nimals = await cloudApp.deps.db.user.findMany({ where: { username: 'nimal' } });
    const atShop = await shopApp.deps.db.user.findFirstOrThrow({ where: { username: 'nimal' } });
    expect(nimals.map((u) => u.id)).toEqual([atShop.id]);
  });

  it('putting a user in test mode online reaches the shop', async () => {
    const id = shop.ids.cashier!;
    expect((await online.post(`/api/users/${id}/test-mode`, { on: true })).status).toBe(200);
    expect((await shop.cashier.get('/api/auth/me')).body.testMode).toBe(false);
    await sync();
    expect((await shop.cashier.get('/api/auth/me')).body.testMode).toBe(true);
    await shopApp.deps.testMode.ready();
    const lines = [{ kind: 'BATCH', subProductId: 'x', qty: '1' }];
    // Any request of theirs now runs on the copy (a bad line is refused there, not at the till).
    expect((await shop.cashier.post('/api/sales', { lines })).status).toBeGreaterThanOrEqual(400);
    await shopApp.deps.testMode.setUser({ userId: null }, id, false);
  }, 60_000);

  it('offline, changes wait at the shop and go up once the cloud answers again', async () => {
    const setKey = async (shopKey: string) => {
      await shopApp.deps.db.setting.update({
        where: { key: 'cloud' },
        data: { value: { url: 'https://cloud.example', shopKey } },
      });
      shopApp.deps.settings.invalidate();
    };
    await setKey('a-wrong-key');
    const id = cat.supplierB;
    const body = await supplierBody(shop.sa, id);
    await shop.sa.put(`/api/suppliers/${id}`, { ...body, address: 'Changed offline' });
    const off = await sync();
    expect(off.online).toBe(false);
    expect(off.lastError).toBe('Wrong shop key. Check Settings → Cloud at the shop.');
    expect(off.waiting).toBeGreaterThan(0);
    expect((await shop.sa.get('/api/system/status')).body.sync).toMatchObject({ online: false });

    await setKey(KEY);
    const on = await sync();
    expect(on).toMatchObject({ online: true, waiting: 0, lastError: '' });
    const row = await cloudApp.deps.db.supplier.findUniqueOrThrow({ where: { id } });
    expect(row.address).toBe('Changed offline');
  });
});
