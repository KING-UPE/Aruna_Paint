import { D, money } from '@aruna/shared';
import { Prisma } from '@prisma/client';
import type { Tx } from '../../db';
import { searchProductIds } from '../products/service';

/**
 * Billing auto-suggest: code, sub code, name or brand typed in either field. Each item comes with
 * its in-stock batches at this counter's location (oldest first) so the screen can price lines,
 * open the multi-price pop-up and split a qty first-in, first-out exactly as the server will.
 * Cost is never sent; `maxDiscount` is the most a line can get (the purchase discount, kept
 * above cost).
 */
export async function billingItems(tx: Tx, q: string, locationId: string, limit = 15) {
  const hits = await searchProductIds(tx, q, { types: ['STANDARD'], limit });
  if (!hits.length) return [];
  return describeItems(tx, hits, locationId);
}

export async function describeItems(
  tx: Tx,
  hits: { id: string; matchedSubProductId: string | null }[],
  locationId: string,
) {
  const ids = hits.map((h) => h.id);
  const products = await tx.product.findMany({
    where: { id: { in: ids } },
    include: {
      unit: true,
      mixProduct: { include: { subProducts: { orderBy: { seq: 'asc' }, take: 1 } } },
    },
  });
  const batches = await tx.$queryRaw<
    {
      id: string;
      product_id: string;
      code: string;
      available: string;
      first_received_at: Date | null;
      expiry_date: Date | null;
      r_price: string;
      w_price: string;
      sales_price: string;
      sales_discount: string;
      purchase_discount: string;
      cost_price: string;
    }[]
  >`
    SELECT sp.id, sp.product_id, sp.code, b.qty::text AS available, sp.first_received_at, sp.expiry_date,
           sp.r_price::text, sp.w_price::text, sp.sales_price::text, sp.sales_discount::text,
           sp.purchase_discount::text, sp.cost_price::text
      FROM sub_products sp
      JOIN stock_balances b ON b.sub_product_id = sp.id AND b.location_id = ${locationId}::uuid
     WHERE sp.product_id = ANY(${ids}::uuid[]) AND sp.active AND b.qty > 0
     ORDER BY sp.first_received_at ASC NULLS FIRST, sp.seq ASC`;
  const elsewhere = await tx.$queryRaw<{ product_id: string; qty: string }[]>`
    SELECT sp.product_id, COALESCE(SUM(b.qty), 0)::text AS qty
      FROM sub_products sp
      JOIN stock_balances b ON b.sub_product_id = sp.id
      JOIN locations l ON l.id = b.location_id
     WHERE sp.product_id = ANY(${ids}::uuid[]) AND b.location_id <> ${locationId}::uuid AND l.kind <> 'DAMAGED'
     GROUP BY sp.product_id`;
  const mixIds = products.flatMap((p) =>
    p.mixProduct?.subProducts[0] ? [p.mixProduct.subProducts[0].id] : [],
  );
  const mixStock = mixIds.length
    ? await tx.stockBalance.findMany({ where: { subProductId: { in: mixIds }, locationId } })
    : [];
  const mixBy = new Map(mixStock.map((m) => [m.subProductId, m.qty.toFixed(3)]));
  const elsewhereBy = new Map(elsewhere.map((e) => [e.product_id, e.qty]));
  const byId = new Map(products.map((p) => [p.id, p]));

  return hits
    .filter((h) => byId.has(h.id))
    .map((h) => {
      const p = byId.get(h.id)!;
      const own = batches.filter((b) => b.product_id === p.id);
      const mix = p.mixProduct?.subProducts[0];
      return {
        productId: p.id,
        code: p.code,
        name: p.name,
        printName: p.printName,
        unit: { name: p.unit.name, allowsDecimal: p.unit.allowsDecimal },
        packSize: p.packSize?.toFixed(3) ?? null,
        allowLooseSale: p.allowLooseSale && Boolean(mix),
        matchedSubProductId: h.matchedSubProductId,
        stockHere: own.reduce((s, b) => s.plus(D(b.available)), D(0)).toFixed(3),
        stockElsewhere: D(elsewhereBy.get(p.id) ?? 0).toFixed(3),
        batches: own.map((b) => ({
          id: b.id,
          code: b.code,
          available: D(b.available).toFixed(3),
          firstReceivedAt: b.first_received_at ?? new Date(0),
          expiryDate: b.expiry_date ? b.expiry_date.toISOString().slice(0, 10) : null,
          rPrice: money(b.r_price).toFixed(2),
          wPrice: money(b.w_price).toFixed(2),
          salesPrice: money(b.sales_price).toFixed(2),
          salesDiscount: money(b.sales_discount).toFixed(2),
          maxDiscount: money(
            Prisma.Decimal.max(
              0,
              Prisma.Decimal.min(D(b.purchase_discount), D(b.r_price).minus(D(b.cost_price))),
            ),
          ).toFixed(2),
        })),
        mix:
          p.mixProduct && mix
            ? {
                productId: p.mixProduct.id,
                subProductId: mix.id,
                code: mix.code,
                name: p.mixProduct.name,
                litersHere: mixBy.get(mix.id) ?? '0.000',
                pricePerLiter: mix.salesPrice.toFixed(2),
                wPricePerLiter: mix.wPrice.toFixed(2),
              }
            : null,
      };
    });
}

export type BillingItem = Awaited<ReturnType<typeof describeItems>>[number];
