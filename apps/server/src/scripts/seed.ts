/**
 * Development seed: a set-up shop with one user per role, a few suppliers and products, stock
 * from two GRNs and mix paint ready to sell loose. Run on an empty database: `pnpm db:seed`.
 *
 * Logins (password "password123"): owner (Super Admin, PIN 1111), admin (2222),
 * stock (3333), cashier (4444). Counter C1 is set up for billing.
 */
import { computePurchaseLine, computePurchaseTotals, shopDate } from '@aruna/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { runSetup } from '../modules/setup/service';

const PASSWORD = 'password123';

class Session {
  cookie = '';
  constructor(private readonly app: FastifyInstance) {}
  async call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
    const res = await this.app.inject({
      method,
      url,
      payload: payload as object,
      headers: this.cookie ? { cookie: this.cookie } : {},
    });
    const set = res.headers['set-cookie'];
    if (set) this.cookie = (Array.isArray(set) ? set[0]! : set).split(';')[0]!;
    if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.body}`);
    return res.json();
  }
}

async function main() {
  const config = { ...loadConfig(), logLevel: 'warn', disableSchedulers: true };
  const app = await buildApp(config);
  await app.ready();
  const db = app.deps.db;
  if ((await db.user.count()) > 0) {
    console.log('The database already has users; seed skipped. Reset it first to reseed.');
    await app.close();
    return;
  }

  const { recoveryCodes } = await runSetup(db, config, {
    shop: {
      shopName: 'Pannala Aruna Paint Center',
      address: 'Kuliyapitiya Road, Pannala',
      phone: '037 224 5566',
    },
    admin: { username: 'owner', fullName: 'Owner', password: PASSWORD, pin: '1111' },
    counterCode: 'C1',
  });
  const shopId = (await db.location.findFirstOrThrow({ where: { kind: 'SHOP' } })).id;
  await db.counter.create({ data: { code: 'C2', name: 'Counter 2', locationId: shopId } });

  const owner = new Session(app);
  await owner.call('POST', '/api/auth/login', { username: 'owner', password: PASSWORD });
  const roles = (await owner.call('GET', '/api/roles')).items as { id: string; code: string }[];
  const role = (code: string) => roles.find((r) => r.code === code)!.id;
  for (const [username, fullName, code, pin] of [
    ['admin', 'Admin', 'ADMIN', '2222'],
    ['stock', 'Stock Manager', 'STOCK_MANAGER', '3333'],
    ['cashier', 'Cashier', 'CASHIER', '4444'],
  ] as const) {
    await owner.call('POST', '/api/users', {
      username,
      fullName,
      password: PASSWORD,
      pin,
      roleIds: [role(code)],
      mustChangePassword: false,
    });
  }

  const s = new Session(app);
  await s.call('POST', '/api/auth/login', { username: 'stock', password: PASSWORD });
  const values = async (list: string) =>
    (await s.call('GET', `/api/values/${list}`)).items as { id: string; name: string }[];
  const units = await values('units');
  const cats = await values('categories');
  const unit = (n: string) => units.find((u) => u.name === n)!.id;
  const cat = (n: string) => cats.find((c) => c.name === n)!.id;
  const dulux = (await s.call('POST', '/api/values/brands', { name: 'Dulux' })).id;
  const nippon = (await s.call('POST', '/api/values/brands', { name: 'Nippon' })).id;

  const supA = (
    await s.call('POST', '/api/suppliers', {
      name: 'Lanka Paints Distributors',
      phones: ['0372223344'],
      creditDays: 30,
      reps: [{ name: 'Saman', phone: '0771112233' }],
    })
  ).id;
  const supB = (
    await s.call('POST', '/api/suppliers', {
      name: 'Kurunegala Hardware Traders',
      phones: ['0372298877'],
      creditDays: 14,
    })
  ).id;

  const product = async (body: Record<string, unknown>) =>
    (await s.call('POST', '/api/products', body)).product.id as string;
  const thinner = await product({
    name: 'Thinner 4L',
    unitId: unit('can'),
    categoryId: cat('Thinner'),
    brandId: dulux,
    reorderLevel: '5',
    reorderQty: '12',
  });
  const white4 = await product({
    name: 'White Emulsion 4L',
    unitId: unit('can'),
    categoryId: cat('Emulsion'),
    brandId: dulux,
    packSize: '4',
    allowLooseSale: true,
    reorderLevel: '4',
    reorderQty: '10',
  });
  const enamel = await product({
    name: 'Gloss Enamel Black 1L',
    unitId: unit('can'),
    categoryId: cat('Enamel'),
    brandId: nippon,
    reorderLevel: '6',
    reorderQty: '12',
  });
  const putty = await product({
    name: 'Wall Putty 5kg',
    unitId: unit('piece'),
    categoryId: cat('Putty'),
    brandId: nippon,
  });
  const brush = await product({
    name: 'Brush 2 inch',
    unitId: unit('piece'),
    categoryId: cat('Brushes'),
    buyingUnitId: unit('box'),
    piecesPerBox: 12,
    reorderLevel: '12',
    reorderQty: '24',
  });

  const grn = async (supplierId: string, lines: Record<string, unknown>[]) => {
    const amounts = lines.map((l) => computePurchaseLine(l as never).amount);
    const total = computePurchaseTotals({ lineAmounts: amounts }).netTotal.toFixed(2);
    return s.call('POST', '/api/purchases', {
      supplierId,
      date: shopDate(),
      supplierInvoiceTotal: total,
      lines,
      post: true,
    });
  };
  const pct = (value: string) => ({ type: 'PERCENT', value });
  await grn(supA, [
    {
      productId: thinner,
      value: '2600',
      qty: '10',
      discount: pct('10'),
      salesDiscount: pct('5'),
    },
    { productId: white4, value: '2000', qty: '8', discount: pct('10'), salesDiscount: pct('5') },
    { productId: enamel, value: '1450', qty: '12', discount: pct('8') },
  ]);
  await grn(supB, [
    {
      productId: thinner,
      value: '2700',
      qty: '6',
      discount: pct('10'),
      salesDiscount: pct('5'),
    },
    { productId: putty, value: '1850', qty: '10', discount: pct('5') },
    { productId: brush, value: '5400', qty: '2' },
  ]);
  const white = (await s.call('GET', `/api/products/${white4}`)).subProducts[0].id;
  await s.call('POST', '/api/mix-paint/transfers', {
    sourceSubProductId: white,
    cans: 1,
    adminCanPrice: '2600',
  });

  console.log('Seeded the demo shop.');
  console.log('Logins (password "password123"): owner/1111, admin/2222, stock/3333, cashier/4444.');
  console.log('Open the billing screen with ?counter=C1. Recovery codes for owner:');
  for (const c of recoveryCodes) console.log(`  ${c}`);
  await app.close();
}

await main();
