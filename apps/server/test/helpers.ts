import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../src/config';
import { buildApp } from '../src/app';
import { runSetup } from '../src/modules/setup/service';

export const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://aruna:aruna@localhost:5432/aruna_test';

export const testConfig: AppConfig = {
  databaseUrl: TEST_URL,
  port: 0,
  host: '127.0.0.1',
  mode: 'shop',
  pinSecret: 'test-pin-secret-0123456789',
  dataDir: '/tmp/aruna-test-data',
  pgBinDir: '',
  webDistDir: '',
  sessionDays: 30,
  logLevel: 'silent',
  disableSchedulers: true,
  syncKey: '',
};

export async function createTestApp(
  config: Partial<AppConfig> = {},
  overrides: Parameters<typeof buildApp>[1] = {},
): Promise<FastifyInstance> {
  const app = await buildApp({ ...testConfig, ...config }, overrides);
  await app.ready();
  return app;
}

/** Empties every table (TRUNCATE skips the append-only row triggers). */
export async function resetDb(app: FastifyInstance): Promise<void> {
  const tables = await app.deps.db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await app.deps.db.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
  app.deps.settings.invalidate();
  const { resetLocationCache } = await import('../src/auth/session');
  resetLocationCache();
}

export interface Res<T = any> {
  status: number;
  body: T;
}

export class Client {
  constructor(
    private readonly app: FastifyInstance,
    public cookie = '',
  ) {}

  async req<T = any>(
    method: string,
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res<T>> {
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      payload: payload as object | undefined,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
    });
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      const first = Array.isArray(setCookie) ? setCookie[0]! : setCookie;
      const pair = first.split(';')[0]!;
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    let body: unknown = res.body;
    try {
      body = res.json();
    } catch {
      // not JSON
    }
    return { status: res.statusCode, body: body as T };
  }
  get<T = any>(url: string, headers?: Record<string, string>) {
    return this.req<T>('GET', url, undefined, headers);
  }
  post<T = any>(url: string, payload?: unknown) {
    return this.req<T>('POST', url, payload ?? {});
  }
  put<T = any>(url: string, payload?: unknown) {
    return this.req<T>('PUT', url, payload ?? {});
  }
  patch<T = any>(url: string, payload?: unknown) {
    return this.req<T>('PATCH', url, payload ?? {});
  }
  delete<T = any>(url: string) {
    return this.req<T>('DELETE', url);
  }
}

export const PINS = {
  superAdmin: '1111',
  admin: '2222',
  stock: '3333',
  cashier: '4444',
  cashier2: '5555',
};
export const PASSWORD = 'password123';

export interface Shop {
  sa: Client;
  admin: Client;
  stock: Client;
  cashier: Client;
  cashier2: Client;
  recoveryCodes: string[];
  ids: Record<string, string>;
}

/**
 * Sets up a shop the way the first-run wizard does, then registers one user per built-in role.
 * Cashiers log in at counters C1 and C2.
 */
export async function setupShop(app: FastifyInstance): Promise<Shop> {
  await resetDb(app);
  const { recoveryCodes } = await runSetup(app.deps.db, app.deps.config, {
    shop: { shopName: 'Pannala Aruna Paint Center', address: 'Pannala', phone: '0371234567' },
    admin: { username: 'owner', fullName: 'Owner', password: PASSWORD, pin: PINS.superAdmin },
    counterCode: 'C1',
  });
  const db = app.deps.db;
  const shop = await db.location.findFirstOrThrow({ where: { kind: 'SHOP' } });
  await db.counter.create({ data: { code: 'C2', name: 'Counter 2', locationId: shop.id } });
  await db.counter.update({ where: { code: 'C1' }, data: { printer: { driver: 'none' } } });

  const sa = new Client(app);
  await login(sa, 'owner');
  const roles = await sa.get('/api/roles');
  const roleId = (code: string) =>
    roles.body.items.find((r: { code: string }) => r.code === code).id;
  const mk = async (username: string, role: string, pin: string) => {
    const r = await sa.post('/api/users', {
      username,
      fullName: username[0]!.toUpperCase() + username.slice(1),
      password: PASSWORD,
      pin,
      roleIds: [roleId(role)],
      mustChangePassword: false,
    });
    if (r.status !== 200) throw new Error(`create user ${username}: ${JSON.stringify(r.body)}`);
    return r.body.id as string;
  };
  const ids: Record<string, string> = {
    shop: shop.id,
    damaged: (await db.location.findFirstOrThrow({ where: { kind: 'DAMAGED' } })).id,
    admin: await mk('admin', 'ADMIN', PINS.admin),
    stock: await mk('stock', 'STOCK_MANAGER', PINS.stock),
    cashier: await mk('cashier', 'CASHIER', PINS.cashier),
    cashier2: await mk('cashier2', 'CASHIER', PINS.cashier2),
  };
  const admin = new Client(app);
  await login(admin, 'admin');
  const stock = new Client(app);
  await login(stock, 'stock');
  const cashier = new Client(app);
  await login(cashier, 'cashier', 'C1');
  const cashier2 = new Client(app);
  await login(cashier2, 'cashier2', 'C2');
  return { sa, admin, stock, cashier, cashier2, recoveryCodes, ids };
}

export async function login(client: Client, username: string, counterCode?: string) {
  const r = await client.post('/api/auth/login', { username, password: PASSWORD, counterCode });
  if (r.status !== 200) throw new Error(`login ${username}: ${JSON.stringify(r.body)}`);
  return r;
}

export async function valueId(client: Client, list: string, name: string): Promise<string> {
  const r = await client.get(`/api/values/${list}`);
  const item = r.body.items.find((i: { name: string }) => i.name === name);
  if (!item) throw new Error(`no ${list} value ${name}`);
  return item.id;
}
