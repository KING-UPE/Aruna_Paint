import {
  D,
  DomainError,
  cleanName,
  codeKey,
  discountPerUnit,
  mixPaintCode,
  money,
  nameKey,
  nextMainCode,
  priceChangeSchema,
  productInputSchema,
  searchTokens,
  shopDate,
  subProductCode,
  subProductEditSchema,
  type Decimal,
} from '@aruna/shared';
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../../db';
import { audit, diff } from '../../core/audit';
import type { ActorRef } from '../../core/context';
import { dateOnly, parseDateOnly } from '../../lib/json';

const productInclude = {
  category: true,
  brand: true,
  unit: true,
  buyingUnit: true,
  mixProduct: { include: { subProducts: true } },
} satisfies Prisma.ProductInclude;

type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

/** Lower-case code, names, brand and sub codes, searched with pg_trgm. */
export async function refreshSearchText(tx: Tx, productId: string): Promise<void> {
  const p = await tx.product.findUniqueOrThrow({
    where: { id: productId },
    include: { brand: true, category: true, subProducts: { select: { code: true } } },
  });
  const text = [
    p.code,
    p.name,
    p.printName,
    p.brand?.name ?? '',
    p.category?.name ?? '',
    ...p.subProducts.map((s) => s.code),
  ]
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  await tx.product.update({ where: { id: productId }, data: { searchText: text } });
}

/** "White Emulsion 4L" → "White Emulsion": the mix paint item is named after the paint, not the size. */
export function paintNameWithoutSize(name: string): string {
  const stripped = name
    .replace(/\s*\(?\d+(?:\.\d+)?\s*(?:l|ltr|ltrs|liters?|litres?|ml)\)?\s*$/i, '')
    .trim();
  return stripped || name;
}

async function litersUnit(tx: Tx) {
  const unit = await tx.unit.findFirst({ where: { nameKey: 'l', active: true } });
  if (!unit)
    throw new DomainError(
      'INVALID_STATE',
      'Add the unit "L" in the value manager first.',
      'unitId',
    );
  return unit;
}

/** A product sold loose gets a mix paint item counted in liters: 20001 feeds MP-20001. */
export async function ensureMixProduct(
  tx: Tx,
  product: {
    id: string;
    code: string;
    name: string;
    brandId: string | null;
    categoryId: string | null;
    mixProductId?: string | null;
  },
) {
  if (product.mixProductId) {
    const existing = await tx.product.findUnique({
      where: { id: product.mixProductId },
      include: { subProducts: true },
    });
    if (existing) return existing;
  }
  const code = mixPaintCode(product.code);
  let mix = await tx.product.findUnique({
    where: { codeKey: codeKey(code) },
    include: { subProducts: true },
  });
  if (!mix) {
    const unit = await litersUnit(tx);
    const name = `${paintNameWithoutSize(product.name)} (Mix Paint)`;
    mix = await tx.product.create({
      data: {
        code,
        codeKey: codeKey(code),
        name,
        nameKey: nameKey(name),
        printName: `${name.slice(0, 30)}`,
        type: 'MIX',
        unitId: unit.id,
        brandId: product.brandId,
        categoryId: product.categoryId,
        active: true,
      },
      include: { subProducts: true },
    });
    await tx.subProduct.create({
      data: { productId: mix.id, seq: 0, code, codeKey: codeKey(code), name, active: true },
    });
    await refreshSearchText(tx, mix.id);
  }
  await tx.product.update({
    where: { id: product.id },
    data: { mixProductId: mix.id },
  });
  return mix;
}

async function createMixItem(
  tx: Tx,
  product: {
    id: string;
    code: string;
    name: string;
    brandId: string | null;
    categoryId: string | null;
  },
) {
  return ensureMixProduct(tx, product);
}

async function assertRefs(
  tx: Tx,
  input: {
    categoryId?: string | null;
    brandId?: string | null;
    unitId: string;
    buyingUnitId?: string | null;
    mixProductId?: string | null;
  },
) {
  if (input.categoryId && !(await tx.category.findUnique({ where: { id: input.categoryId } }))) {
    throw new DomainError('VALIDATION', 'Unknown category.', 'categoryId');
  }
  if (input.brandId && !(await tx.brand.findUnique({ where: { id: input.brandId } }))) {
    throw new DomainError('VALIDATION', 'Unknown brand.', 'brandId');
  }
  if (!(await tx.unit.findUnique({ where: { id: input.unitId } })))
    throw new DomainError('VALIDATION', 'Unknown unit.', 'unitId');
  if (input.buyingUnitId && !(await tx.unit.findUnique({ where: { id: input.buyingUnitId } }))) {
    throw new DomainError('VALIDATION', 'Unknown buying unit.', 'buyingUnitId');
  }
  if (input.mixProductId) {
    const mix = await tx.product.findUnique({ where: { id: input.mixProductId } });
    if (!mix || mix.type !== 'MIX')
      throw new DomainError('VALIDATION', 'Pick a mix paint item (MP-).', 'mixProductId');
  }
}

