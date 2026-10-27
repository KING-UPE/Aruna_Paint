import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Client,
  createTestApp,
  login,
  PASSWORD,
  PINS,
  resetDb,
  setupShop,
  type Shop,
} from './helpers';

let app: FastifyInstance;
let shop: Shop;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

describe('first-run setup', () => {
  beforeEach(async () => {
    await resetDb(app);
  });

  it('creates the Super Admin, recovery codes, the shop and starting lists', async () => {
    const c = new Client(app);
    expect((await c.get('/api/setup/status')).body.needsSetup).toBe(true);
    const r = await c.post('/api/setup', {
      shop: { shopName: 'Pannala Aruna Paint Center' },
      admin: { username: 'owner', fullName: 'Owner', password: PASSWORD, pin: '1111' },
    });
    expect(r.status).toBe(200);
    expect(r.body.recoveryCodes).toHaveLength(8);
    expect(r.body.counterCode).toBe('C1');
    const me = await c.get('/api/auth/me');
    expect(me.body.roles).toEqual(['SUPER_ADMIN']);
    expect(me.body.permissions).toContain('cost.totals');
    const locations = await c.get('/api/values/locations');
    expect(locations.body.items.map((l: { kind: string }) => l.kind).sort()).toEqual([
      'DAMAGED',
      'SHOP',
    ]);
    expect((await c.get('/api/setup/status')).body.needsSetup).toBe(false);
    expect((await c.post('/api/setup', {})).status).toBe(400);
  });
});

