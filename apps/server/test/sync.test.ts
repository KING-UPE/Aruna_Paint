import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dropDatabase } from '../src/db';
import { withShopData } from '../src/core/dbscope';
import { resetLocationCache } from '../src/auth/session';
import type { SyncTransport } from '../src/core/syncagent';
import {
  Client,
  createTestApp,
  login,
  PASSWORD,
  resetDb,
  setupShop,
  type Shop,
  TEST_URL,
} from './helpers';
import { createCatalog, postGrn, subProducts, type Catalog } from './fixtures';

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

/** Online changes, leaving out the owner's own account (it goes to every shop by itself). */
const commands = async (c: Client) =>
  (await c.get('/api/sync/status')).body.commands.filter(
    (x: { route: string }) => x.route !== 'owner',
  );

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
    // Each works at its own shop location, not the one signed in to first.
    const shopLocation = (app: FastifyInstance) =>
      app.deps.db.location.findFirstOrThrow({
        where: { kind: 'SHOP' },
        orderBy: { sortOrder: 'asc' },
      });
    expect((await ownerB.get('/api/auth/me')).body.location.id).toBe(
      (await shopLocation(shopB)).id,
    );
    expect((await owner.get('/api/auth/me')).body.location.id).toBe((await shopLocation(shopA)).id);

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
    expect(nodes[0]).toHaveProperty('lastBillAt', null);
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

  it('the colour theme changed at either end shows at the other', async () => {
    const theme = async (c: Client) => (await c.get('/api/auth/me')).body.appearance;
    const look = (await a.sa.get('/api/settings')).body.appearance;
    // Both ends have already shown the theme (so it is held in memory) before it changes.
    expect((await theme(owner)).mode).toBe(look.mode);
    expect((await theme(a.sa)).mode).toBe(look.mode);

    // Online: dark. The shop takes it on its next sync.
    expect((await owner.put('/api/settings/appearance', { ...look, mode: 'dark' })).status).toBe(
      200,
    );
    await sync(shopA);
    expect((await theme(a.sa)).mode).toBe('dark');
    expect((await theme(owner)).mode).toBe('dark');

    // At the shop: light. The panel shows it once the shop has synced.
    expect((await a.sa.put('/api/settings/appearance', { ...look, mode: 'light' })).status).toBe(
      200,
    );
    await sync(shopA);
    expect((await theme(owner)).mode).toBe('light');
  });

  it('everything only the Super Admin may do can be done online, and reaches the shop', async () => {
    // The shop's receipt printer.
    const printer = { driver: 'network', host: '192.168.1.50', port: 9100, share: '', path: '' };
    expect((await owner.put('/api/settings/printer', printer)).status).toBe(200);
    // The HRM month start and one month's figures.
    expect((await owner.put('/api/hrm/month-start', { day: 25 })).status).toBe(200);
    const month = await owner.put('/api/hrm/month/2026-10', {
      maxCommissionPercent: 5,
      shopRent: 45000,
      electricityBill: 8000,
      salaries: [],
      members: [],
      syncUserRates: false,
    });
    expect(month.status).toBe(200);
    // Backup times and folders.
    const backup = (await owner.get('/api/settings')).body.backup;
    expect(
      (await owner.put('/api/settings/backup', { ...backup, nightlyAt: '23:15' })).status,
    ).toBe(200);
    // Still at the shop only: its link to the cloud. And an Admin still only looks.
    const cloud = (await owner.get('/api/settings')).body.cloud;
    expect((await owner.put('/api/settings/cloud', cloud)).status).toBe(403);
    const admin = (await online('admin', shopA)).c;
    expect((await admin.put('/api/settings/backup', backup)).status).toBe(403);

    await sync(shopA);
    const shopSettings = (await a.sa.get('/api/settings')).body;
    expect(shopSettings.printer).toMatchObject({ driver: 'network', host: '192.168.1.50' });
    expect(shopSettings.backup.nightlyAt).toBe('23:15');
    expect(shopSettings.closing.monthStartDay).toBe(25);
    expect(shopSettings.hrm.monthlyOverrides['2026-10']).toMatchObject({ shopRent: 45000 });
    expect((await commands(owner)).every((c: { status: string }) => c.status === 'APPLIED')).toBe(
      true,
    );
  });

  it('a backup or a fresh test copy asked for online is done by the shop at its next sync', async () => {
    const backups = await shopA.deps.db.backup.count();
    const asked = await owner.post('/api/backups', {});
    expect(asked.status).toBe(202);
    expect((await owner.post('/api/test-mode/refresh', {})).status).toBe(202);
    // Nothing happens until the shop connects.
    expect(await shopA.deps.db.backup.count()).toBe(backups);
    expect((await commands(owner)).map((c: { status: string }) => c.status)).toEqual([
      'PENDING',
      'PENDING',
    ]);

    await sync(shopA);
    expect(await shopA.deps.db.backup.count()).toBe(backups + 1);
    const done = await commands(owner);
    const of = (summary: string) => done.find((c: { summary: string }) => c.summary === summary);
    // The shop's answer, whatever it was: made, or the reason it couldn't be.
    expect(['APPLIED', 'FAILED']).toContain(of('backup.manual').status);
    expect(of('backup.manual').message).not.toBe('');
    expect(of('testmode.refresh')).toMatchObject({ status: 'APPLIED' });
    // Done in the name of the Super Admin who asked.
    const ownerId = (await shopA.deps.db.user.findFirstOrThrow({ where: { username: 'owner' } }))
      .id;
    expect(
      await shopA.deps.db.auditLog.count({
        where: { action: { in: ['testmode.refresh', 'backup.manual'] }, userId: ownerId },
      }),
    ).toBe(2);
  });

  it('a shop whose sync data was wiped comes back with a full copy, so its users can sign in online', async () => {
    // What the old clean script did: the queue and the shop's id at the cloud were wiped, while
    // users and roles stayed. The shop then turned up as a second shop with no roles.
    const oldId = await nodeId(shopB);
    await shopB.deps.db.$executeRawUnsafe('DELETE FROM sync_outbox');
    await shopB.deps.db.$executeRawUnsafe('DELETE FROM sync_state');
    expect((await sync(shopB)).lastError).toBe('');
    const newId = await nodeId(shopB);
    expect(newId).not.toBe(oldId);
    // The full copy brought everything, roles included: the owner signs in to it online.
    expect((await online('owner', shopB)).status).toBe(200);

    // The Super Admin takes the stray old entry off the panel.
    const names = async () =>
      (await owner.get('/api/cloud/shops')).body.items.map((x: { id: string }) => x.id);
    expect(await names()).toContain(oldId);
    expect((await owner.delete(`/api/cloud/shops/${oldId}`)).status).toBe(200);
    expect(await names()).not.toContain(oldId);
    // Not the shop being looked at, and only the Super Admin.
    expect((await owner.delete(`/api/cloud/shops/${await nodeId(shopA)}`)).status).toBe(409);
    expect(
      (await (await online('admin', shopA)).c.delete(`/api/cloud/shops/${newId}`)).status,
    ).toBe(403);
  });

  it('Cloud sync lists every shop on a fresh server copy that has opened none of them', async () => {
    // On Vercel a new copy of the server has only the shop being looked at open, or none.
    // Cloud sync once failed there with "That shop is not ready" and showed a blank page.
    const shops = cloudApp.deps.shops!;
    await shops.close();
    const r = await owner.get('/api/sync/status');
    expect(r.status).toBe(200);
    expect(r.body.nodes.map((n: { id: string }) => n.id).sort()).toEqual(
      (await shops.list()).map((n) => n.id).sort(),
    );
    expect(r.body.nodes.length).toBeGreaterThan(1);
  });

  it('a copy made before full copies existed is filled in: the cloud asks the shop for one', async () => {
    const id = await nodeId(shopA);
    // A copy from before: never started from a full copy, and missing the roles.
    await cloudApp.deps.shops!.control.syncNode.update({
      where: { id },
      data: { fullCopyAt: null },
    });
    await cloudCopy(shopA, (db) => db.$executeRawUnsafe('TRUNCATE roles CASCADE'));
    expect(await cloudCopy(shopA, (db) => db.role.count())).toBe(0);
    await sync(shopA); // the cloud asks for a full copy
    await sync(shopA); // the shop sends it
    expect(await cloudCopy(shopA, (db) => db.role.count())).toBe(4);
    expect((await online('owner', shopA)).status).toBe(200);
    expect(
      (await cloudApp.deps.shops!.control.syncNode.findUniqueOrThrow({ where: { id } })).fullCopyAt,
    ).not.toBeNull();
  });

  it('the Super Admin is the owner: one online sign-in opens every shop, and the password follows', async () => {
    const panel = () => new Client(cloudApp);
    // The shop's own Super Admin signs in online with their usual username and password.
    const boss = panel();
    const login = await boss.post('/api/auth/login', {
      username: 'owner',
      password: PASSWORD,
      shopId: await nodeId(shopA),
    });
    expect(login.status).toBe(200);
    const listed = (await boss.get('/api/cloud/shops')).body.items;
    expect(listed.every((x: { signedIn: boolean }) => x.signedIn)).toBe(true);
    expect((await boss.post('/api/cloud/switch', { shopId: await nodeId(shopB) })).body).toEqual({
      signedIn: true,
    });
    const atB = (await boss.get('/api/auth/me')).body;
    expect(atB.user.username).toBe('owner');
    expect(atB.roles).toEqual(['SUPER_ADMIN']);
    expect(atB.settings.shopName).toBe('Aruna Paint Kurunegala');
    // The owner manages each shop: here, a new Admin for shop B.
    const roles = (await boss.get('/api/roles')).body.items;
    const adminRole = roles.find((r: { code: string }) => r.code === 'ADMIN').id;
    const kamal = await boss.post('/api/users', {
      username: 'kamal',
      fullName: 'Kamal',
      password: 'password123',
      roleIds: [adminRole],
    });
    expect(kamal.status).toBe(200);

    // An Admin doesn't get every shop: they sign in to each.
    const admin = (await online('admin', shopA)).c;
    expect(
      (await admin.get('/api/cloud/shops')).body.items.filter(
        (x: { signedIn: boolean }) => x.signedIn,
      ),
    ).toHaveLength(1);

    // A password changed online goes to every shop.
    expect(
      (
        await boss.post('/api/auth/change-password', {
          currentPassword: PASSWORD,
          newPassword: 'owner-pass-2',
        })
      ).status,
    ).toBe(200);
    expect((await boss.get('/api/auth/me')).status).toBe(200); // still signed in
    await sync(shopA);
    await sync(shopB);
    for (const shop of [shopA, shopB])
      expect(
        (
          await new Client(shop).post('/api/auth/login', {
            username: 'owner',
            password: 'owner-pass-2',
          })
        ).status,
      ).toBe(200);
    expect(await shopB.deps.db.user.count({ where: { username: 'kamal' } })).toBe(1);

    // A password changed at a shop does too.
    const atA = new Client(shopA);
    await atA.post('/api/auth/login', { username: 'owner', password: 'owner-pass-2' });
    expect(
      (
        await atA.post('/api/auth/change-password', {
          currentPassword: 'owner-pass-2',
          newPassword: 'owner-pass-3',
        })
      ).status,
    ).toBe(200);
    await sync(shopA);
    await sync(shopB);
    expect(
      (
        await new Client(shopB).post('/api/auth/login', {
          username: 'owner',
          password: 'owner-pass-3',
        })
      ).status,
    ).toBe(200);

    // A shop new to the panel opens for the owner too, and gets their account.
    await shopB.deps.db.$executeRawUnsafe('DELETE FROM sync_outbox');
    await shopB.deps.db.$executeRawUnsafe('DELETE FROM sync_state');
    await sync(shopB);
    const again = panel();
    await again.post('/api/auth/login', {
      username: 'owner',
      password: 'owner-pass-3',
      shopId: await nodeId(shopA),
    });
    expect((await again.post('/api/cloud/switch', { shopId: await nodeId(shopB) })).body).toEqual({
      signedIn: true,
    });
  });

  it('one owner above every Super Admin; a new shop needs no account of its own', async () => {
    // beforeEach signed in "owner" (shop A's Super Admin) online first: the owner, at every shop.
    await sync(shopA);
    await sync(shopB);
    for (const shop of [shopA, shopB])
      expect(
        (await shop.deps.db.user.findFirstOrThrow({ where: { username: 'owner' } })).owner,
      ).toBe(true);

    // Another Super Admin, added at shop B, belongs to shop B only.
    const roles = (await b.sa.get('/api/roles')).body.items;
    const sa = roles.find((r: { code: string }) => r.code === 'SUPER_ADMIN').id;
    expect(
      (
        await b.sa.post('/api/users', {
          username: 'partner',
          fullName: 'Partner',
          password: PASSWORD,
          roleIds: [sa],
          mustChangePassword: false,
        })
      ).status,
    ).toBe(200);
    await sync(shopB);
    const partner = (await online('partner', shopB)).c;
    const signedIn = (await partner.get('/api/cloud/shops')).body.items.filter(
      (x: { signedIn: boolean }) => x.signedIn,
    );
    expect(signedIn).toHaveLength(1);
    expect((await partner.get('/api/sync/status')).body.nodes).toHaveLength(1);
    // Only the owner takes a shop off the panel, and nobody else changes the owner's account.
    expect((await partner.delete(`/api/cloud/shops/${await nodeId(shopA)}`)).status).toBe(403);
    const ownerAtB = (await shopB.deps.db.user.findFirstOrThrow({ where: { username: 'owner' } }))
      .id;
    expect(
      (await partner.post(`/api/users/${ownerAtB}/reset-password`, { password: 'taken-over-1' }))
        .status,
    ).toBe(403);
    const atShop = new Client(shopB);
    await login(atShop, 'partner');
    expect(
      (await atShop.post(`/api/users/${ownerAtB}/reset-password`, { password: 'taken-over-1' }))
        .status,
    ).toBe(403);
    expect((await atShop.patch(`/api/users/${ownerAtB}`, { active: false })).status).toBe(403);

    // A new shop links at setup and makes no account: the owner's arrives with the sync.
    await resetDb(shopB);
    const setup = await new Client(shopB).post('/api/setup', {
      shop: { shopName: 'Aruna Paint Kuliyapitiya' },
      cloud: { url: 'https://cloud.example', shopKey: KEY },
    });
    expect(setup.status).toBe(200);
    expect(setup.body.signedIn).toBe(false);
    const status = (await new Client(shopB).get('/api/setup/status')).body;
    expect(status).toMatchObject({ needsSetup: false, waitingForOwner: true });
    await sync(shopB); // the full copy goes up; the owner's account comes back as an online change
    await sync(shopB); // the shop takes it
    const atNew = new Client(shopB);
    expect(
      (await atNew.post('/api/auth/login', { username: 'owner', password: PASSWORD })).status,
    ).toBe(200);
    expect((await atNew.get('/api/auth/me')).body).toMatchObject({
      roles: ['SUPER_ADMIN'],
      user: { owner: true },
    });
    expect((await new Client(shopB).get('/api/setup/status')).body.waitingForOwner).toBe(false);
  });

  it("a new shop takes the panel's PIN secret, so PINs set online work; one with PINs keeps its own", async () => {
    // A new shop server installed with its own random PIN secret (the installer makes one).
    await resetDb(shopB);
    const own = 'this-shop-own-pin-secret-0123456789';
    const fresh = await createTestApp(
      { databaseUrl: branchUrl, pinSecret: own },
      { syncTransport: to(cloudApp) },
    );
    try {
      // As at a real install: the server is already running (and syncing) before setup, so it
      // has "no cloud link" in memory; setup must make it see the link.
      expect((await sync(fresh)).linked).toBe(false);
      await new Client(fresh).post('/api/setup', {
        shop: { shopName: 'Aruna Paint Kuliyapitiya' },
        cloud: { url: 'https://cloud.example', shopKey: KEY },
      });
      await sync(fresh);
      await sync(fresh);
      const panelSecret = cloudApp.deps.config.pinSecret;
      expect(fresh.deps.config.pinSecret).toBe(panelSecret);
      expect((await fresh.deps.sync!.status()).pinSecretShared).toBe(true);
      // A PIN set for the owner on the panel works at the new shop.
      const boss = (await online('owner', fresh)).c;
      const ownerHere = await fresh.deps.db.user.findFirstOrThrow({ where: { username: 'owner' } });
      expect(
        (await boss.post(`/api/users/${ownerHere.id}/reset-pin`, { pin: '2468' })).status,
      ).toBe(200);
      await sync(fresh);
      const atNew = new Client(fresh);
      await login(atNew, 'owner');
      expect((await atNew.post('/api/auth/pin', { pin: '2468' })).status).toBe(200);
    } finally {
      await fresh.close();
    }
    // The secret stays after a restart, whatever the settings file says.
    const restarted = await createTestApp(
      { databaseUrl: branchUrl, pinSecret: own },
      { syncTransport: to(cloudApp) },
    );
    try {
      expect(restarted.deps.config.pinSecret).toBe(cloudApp.deps.config.pinSecret);
    } finally {
      await restarted.close();
    }
    // A shop that already has PINs made with its own secret keeps it (they would all stop working).
    await shopB.deps.db.syncState.deleteMany({ where: { key: 'pin_secret' } });
    const older = await createTestApp(
      { databaseUrl: branchUrl, pinSecret: own },
      { syncTransport: to(cloudApp) },
    );
    try {
      await sync(older);
      expect(older.deps.config.pinSecret).toBe(own);
      expect((await older.deps.sync!.status()).pinSecretShared).toBe(false);
    } finally {
      await older.close();
    }
  });

  it('a shop waiting for the owner says why, refuses sign-in plainly, and can fix its link', async () => {
    await resetDb(shopB);
    const fresh = await createTestApp({ databaseUrl: branchUrl }, { syncTransport: to(cloudApp) });
    try {
      // Set up with a wrong shop key.
      await new Client(fresh).post('/api/setup', {
        shop: { shopName: 'Aruna Paint Kuliyapitiya' },
        cloud: { url: 'https://cloud.example', shopKey: 'not-the-right-key' },
      });
      await sync(fresh);
      const status = (await new Client(fresh).get('/api/setup/status')).body;
      expect(status.waitingForOwner).toBe(true);
      expect(status.link).toMatchObject({ host: 'cloud.example', online: false });
      expect(status.link.lastError).toMatch(/Wrong shop key/);
      expect(JSON.stringify(status)).not.toContain('not-the-right-key');
      // Nobody can sign in yet, and the reason is not "wrong password".
      const early = await new Client(fresh).post('/api/auth/login', {
        username: 'owner',
        password: PASSWORD,
      });
      expect(early.status).toBe(409);
      expect(early.body.error.message).toMatch(/hasn't arrived from the online panel yet/);
      // Fixed from the waiting page: the owner's account arrives and sign-in works.
      const fix = await new Client(fresh).post('/api/setup/cloud', {
        url: 'https://cloud.example',
        shopKey: KEY,
      });
      expect(fix.status).toBe(200);
      await sync(fresh);
      await sync(fresh);
      expect((await new Client(fresh).get('/api/setup/status')).body.waitingForOwner).toBe(false);
      const atNew = new Client(fresh);
      expect(
        (await atNew.post('/api/auth/login', { username: 'owner', password: PASSWORD })).status,
      ).toBe(200);
      // Once someone can sign in, the link changes only in Settings.
      const late = await new Client(fresh).post('/api/setup/cloud', {
        url: 'https://elsewhere.example',
        shopKey: KEY,
      });
      expect(late.status).toBe(403);
    } finally {
      await fresh.close();
    }
  });

  it('an address behind Vercel sign-in is named as the wrong address, not a JSON error', async () => {
    const { createServer } = await import('node:http');
    const { fetchTransport } = await import('../src/core/syncagent');
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'text/html' });
      res.end('<html>Vercel Authentication</html>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(
        fetchTransport('GET', '/api/sync/commands', undefined, {
          url: `http://127.0.0.1:${port}`,
          key: KEY,
          node: '00000000-0000-0000-0000-000000000000',
        }),
      ).rejects.toThrow(/asks for a Vercel sign-in/);
    } finally {
      server.close();
    }
  });

  it('users added, changed, reset, switched off and deleted online reach the shop', async () => {
    const roles = (await owner.get('/api/roles')).body.items as { id: string; code: string }[];
    const role = (code: string) => roles.find((r) => r.code === code)!.id;
    // Added online.
    const made = await owner.post('/api/users', {
      username: 'helper',
      fullName: 'Helper',
      password: 'helper-pass-1',
      roleIds: [role('CASHIER')],
      mustChangePassword: false,
    });
    expect(made.status).toBe(200);
    const id = made.body.id as string;
    await sync(shopA);
    const atShop = new Client(shopA);
    await login(atShop, 'helper', 'helper-pass-1');
    expect((await atShop.get('/api/auth/me')).body.roles).toEqual(['CASHIER']);
    // Changed online: name and role reach the shop; the PC signed in gets the new rights.
    expect(
      (await owner.patch(`/api/users/${id}`, { fullName: 'Helper Two', roleIds: [role('ADMIN')] }))
        .status,
    ).toBe(200);
    await sync(shopA);
    const me = (await atShop.get('/api/auth/me')).body;
    expect(me).toMatchObject({ roles: ['ADMIN'], user: { fullName: 'Helper Two' } });
    // A password reset online signs them out on the shop's PCs, as one made at the shop does.
    expect(
      (await owner.post(`/api/users/${id}/reset-password`, { password: 'helper-pass-2' })).status,
    ).toBe(200);
    await sync(shopA);
    expect((await atShop.get('/api/auth/me')).status).toBe(401);
    const again = new Client(shopA);
    await login(again, 'helper', 'helper-pass-2');
    // Switched off online: signed out, and can't sign in.
    expect((await owner.patch(`/api/users/${id}`, { active: false })).status).toBe(200);
    await sync(shopA);
    expect((await again.get('/api/auth/me')).status).toBe(401);
    expect(
      (
        await new Client(shopA).post('/api/auth/login', {
          username: 'helper',
          password: 'helper-pass-2',
        })
      ).status,
    ).toBe(401);
    // Deleted online: gone at the shop too, although it had signed in there (its sign-ins
    // never leave the shop, and used to stop the delete).
    expect((await owner.delete(`/api/users/${id}`)).status).toBe(200);
    await sync(shopA);
    expect(await shopA.deps.db.user.findUnique({ where: { id } })).toBeNull();
    expect(await shopA.deps.db.session.count({ where: { userId: id } })).toBe(0);
    const statuses = (await commands(owner)).map((c: { status: string }) => c.status);
    expect(statuses.every((st: string) => st === 'APPLIED')).toBe(true);
  });

  it('a user deleted online who made a bill at the shop meanwhile stays, and shows online again', async () => {
    // The tests rebuild the shop's database between tests; a real server keeps its location.
    resetLocationCache();
    await postGrn(a, cat.supplierA, [{ productId: cat.brush, value: '450', qty: '10' }]);
    await sync(shopA);
    const id = a.ids.cashier2!;
    // Offline: cashier2 sells a brush at the shop.
    await link(shopA, 'a-wrong-key');
    const brush = (await subProducts(a, cat.brush))[0]!.id;
    const sale = await a.cashier2.post('/api/sales', {
      lines: [{ kind: 'BATCH', subProductId: brush, qty: '1' }],
    });
    expect(sale.status).toBe(200);
    // Online, where that bill hasn't arrived yet, the Super Admin deletes cashier2.
    expect((await owner.delete(`/api/users/${id}`)).status).toBe(200);
    await link(shopA);
    await sync(shopA);
    const cmd = (await commands(owner)).find((c: { route: string }) =>
      c.route.startsWith('DELETE /api/users'),
    );
    expect(cmd.status).toBe('FAILED');
    expect(cmd.message).toMatch(/still in use at the shop/);
    // The shop kept the user and the bill; the panel shows the user again.
    expect(await shopA.deps.db.user.findUnique({ where: { id } })).not.toBeNull();
    await sync(shopA);
    const users = (await owner.get('/api/users')).body.items as { id: string }[];
    expect(users.some((u) => u.id === id)).toBe(true);
  });

  it('roles added, changed and deleted online reach the shop; one the shop started using is kept', async () => {
    const made = await owner.post('/api/roles', {
      name: 'Helpers',
      permissions: ['billing.view', 'billing.create'],
    });
    expect(made.status).toBe(200);
    const id = made.body.id as string;
    await sync(shopA);
    const atShop = () =>
      shopA.deps.db.role.findUnique({ where: { id }, include: { permissions: true } });
    expect((await atShop())?.name).toBe('Helpers');
    expect(
      (
        await owner.patch(`/api/roles/${id}`, {
          name: 'Helpers',
          permissions: ['billing.view', 'billing.create', 'bill_history.view'],
        })
      ).status,
    ).toBe(200);
    await sync(shopA);
    expect((await atShop())?.permissions.map((p) => p.permission).sort()).toEqual([
      'bill_history.view',
      'billing.create',
      'billing.view',
    ]);
    expect((await owner.delete(`/api/roles/${id}`)).status).toBe(200);
    await sync(shopA);
    expect(await atShop()).toBeNull();

    // A role deleted online that the shop gave someone meanwhile stays at the shop.
    const second = (await owner.post('/api/roles', { name: 'Stock helpers', permissions: [] })).body
      .id as string;
    await sync(shopA);
    await link(shopA, 'a-wrong-key');
    const cashierRole = (await a.sa.get('/api/roles')).body.items.find(
      (r: { code: string }) => r.code === 'CASHIER',
    ).id;
    expect(
      (await a.sa.patch(`/api/users/${a.ids.cashier2}`, { roleIds: [cashierRole, second] })).status,
    ).toBe(200);
    expect((await owner.delete(`/api/roles/${second}`)).status).toBe(200);
    await link(shopA);
    await sync(shopA);
    const cmd = (await commands(owner)).find(
      (c: { route: string; status: string }) =>
        c.route.startsWith('DELETE /api/roles') && c.status !== 'APPLIED',
    );
    expect(cmd.status).toBe('FAILED');
    expect(cmd.message).toMatch(/still in use at the shop/);
    expect(await shopA.deps.db.role.findUnique({ where: { id: second } })).not.toBeNull();
  });

  it('online changes made while the shop is offline wait, and apply in order when it reconnects', async () => {
    await link(shopA, 'a-wrong-key');
    const id = a.ids.cashier!;
    await owner.patch(`/api/users/${id}`, { fullName: 'First name' });
    await owner.patch(`/api/users/${id}`, { fullName: 'Second name' });
    await owner.post(`/api/users/${id}/reset-password`, { password: 'later-pass-1' });
    expect((await sync(shopA)).online).toBe(false);
    expect((await shopA.deps.db.user.findUniqueOrThrow({ where: { id } })).fullName).not.toBe(
      'Second name',
    );
    await link(shopA);
    await sync(shopA);
    expect((await shopA.deps.db.user.findUniqueOrThrow({ where: { id } })).fullName).toBe(
      'Second name',
    );
    await login(new Client(shopA), 'cashier', 'later-pass-1');
  });

  it("the owner's username is never taken from someone else at a shop", async () => {
    // At shop B, "owner" is a cashier.
    const db = shopB.deps.db;
    const user = await db.user.findFirstOrThrow({ where: { username: 'owner' } });
    const cashierRole = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    await db.userRole.deleteMany({ where: { userId: user.id } });
    await db.userRole.create({ data: { userId: user.id, roleId: cashierRole.id } });
    await db.user.update({ where: { id: user.id }, data: { fullName: 'Owner the cashier' } });
    await sync(shopB);

    const boss = new Client(cloudApp);
    expect(
      (
        await boss.post('/api/auth/login', {
          username: 'owner',
          password: PASSWORD,
          shopId: await nodeId(shopA),
        })
      ).status,
    ).toBe(200);
    const r = await boss.post('/api/cloud/switch', { shopId: await nodeId(shopB) });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/belongs to someone else/);
    const atB = await cloudCopy(shopB, (c) =>
      c.user.findFirstOrThrow({ where: { username: 'owner' } }),
    );
    expect(atB.fullName).toBe('Owner the cashier');
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