export async function createProduct(tx: Tx, actor: ActorRef, raw: unknown) {
  const input = productInputSchema.parse(raw);
  await assertRefs(tx, input);
  let code: string;
  if (input.code) {
    code = input.code;
    if (await tx.product.findUnique({ where: { codeKey: codeKey(code) } })) {
      throw new DomainError('DUPLICATE', 'That code is taken.', 'code');
    }
  } else {
    const rows = await tx.$queryRaw<
      { code: string }[]
    >`SELECT code FROM products WHERE code ~ '^[0-9]{5}$'`;
    code = nextMainCode(rows.map((r) => r.code));
  }
  if (input.allowLooseSale && !input.packSize) {
    throw new DomainError(
      'VALIDATION',
      'A product sold loose needs its pack size in liters.',
      'packSize',
    );
  }
  const similar = await tx.product.findFirst({
    where: { nameKey: nameKey(input.name), type: 'STANDARD' },
  });
  const product = await tx.product.create({
    data: {
      code,
      codeKey: codeKey(code),
      name: input.name,
      nameKey: nameKey(input.name),
      printName: input.printName || input.name.slice(0, 40),
      description: input.description,
      categoryId: input.categoryId ?? null,
      brandId: input.brandId ?? null,
      unitId: input.unitId,
      packSize: input.packSize ?? null,
      buyingUnitId: input.buyingUnitId ?? null,
      piecesPerBox: input.piecesPerBox,
      reorderLevel: input.reorderLevel,
      reorderQty: input.reorderQty,
      allowLooseSale: input.allowLooseSale,
      trackExpiry: input.trackExpiry,
      active: input.active,
    },
  });
  if (input.allowLooseSale) {
    const mixId = input.mixProductId ?? (await createMixItem(tx, product)).id;
    await tx.product.update({ where: { id: product.id }, data: { mixProductId: mixId } });
  }
  await refreshSearchText(tx, product.id);
  const out = await getProduct(tx, product.id, { canSeeCost: true });
  await audit(tx, actor, {
    action: 'product.create',
    entity: 'product',
    entityId: product.id,
    after: out.product,
  });
  return {
    ...out,
    warnings: similar
      ? [`A product named "${similar.name}" (${similar.code}) already exists.`]
      : [],
  };
}