describe('access', () => {
  beforeEach(async () => {
    shop = await setupShop(app);
  });

  it('rejects requests without a session', async () => {
    const r = await new Client(app).get('/api/users');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('wrong passwords are refused and logged', async () => {
    const c = new Client(app);
    const r = await c.post('/api/auth/login', { username: 'cashier', password: 'nope-nope' });
    expect(r.status).toBe(401);
    const log = await shop.sa.get('/api/audit-log?action=login.failed');
    expect(log.body.total).toBe(1);
  });

  it('checks permissions on the server, not just the screens', async () => {
    expect((await shop.cashier.get('/api/users')).status).toBe(403);
    expect((await shop.admin.get('/api/users')).status).toBe(403);
    expect((await shop.sa.get('/api/users')).status).toBe(200);
    expect((await shop.cashier.post('/api/values/brands', { name: 'Dulux' })).status).toBe(403);
    expect((await shop.stock.post('/api/values/brands', { name: 'Dulux' })).status).toBe(200);
  });

  it('a cashier logged in at a counter has that counter and its location', async () => {
    const me = await shop.cashier.get('/api/auth/me');
    expect(me.body.counter.code).toBe('C1');
    expect(me.body.location.code).toBe('SHOP');
    expect(me.body.permissions).not.toContain('cost.item');
  });

  it('PIN switches the user on the same counter and both are logged', async () => {
    const r = await shop.cashier.post('/api/auth/pin', { pin: PINS.cashier2 });
    expect(r.body).toEqual({ ok: true, switched: true });
    const me = await shop.cashier.get('/api/auth/me');
    expect(me.body.user.username).toBe('cashier2');
    expect(me.body.counter.code).toBe('C1');
    expect((await shop.cashier.post('/api/auth/pin', { pin: '9999' })).status).toBe(401);
  });

  it('a locked screen refuses work until a PIN unlocks it', async () => {
    await shop.cashier.post('/api/auth/lock');
    const blocked = await shop.cashier.get('/api/values/units');
    expect(blocked.status).toBe(423);
    expect((await shop.cashier.get('/api/auth/me')).body.locked).toBe(true);
    await shop.cashier.post('/api/auth/pin', { pin: PINS.cashier });
    expect((await shop.cashier.get('/api/values/units')).status).toBe(200);
  });

  it('locks after the idle time', async () => {
    await app.deps.db.session.updateMany({
      data: { lastActivityAt: new Date(Date.now() - 60 * 60_000) },
    });
    expect((await shop.cashier.get('/api/values/units')).status).toBe(423);
  });

  it('a reset password must be changed at next login', async () => {
    const r = await shop.sa.post(`/api/users/${shop.ids.cashier}/reset-password`, {
      password: 'temporary1',
    });
    expect(r.status).toBe(200);
    // Resetting logs the user out everywhere.
    expect((await shop.cashier.get('/api/auth/me')).status).toBe(401);
    const c = new Client(app);
    await c.post('/api/auth/login', { username: 'cashier', password: 'temporary1' });
    expect((await c.get('/api/values/units')).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(
      (
        await c.post('/api/auth/change-password', {
          currentPassword: 'temporary1',
          newPassword: 'short',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await c.post('/api/auth/change-password', {
          currentPassword: 'temporary1',
          newPassword: 'brand-new-pass',
        })
      ).status,
    ).toBe(200);
    expect((await c.get('/api/values/units')).status).toBe(200);
  });

  it('recovery codes reset a forgotten Super Admin password once each', async () => {
    const code = shop.recoveryCodes[0]!;
    const c = new Client(app);
    expect(
      (
        await c.post('/api/auth/recover', {
          username: 'owner',
          recoveryCode: code,
          newPassword: 'recovered-pass',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await c.post('/api/auth/recover', {
          username: 'owner',
          recoveryCode: code,
          newPassword: 'again-again',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await c.post('/api/auth/recover', {
          username: 'cashier',
          recoveryCode: shop.recoveryCodes[1],
          newPassword: 'nope-nope-1',
        })
      ).status,
    ).toBe(401);
    expect(
      (await c.post('/api/auth/login', { username: 'owner', password: 'recovered-pass' })).status,
    ).toBe(200);
  });
});

describe('users and roles', () => {
  beforeEach(async () => {
    shop = await setupShop(app);
  });

  it('roles combine per user', async () => {
    const roles = (await shop.sa.get('/api/roles')).body.items;
    const id = (code: string) => roles.find((r: { code: string }) => r.code === code).id;
    const r = await shop.sa.post('/api/users', {
      username: 'nimal',
      fullName: 'Nimal',
      password: PASSWORD,
      pin: '6666',
      roleIds: [id('STOCK_MANAGER'), id('CASHIER')],
      mustChangePassword: false,
    });
    expect(r.status).toBe(200);
    const c = new Client(app);
    await login(c, 'nimal');
    const me = (await c.get('/api/auth/me')).body;
    expect(me.permissions).toEqual(
      expect.arrayContaining(['billing.create', 'purchases.create', 'cost.item']),
    );
  });

  it('PINs are unique per user', async () => {
    const r = await shop.sa.post(`/api/users/${shop.ids.cashier}/reset-pin`, { pin: PINS.admin });
    expect(r.status).toBe(409);
  });

  it('at least one active Super Admin must always exist', async () => {
    const me = (await shop.sa.get('/api/auth/me')).body;
    const roles = (await shop.sa.get('/api/roles')).body.items;
    const adminRole = roles.find((r: { code: string }) => r.code === 'ADMIN').id;
    expect((await shop.sa.patch(`/api/users/${me.user.id}`, { roleIds: [adminRole] })).status).toBe(
      409,
    );
    expect((await shop.sa.patch(`/api/users/${me.user.id}`, { active: false })).status).toBe(409);
  });

  it('custom roles are built from module permissions and cannot hold Super Admin powers', async () => {
    const bad = await shop.sa.post('/api/roles', {
      name: 'Supervisor',
      permissions: ['users.create'],
    });
    expect(bad.status).toBe(400);
    const ok = await shop.sa.post('/api/roles', {
      name: 'Supervisor',
      permissions: ['stock.view', 'reorder.view'],
    });
    expect(ok.status).toBe(200);
    const roles = (await shop.sa.get('/api/roles')).body.items;
    const sup = roles.find((r: { name: string }) => r.name === 'Supervisor');
    expect(sup.permissions).toEqual(['stock.view', 'reorder.view']);
    await shop.sa.patch(`/api/users/${shop.ids.cashier}`, {
      roleIds: [sup.id, roles.find((r: { code: string }) => r.code === 'CASHIER').id],
    });
    // A role still ticked for any user can't be deleted.
    expect((await shop.sa.delete(`/api/roles/${sup.id}`)).status).toBe(409);
  });

  it('the Super Admin can change what a built-in role gives and put it back', async () => {
    const roles = (await shop.sa.get('/api/roles')).body.items;
    const cashierRole = roles.find((r: { code: string }) => r.code === 'CASHIER');
    expect(cashierRole.customized).toBe(false);
    expect(cashierRole.permissions).toEqual(cashierRole.defaultPermissions);
    const fewer = cashierRole.permissions.filter((p: string) => p !== 'quotations.create');
    expect(fewer.length).toBe(cashierRole.permissions.length - 1);
    expect(
      (
        await shop.sa.patch(`/api/roles/${cashierRole.id}`, {
          permissions: [...fewer, 'stock.view'],
        })
      ).status,
    ).toBe(200);
    let me = (await shop.cashier.get('/api/auth/me')).body;
    expect(me.permissions).toContain('stock.view');
    expect(me.permissions).not.toContain('quotations.create');
    const after = (await shop.sa.get('/api/roles')).body.items.find(
      (r: { code: string }) => r.code === 'CASHIER',
    );
    expect(after.customized).toBe(true);
    // Super Admin-only powers stay with the Super Admin.
    expect(
      (await shop.sa.patch(`/api/roles/${cashierRole.id}`, { permissions: ['users.create'] }))
        .status,
    ).toBe(400);
    const sa = roles.find((r: { code: string }) => r.code === 'SUPER_ADMIN');
    expect((await shop.sa.patch(`/api/roles/${sa.id}`, { permissions: [] })).status).toBe(409);

    expect((await shop.sa.post(`/api/roles/${cashierRole.id}/reset`)).status).toBe(200);
    me = (await shop.cashier.get('/api/auth/me')).body;
    expect(me.permissions).not.toContain('stock.view');
    expect(me.permissions).toContain('quotations.create');
  });

  it('one user can get an extra permission or lose one from their roles', async () => {
    const r = await shop.sa.patch(`/api/users/${shop.ids.cashier}`, {
      permissionOverrides: [
        { permission: 'stock.view', granted: true },
        { permission: 'quotations.create', granted: false },
      ],
    });
    expect(r.status).toBe(200);
    const me = (await shop.cashier.get('/api/auth/me')).body;
    expect(me.permissions).toContain('stock.view');
    expect(me.permissions).not.toContain('quotations.create');
    const users = (await shop.sa.get('/api/users')).body.items;
    expect(
      users.find((u: { id: string }) => u.id === shop.ids.cashier).permissionOverrides,
    ).toEqual([
      { permission: 'quotations.create', granted: false },
      { permission: 'stock.view', granted: true },
    ]);
    const bad = await shop.sa.patch(`/api/users/${shop.ids.cashier}`, {
      permissionOverrides: [{ permission: 'users.create', granted: true }],
    });
    expect(bad.status).toBe(400);
  });
});

describe('value manager', () => {
  beforeEach(async () => {
    shop = await setupShop(app);
  });

  it('names are unique ignoring capitals and extra spaces', async () => {
    expect((await shop.stock.post('/api/values/brands', { name: 'Dulux' })).status).toBe(200);
    const dup = await shop.stock.post('/api/values/brands', { name: '  dULUX ' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toContain('Dulux');
  });

  it('only the Super Admin adds shops or warehouses', async () => {
    expect(
      (
        await shop.admin.post('/api/values/locations', {
          name: 'Store',
          code: 'ST',
          kind: 'WAREHOUSE',
        })
      ).status,
    ).toBe(403);
    const r = await shop.sa.post('/api/values/locations', {
      name: 'Store',
      code: 'st',
      kind: 'WAREHOUSE',
    });
    expect(r.status).toBe(200);
    expect(r.body.code).toBe('ST');
  });

  it('merges duplicates with their history and deletes only unused values', async () => {
    const a = (await shop.stock.post('/api/values/brands', { name: 'Nippon' })).body;
    const b = (await shop.stock.post('/api/values/brands', { name: 'Nipon Paint' })).body;
    expect(
      (await shop.admin.post(`/api/values/brands/${b.id}/merge`, { intoId: a.id })).status,
    ).toBe(200);
    const list = (await shop.admin.get('/api/values/brands')).body.items;
    expect(list.map((x: { name: string }) => x.name)).toEqual(['Nippon']);
    // The merged name is free again.
    expect((await shop.stock.post('/api/values/brands', { name: 'Nipon Paint' })).status).toBe(200);
    expect((await shop.admin.delete(`/api/values/brands/${a.id}`)).status).toBe(200);
  });
});

describe('settings and numbering', () => {
  beforeEach(async () => {
    shop = await setupShop(app);
  });

  it('only the Super Admin picks the colour theme; everyone, even the login screen, gets it', async () => {
    const theme = { theme: 'custom', customAccent: '#b45309', mode: 'dark' };
    expect((await shop.admin.put('/api/settings/appearance', theme)).status).toBe(403);
    expect(
      (await shop.sa.put('/api/settings/appearance', { ...theme, customAccent: 'orange' })).status,
    ).toBe(400);
    expect((await shop.sa.put('/api/settings/appearance', theme)).status).toBe(200);
    expect((await shop.cashier.get('/api/auth/me')).body.appearance).toEqual(theme);
    const loggedOut = new Client(app);
    expect((await loggedOut.get('/api/setup/status')).body.appearance).toEqual(theme);
  });

  it('the Super Admin changes number formats; bad formats are refused', async () => {
    expect((await shop.sa.put('/api/number-formats/INVOICE', { format: 'INV-NNNN' })).status).toBe(
      400,
    );
    expect(
      (await shop.sa.put('/api/number-formats/INVOICE', { format: 'A{YY}-INV-{NNNN}' })).status,
    ).toBe(200);
    const list = (await shop.sa.get('/api/number-formats')).body.items;
    expect(list.find((f: { docType: string }) => f.docType === 'INVOICE').example).toMatch(
      /^A\d{2}-INV-0001$/,
    );
    expect(
      (await shop.admin.put('/api/number-formats/INVOICE', { format: 'X-{NNNN}' })).status,
    ).toBe(403);
  });

  it('every change lands in the sync outbox in the same transaction', async () => {
    const before = await app.deps.db.syncOutbox.count();
    await shop.stock.post('/api/values/brands', { name: 'Asian Paints' });
    const rows = await app.deps.db.syncOutbox.findMany({
      where: { tableName: 'brands' },
      orderBy: { id: 'desc' },
      take: 1,
    });
    expect(await app.deps.db.syncOutbox.count()).toBeGreaterThan(before);
    expect((rows[0]!.data as { name: string }).name).toBe('Asian Paints');
  });

  it('PIN hashes never leave the shop', async () => {
    const rows = await app.deps.db.syncOutbox.findMany({ where: { tableName: 'users' } });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.data).not.toHaveProperty('pin_hmac');
  });

  it('the audit log is append-only', async () => {
    await expect(app.deps.db.auditLog.deleteMany({})).rejects.toThrow();
  });

  it('remaps shortcuts and refuses reserved or taken keys', async () => {
    expect(
      (
        await shop.cashier.put('/api/auth/shortcuts', {
          screen: 'billing',
          action: 'pay',
          keys: 'F12',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await shop.cashier.put('/api/auth/shortcuts', {
          screen: 'billing',
          action: 'pay',
          keys: 'F7',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await shop.cashier.put('/api/auth/shortcuts', {
          screen: 'billing',
          action: 'pay',
          keys: 'ctrl+9',
        })
      ).status,
    ).toBe(200);
    const me = (await shop.cashier.get('/api/auth/me')).body;
    expect(me.shortcuts).toEqual([{ screen: 'billing', action: 'pay', keys: 'Ctrl+9' }]);
    await shop.cashier.delete('/api/auth/shortcuts');
    expect((await shop.cashier.get('/api/auth/me')).body.shortcuts).toEqual([]);
  });
});