export async function updateProduct(tx: Tx, actor: ActorRef, id: string, raw: unknown) {
  const input = productInputSchema.parse(raw);
  const before = await tx.product.findUnique({
    where: { id },
    include: { subProducts: true, mixProduct: true },
  });
  if (!before) throw new DomainError('NOT_FOUND', 'Product not found.');
  await assertRefs(tx, input);
  const code = input.code ?? before.code;
  const codeChanged = codeKey(code) !== before.codeKey;
  if (codeChanged) {
    if (await tx.product.findUnique({ where: { codeKey: codeKey(code) } })) {
      throw new DomainError('DUPLICATE', 'That code is taken.', 'code');
    }
    if (!input.confirmCodeChange) {
      throw new DomainError(
        'CONFLICT',
        `Changing ${before.code} to ${code} renames its sub-product and mix paint codes, and old bills show the new code. History stays linked.`,
        'code',
        {
          warning: true,
          confirm: 'confirmCodeChange',
        },
      );
    }
  }
  if (input.allowLooseSale && !(input.packSize ?? before.packSize)) {
    throw new DomainError(
      'VALIDATION',
      'A product sold loose needs its pack size in liters.',
      'packSize',
    );
  }
  if (before.type === 'MIX' && input.allowLooseSale) {
    throw new DomainError(
      'VALIDATION',
      'A mix paint item is already sold loose.',
      'allowLooseSale',
    );
  }
  const data = {
    code,
    codeKey: codeKey(code),
    name: input.name,
    nameKey: nameKey(input.name),
    printName: input.printName || input.name.slice(0, 40),
    description: input.description,
    categoryId: input.categoryId ?? null,
    brandId: input.brandId ?? null,
    unitId: before.type === 'MIX' ? before.unitId : input.unitId,
    packSize: input.packSize ?? null,
    buyingUnitId: input.buyingUnitId ?? null,
    piecesPerBox: input.piecesPerBox,
    reorderLevel: input.reorderLevel,
    reorderQty: input.reorderQty,
    allowLooseSale: before.type === 'MIX' ? false : input.allowLooseSale,
    trackExpiry: input.trackExpiry,
    active: input.active,
  };
  await tx.product.update({ where: { id }, data });

  // Old bills, quotations and held bills follow the new code and name (the change is kept in
  // the rename history). A sub-product renamed on its own keeps its own name.
  let billLines = 0;
  for (const sp of before.subProducts) {
    const newCode = codeChanged
      ? before.type === 'MIX'
        ? code
        : subProductCode(code, sp.seq)
      : sp.code;
    const newName = sp.name === before.name ? input.name : sp.name;
    billLines += await renameOnOldBills(tx, sp.id, {
      code: [sp.code, newCode],
      name: [sp.name, newName],
      printName: [before.printName || sp.name, data.printName || newName],
    });
  }

  if (codeChanged) {
    for (const sp of before.subProducts) {
      const newCode = before.type === 'MIX' ? code : subProductCode(code, sp.seq);
      await tx.subProduct.update({
        where: { id: sp.id },
        data: { code: newCode, codeKey: codeKey(newCode) },
      });
    }
    // The mix paint item this product owns follows the new code (MP-10001 → MP-10050).
    if (before.mixProduct && before.mixProduct.codeKey === codeKey(mixPaintCode(before.code))) {
      const mpCode = mixPaintCode(code);
      if (!(await tx.product.findUnique({ where: { codeKey: codeKey(mpCode) } }))) {
        await tx.product.update({
          where: { id: before.mixProduct.id },
          data: { code: mpCode, codeKey: codeKey(mpCode) },
        });
        const mixSubs = await tx.subProduct.findMany({
          where: { productId: before.mixProduct.id },
        });
        await tx.subProduct.updateMany({
          where: { productId: before.mixProduct.id },
          data: { code: mpCode, codeKey: codeKey(mpCode) },
        });
        for (const ms of mixSubs) {
          billLines += await renameOnOldBills(tx, ms.id, { code: [ms.code, mpCode] });
        }
        await refreshSearchText(tx, before.mixProduct.id);
      }
    }
  }
  if (data.allowLooseSale && !before.mixProductId) {
    const mixId =
      input.mixProductId ?? (await createMixItem(tx, { ...before, code, name: input.name })).id;
    await tx.product.update({ where: { id }, data: { mixProductId: mixId } });
  } else if (
    data.allowLooseSale &&
    input.mixProductId &&
    input.mixProductId !== before.mixProductId
  ) {
    await tx.product.update({ where: { id }, data: { mixProductId: input.mixProductId } });
  } else if (!data.allowLooseSale && before.mixProductId) {
    await tx.product.update({ where: { id }, data: { mixProductId: null } });
  }
  // Sub-products copied their name from the main product; keep untouched copies in step.
  if (input.name !== before.name) {
    await tx.subProduct.updateMany({
      where: { productId: id, name: before.name },
      data: { name: input.name },
    });
  }
  await refreshSearchText(tx, id);
  const renamed = (['code', 'name', 'printName'] as const).filter((k) => before[k] !== data[k]);
  if (renamed.length) {
    await audit(tx, actor, {
      action: 'product.rename',
      entity: 'product',
      entityId: id,
      before: Object.fromEntries(renamed.map((k) => [k, before[k]])),
      after: Object.fromEntries(renamed.map((k) => [k, data[k]])),
      note: billLines
        ? `${billLines} line${billLines === 1 ? '' : 's'} on old bills now show the new ${renamed.includes('code') ? 'code' : 'name'}.`
        : 'No old bills had this item.',
    });
  }
  const changes = diff(before as unknown as Record<string, unknown>, data);
  if (changes.changed) {
    await audit(tx, actor, {
      action: 'product.update',
      entity: 'product',
      entityId: id,
      before: changes.before,
      after: changes.after,
    });
  }
  return getProduct(tx, id, { canSeeCost: true });
}

function productOut(p: ProductRow) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    printName: p.printName,
    description: p.description,
    type: p.type,
    category: p.category ? { id: p.category.id, name: p.category.name } : null,
    brand: p.brand ? { id: p.brand.id, name: p.brand.name } : null,
    unit: { id: p.unit.id, name: p.unit.name, allowsDecimal: p.unit.allowsDecimal },
    buyingUnit: p.buyingUnit ? { id: p.buyingUnit.id, name: p.buyingUnit.name } : null,
    packSize: p.packSize?.toFixed(3) ?? null,
    piecesPerBox: p.piecesPerBox,
    reorderLevel: p.reorderLevel.toFixed(3),
    reorderQty: p.reorderQty.toFixed(3),
    allowLooseSale: p.allowLooseSale,
    mixProduct: p.mixProduct
      ? { id: p.mixProduct.id, code: p.mixProduct.code, name: p.mixProduct.name }
      : null,
    trackExpiry: p.trackExpiry,
    active: p.active,
  };
}

type SubRow = Prisma.SubProductGetPayload<{ include: { supplier: true; balances: true } }>;

/** Cost privacy: cost, actual price and margin only for users with cost.item. */
export function subProductOut(sp: SubRow, canSeeCost: boolean, locations: Map<string, string>) {
  const total = sp.balances.reduce((s, b) => s.plus(D(b.qty)), D(0));
  return {
    id: sp.id,
    code: sp.code,
    seq: sp.seq,
    name: sp.name,
    description: sp.description,
    supplier: sp.supplier
      ? { id: sp.supplier.id, code: sp.supplier.code, name: sp.supplier.name }
      : null,
    rPrice: sp.rPrice.toFixed(2),
    wPrice: sp.wPrice.toFixed(2),
    salesDiscount: sp.salesDiscount.toFixed(2),
    salesPrice: sp.salesPrice.toFixed(2),
    maxDiscount: money(
      Decimal_min(D(sp.purchaseDiscount), D(sp.rPrice).minus(D(sp.costPrice))),
    ).toFixed(2),
    expiryDate: dateOnly(sp.expiryDate),
    firstReceivedAt: sp.firstReceivedAt,
    active: sp.active,
    totalStock: total.toFixed(3),
    /** Zero stock everywhere: hidden from billing and search until a return or purchase brings it back. */
    hidden: total.isZero(),
    stock: sp.balances
      .filter((b) => !D(b.qty).isZero())
      .map((b) => ({
        locationId: b.locationId,
        location: locations.get(b.locationId) ?? '',
        qty: b.qty.toFixed(3),
      })),
    ...(canSeeCost
      ? {
          marketValue: sp.marketValue.toFixed(2),
          purchaseDiscount: sp.purchaseDiscount.toFixed(2),
          costPrice: sp.costPrice.toFixed(2),
          actualPrice: sp.actualPrice.toFixed(2),
          margin: money(D(sp.salesPrice).minus(D(sp.actualPrice))).toFixed(2),
        }
      : {}),
  };
}

function Decimal_min(a: Decimal, b: Decimal): Decimal {
  return a.lessThan(b) ? a : b;
}

async function locationNames(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx.location.findMany({ select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function getProduct(tx: Tx, id: string, opts: { canSeeCost: boolean }) {
  const p = await tx.product.findUnique({ where: { id }, include: productInclude });
  if (!p) throw new DomainError('NOT_FOUND', 'Product not found.');
  const subs = await tx.subProduct.findMany({
    where: { productId: id },
    include: { supplier: true, balances: true },
    orderBy: { seq: 'asc' },
  });
  const locations = await locationNames(tx);
  const feeders =
    p.type === 'MIX'
      ? await tx.product.findMany({
          where: { mixProductId: id },
          select: { id: true, code: true, name: true, packSize: true },
        })
      : [];
  return {
    product: productOut(p),
    subProducts: subs.map((s) => subProductOut(s, opts.canSeeCost, locations)),
    feeders: feeders.map((f) => ({
      id: f.id,
      code: f.code,
      name: f.name,
      packSize: f.packSize?.toFixed(3) ?? null,
    })),
  };
}

export interface StockListFilters {
  q?: string;
  categoryId?: string;
  brandId?: string;
  supplierId?: string;
  locationId?: string;
  lowStock?: boolean;
  outOfStock?: boolean;
  expiringDays?: number;
  type?: 'STANDARD' | 'MIX';
  includeInactive?: boolean;
  page: number;
  pageSize: number;
}

/** The stock view: main products with total stock; Enter opens their sub-products. */
export async function listProducts(tx: Tx, f: StockListFilters) {
  const conds: Prisma.Sql[] = [];
  if (!f.includeInactive) conds.push(Prisma.sql`p.active`);
  if (f.type) conds.push(Prisma.sql`p.type = ${f.type}::"ProductType"`);
  if (f.categoryId) conds.push(Prisma.sql`p.category_id = ${f.categoryId}::uuid`);
  if (f.brandId) conds.push(Prisma.sql`p.brand_id = ${f.brandId}::uuid`);
  if (f.supplierId) {
    conds.push(
      Prisma.sql`EXISTS (SELECT 1 FROM sub_products s2 WHERE s2.product_id = p.id AND s2.supplier_id = ${f.supplierId}::uuid)`,
    );
  }
  for (const t of searchTokens(f.q ?? '').slice(0, 6)) {
    conds.push(Prisma.sql`(p.search_text LIKE ${`%${escapeLike(t)}%`} OR ${t} <% p.search_text)`);
  }
  if (f.expiringDays !== undefined) {
    const until = parseDateOnly(shopDate(new Date(Date.now() + f.expiringDays * 86_400_000)));
    conds.push(Prisma.sql`EXISTS (
      SELECT 1 FROM sub_products s3 JOIN stock_balances b3 ON b3.sub_product_id = s3.id
       WHERE s3.product_id = p.id AND b3.qty > 0 AND s3.expiry_date IS NOT NULL AND s3.expiry_date <= ${until}::date
         ${f.locationId ? Prisma.sql`AND b3.location_id = ${f.locationId}::uuid` : Prisma.empty})`);
  }
  const where = conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty;
  const having: Prisma.Sql[] = [];
  const stockExpr = f.locationId
    ? Prisma.sql`COALESCE(SUM(b.qty) FILTER (WHERE b.location_id = ${f.locationId}::uuid), 0)`
    : Prisma.sql`COALESCE(SUM(b.qty), 0)`;
  if (f.lowStock) having.push(Prisma.sql`${stockExpr} <= p.reorder_level AND p.reorder_level > 0`);
  if (f.outOfStock) having.push(Prisma.sql`${stockExpr} = 0`);
  const havingSql = having.length
    ? Prisma.sql`HAVING ${Prisma.join(having, ' AND ')}`
    : Prisma.empty;

  const base = Prisma.sql`
    FROM products p
    LEFT JOIN sub_products sp ON sp.product_id = p.id
    LEFT JOIN stock_balances b ON b.sub_product_id = sp.id
    ${where}
    GROUP BY p.id
    ${havingSql}`;
  const rows = await tx.$queryRaw<{ id: string; stock: string; subs: number; total: number }[]>`
    SELECT p.id, ${stockExpr}::text AS stock,
           COUNT(DISTINCT sp.id) FILTER (WHERE b.qty > 0)::int AS subs,
           COUNT(*) OVER ()::int AS total
    ${base}
    ORDER BY p.name ASC, p.code ASC
    LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`;
  const products = await tx.product.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    include: productInclude,
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  return {
    items: rows.map((r) => {
      const p = byId.get(r.id)!;
      const stock = D(r.stock);
      return {
        ...productOut(p),
        stock: stock.toFixed(3),
        subProductsInStock: r.subs,
        lowStock: D(p.reorderLevel).greaterThan(0) && stock.lessThanOrEqualTo(D(p.reorderLevel)),
        outOfStock: stock.isZero(),
      };
    }),
    total: rows[0]?.total ?? 0,
    page: f.page,
    pageSize: f.pageSize,
  };
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Auto-suggest for products. Codes, sub codes, names and brands are typed in either field;
 * matching forgives typos and word order ("thin 4" finds "Thinner 4L"), and recent and
 * frequent items come first. Uses the trigram index so results arrive in well under 100 ms.
 */
export async function searchProductIds(
  tx: Tx,
  q: string,
  opts: { types: ('STANDARD' | 'MIX')[]; limit: number },
): Promise<{ id: string; matchedSubProductId: string | null }[]> {
  const query = q.trim();
  if (!query) return [];
  const tokens = searchTokens(query).slice(0, 6);
  const ck = codeKey(query);
  const tokenConds = tokens.map(
    (t) => Prisma.sql`(p.search_text LIKE ${`%${escapeLike(t)}%`} OR ${t} <% p.search_text)`,
  );
  const rows = await tx.$queryRaw<{ id: string; matched_sub: string | null }[]>`
    SELECT p.id,
           (SELECT s.id FROM sub_products s WHERE s.product_id = p.id AND s.code_key = ${ck} LIMIT 1) AS matched_sub
      FROM products p
      LEFT JOIN (
        SELECT sl.product_id, COUNT(*) AS n
          FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
         WHERE s.completed_at > now() - interval '30 days'
         GROUP BY sl.product_id
      ) f ON f.product_id = p.id
     WHERE p.active
       AND p.type = ANY(${opts.types}::"ProductType"[])
       AND (
         p.code_key = ${ck}
         OR EXISTS (SELECT 1 FROM sub_products s WHERE s.product_id = p.id AND s.code_key = ${ck})
         OR (${Prisma.join(tokenConds, ' AND ')})
       )
     ORDER BY
       (EXISTS (SELECT 1 FROM sub_products s WHERE s.product_id = p.id AND s.code_key = ${ck})) DESC,
       (p.code_key = ${ck}) DESC,
       (p.code_key LIKE ${`${escapeLike(ck)}%`}) DESC,
       COALESCE(f.n, 0) DESC,
       word_similarity(${query.toLowerCase()}, p.search_text) DESC,
       p.name ASC
     LIMIT ${opts.limit}`;
  return rows.map((r) => ({ id: r.id, matchedSubProductId: r.matched_sub }));
}

/** Stock-side auto-suggest (purchases, transfers, adjustments): stock and unit. */
export async function searchForStock(
  tx: Tx,
  q: string,
  opts: { locationId: string; includeMix: boolean; canSeeCost: boolean; supplierId?: string },
) {
  const hits = await searchProductIds(tx, q, {
    types: opts.includeMix ? ['STANDARD', 'MIX'] : ['STANDARD'],
    limit: 20,
  });
  if (!hits.length) return [];
  const products = await tx.product.findMany({
    where: { id: { in: hits.map((h) => h.id) } },
    include: productInclude,
  });
  const stock = await tx.$queryRaw<{ product_id: string; here: string; total: string }[]>`
    SELECT sp.product_id,
           COALESCE(SUM(b.qty) FILTER (WHERE b.location_id = ${opts.locationId}::uuid), 0)::text AS here,
           COALESCE(SUM(b.qty), 0)::text AS total
      FROM sub_products sp LEFT JOIN stock_balances b ON b.sub_product_id = sp.id
     WHERE sp.product_id = ANY(${hits.map((h) => h.id)}::uuid[])
     GROUP BY sp.product_id`;
  const stockBy = new Map(stock.map((s) => [s.product_id, s]));
  // The last purchase prices pre-fill a new GRN line for people allowed to see cost.
  const last = opts.canSeeCost
    ? await tx.purchaseLine.findMany({
        where: {
          productId: { in: hits.map((h) => h.id) },
          purchase: {
            status: 'POSTED',
            ...(opts.supplierId ? { supplierId: opts.supplierId } : {}),
          },
        },
        orderBy: { purchase: { postedAt: 'desc' } },
        distinct: ['productId'],
      })
    : [];
  const lastBy = new Map(last.map((l) => [l.productId, l]));
  const byId = new Map(products.map((p) => [p.id, p]));
  return hits
    .filter((h) => byId.has(h.id))
    .map((h) => {
      const p = byId.get(h.id)!;
      const s = stockBy.get(h.id);
      const l = lastBy.get(h.id);
      return {
        ...productOut(p),
        matchedSubProductId: h.matchedSubProductId,
        stockHere: s?.here ?? '0',
        stockTotal: s?.total ?? '0',
        lastPurchase: l
          ? {
              value: l.value.toFixed(2),
              discount: { type: l.discountType, value: l.discountValue.toFixed(2) },
              rPrice: l.rPrice.toFixed(2),
              wPrice: l.wPrice.toFixed(2),
              salesDiscount: { type: l.salesDiscountType, value: l.salesDiscountValue.toFixed(2) },
            }
          : null,
      };
    });
}

/** Edit name and description on a sub-product; every edit is logged. */
export async function editSubProduct(tx: Tx, actor: ActorRef, id: string, raw: unknown) {
  const input = subProductEditSchema.parse(raw);
  const before = await tx.subProduct.findUnique({ where: { id } });
  if (!before) throw new DomainError('NOT_FOUND', 'Sub-product not found.');
  const data = {
    name: input.name ? cleanName(input.name) : before.name,
    description: input.description ?? before.description,
  };
  await tx.subProduct.update({ where: { id }, data });
  if (data.name !== before.name) {
    const product = await tx.product.findUniqueOrThrow({ where: { id: before.productId } });
    const lines = await renameOnOldBills(tx, id, {
      name: [before.name, data.name],
      printName: product.printName ? undefined : [before.name, data.name],
    });
    await audit(tx, actor, {
      action: 'product.rename',
      entity: 'product',
      entityId: before.productId,
      before: { subProduct: before.code, name: before.name },
      after: { subProduct: before.code, name: data.name },
      note: lines
        ? `${lines} line${lines === 1 ? '' : 's'} on old bills now show the new name.`
        : 'No old bills had this item.',
    });
  }
  const changes = diff(before as unknown as Record<string, unknown>, data);
  if (changes.changed) {
    await audit(tx, actor, {
      action: 'sub_product.update',
      entity: 'sub_product',
      entityId: id,
      before: changes.before,
      after: changes.after,
    });
  }
}

/**
 * Admins can change the selling prices of one sub-product, or of all sub-products of a main
 * product at once. Every change is kept in price history.
 */
export async function changePrices(
  tx: Tx,
  actor: ActorRef & { userId: string },
  productId: string,
  raw: unknown,
) {
  const input = priceChangeSchema.parse(raw);
  const product = await tx.product.findUnique({ where: { id: productId } });
  if (!product) throw new DomainError('NOT_FOUND', 'Product not found.');
  if (product.type === 'MIX') {
    throw new DomainError('INVALID_STATE', 'Change a mix paint price from the mix paint screen.');
  }
  if (!input.rPrice && !input.wPrice && !input.salesDiscount && !input.salesPrice) {
    throw new DomainError('VALIDATION', 'Enter at least one new price.');
  }
  const subs = await tx.subProduct.findMany({
    where: {
      productId,
      ...(input.subProductIds.length ? { id: { in: input.subProductIds } } : {}),
    },
    orderBy: { seq: 'asc' },
  });
  if (!subs.length) throw new DomainError('NOT_FOUND', 'No sub-products to change.');
  const changed = [];
  for (const sp of subs) {
    const r = input.rPrice ? D(input.rPrice) : D(sp.rPrice);
    let disc: Decimal;
    if (input.salesPrice) disc = money(r.minus(D(input.salesPrice)));
    else if (input.salesDiscount) disc = discountPerUnit(r, input.salesDiscount);
    else disc = D(sp.salesDiscount);
    const sales = money(r.minus(disc));
    const w = input.wPrice ? D(input.wPrice) : D(sp.wPrice);
    const where = `${sp.code}: `;
    if (disc.isNegative())
      throw new DomainError(
        'PRICE_ABOVE_R_PRICE',
        `${where}the sales price cannot be above the R-price.`,
        'salesPrice',
      );
    if (disc.greaterThan(D(sp.purchaseDiscount))) {
      throw new DomainError(
        'DISCOUNT_ABOVE_LIMIT',
        `${where}the sales discount cannot be more than the purchase discount.`,
        'salesDiscount',
      );
    }
    if (sales.lessThan(D(sp.costPrice)))
      throw new DomainError(
        'BELOW_COST',
        `${where}the sales price cannot be below cost.`,
        'salesPrice',
      );
    if (w.lessThan(D(sp.actualPrice)) || w.greaterThan(r)) {
      throw new DomainError(
        'VALIDATION',
        `${where}the W-price must be between the actual price and the R-price.`,
        'wPrice',
      );
    }
    if (r.equals(D(sp.rPrice)) && w.equals(D(sp.wPrice)) && disc.equals(D(sp.salesDiscount)))
      continue;
    await tx.subProduct.update({
      where: { id: sp.id },
      data: {
        rPrice: r.toFixed(2),
        wPrice: w.toFixed(2),
        salesDiscount: disc.toFixed(2),
        salesPrice: sales.toFixed(2),
      },
    });
    await tx.priceHistory.create({
      data: {
        subProductId: sp.id,
        changedById: actor.userId,
        source: subs.length > 1 ? 'BULK' : 'MANUAL',
        oldRPrice: sp.rPrice,
        newRPrice: r.toFixed(2),
        oldWPrice: sp.wPrice,
        newWPrice: w.toFixed(2),
        oldSalesDiscount: sp.salesDiscount,
        newSalesDiscount: disc.toFixed(2),
        oldSalesPrice: sp.salesPrice,
        newSalesPrice: sales.toFixed(2),
        note: input.note,
      },
    });
    changed.push({
      id: sp.id,
      code: sp.code,
      rPrice: r.toFixed(2),
      wPrice: w.toFixed(2),
      salesPrice: sales.toFixed(2),
    });
  }
  if (changed.length) {
    await audit(tx, actor, {
      action: 'price.change',
      entity: 'product',
      entityId: productId,
      after: { changed, note: input.note },
    });
  }
  return { changed };
}

/** Item card: every movement of an item with a running balance (bin card). */
export async function binCard(
  tx: Tx,
  subProductId: string,
  opts: { locationId?: string; from?: string; to?: string; canSeeCost: boolean },
) {
  const sp = await tx.subProduct.findUnique({
    where: { id: subProductId },
    include: { product: { include: { unit: true } } },
  });
  if (!sp) throw new DomainError('NOT_FOUND', 'Sub-product not found.');
  const fromAt = opts.from ? new Date(`${opts.from}T00:00:00+05:30`) : null;
  const toAt = opts.to ? new Date(`${opts.to}T23:59:59.999+05:30`) : null;
  const locWhere = opts.locationId ? { locationId: opts.locationId } : {};
  let opening = D(0);
  if (fromAt) {
    const agg = await tx.stockMovement.aggregate({
      where: { subProductId, ...locWhere, at: { lt: fromAt } },
      _sum: { qty: true },
    });
    opening = D(agg._sum.qty ?? 0);
  }
  const moves = await tx.stockMovement.findMany({
    where: {
      subProductId,
      ...locWhere,
      at: { ...(fromAt ? { gte: fromAt } : {}), ...(toAt ? { lte: toAt } : {}) },
    },
    include: { user: { select: { fullName: true } }, location: { select: { name: true } } },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
  });
  let running = opening;
  return {
    subProduct: { id: sp.id, code: sp.code, name: sp.name, unit: sp.product.unit.name },
    openingBalance: opening.toFixed(3),
    rows: moves.map((m) => {
      running = running.plus(D(m.qty));
      return {
        id: m.id,
        at: m.at,
        type: m.type,
        docId: m.docId,
        docNo: m.docNo,
        location: m.location.name,
        in: D(m.qty).greaterThan(0) ? m.qty.toFixed(3) : null,
        out: D(m.qty).lessThan(0) ? D(m.qty).negated().toFixed(3) : null,
        balance: running.toFixed(3),
        user: m.user.fullName,
        note: m.note,
        ...(opts.canSeeCost ? { unitCost: m.unitCost.toFixed(2) } : {}),
      };
    }),
    closingBalance: running.toFixed(3),
  };
}

export async function priceHistory(tx: Tx, subProductId: string) {
  const rows = await tx.priceHistory.findMany({
    where: { subProductId },
    include: { changedBy: { select: { fullName: true } } },
    orderBy: { at: 'desc' },
  });
  return rows.map((r) => ({
    at: r.at,
    source: r.source,
    by: r.changedBy.fullName,
    rPrice: [r.oldRPrice?.toFixed(2) ?? null, r.newRPrice.toFixed(2)],
    wPrice: [r.oldWPrice?.toFixed(2) ?? null, r.newWPrice.toFixed(2)],
    salesPrice: [r.oldSalesPrice?.toFixed(2) ?? null, r.newSalesPrice.toFixed(2)],
    note: r.note,
  }));
}

type Rename = [from: string, to: string];

/**
 * Old bills show the item's current code and name: lines of one sub-product that still carry
 * the old text get the new one. Prices, quantities and totals never change. Returns how many
 * bill lines changed.
 */
async function renameOnOldBills(
  tx: Tx,
  subProductId: string,
  r: { code?: Rename | undefined; name?: Rename | undefined; printName?: Rename | undefined },
): Promise<number> {
  const same: Rename = ['', ''];
  const [c0, c1] = r.code && r.code[0] !== r.code[1] ? r.code : same;
  const [n0, n1] = r.name && r.name[0] !== r.name[1] ? r.name : same;
  const [p0, p1] = r.printName && r.printName[0] !== r.printName[1] ? r.printName : same;
  if (!c0 && !n0 && !p0) return 0;
  return tx.$executeRaw`
    UPDATE sale_lines SET
      code = CASE WHEN ${c0} <> '' AND code = ${c0} THEN ${c1} ELSE code END,
      name = CASE WHEN ${n0} <> '' AND name = ${n0} THEN ${n1} ELSE name END,
      print_name = CASE WHEN ${p0} <> '' AND print_name = ${p0} THEN ${p1} ELSE print_name END
    WHERE sub_product_id = ${subProductId}::uuid
      AND ((${c0} <> '' AND code = ${c0})
        OR (${n0} <> '' AND name = ${n0})
        OR (${p0} <> '' AND print_name = ${p0}))`;
}

/** Every code and name change of a product, newest first, for the Super Admin. */
export async function renameHistory(tx: Tx | Db, productId: string) {
  const rows = await tx.auditLog.findMany({
    where: { entity: 'product', entityId: productId, action: 'product.rename' },
    orderBy: { at: 'desc' },
    take: 100,
  });
  const userIds = [...new Set(rows.map((r) => r.userId).filter((x): x is string => Boolean(x)))];
  const users = await tx.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, fullName: true },
  });
  const names = new Map(users.map((u) => [u.id, u.fullName]));
  return rows.map((r) => {
    const b = (r.before ?? {}) as Record<string, string>;
    const a = (r.after ?? {}) as Record<string, string>;
    const fields = (['code', 'name', 'printName'] as const).filter((k) => k in a);
    return {
      at: r.at,
      by: r.userId ? (names.get(r.userId) ?? 'Removed user') : 'System',
      subProduct: a.subProduct ?? null,
      changes: fields.map((k) => ({ field: k, from: b[k] ?? '', to: a[k] ?? '' })),
      note: r.note,
    };
  });
}
