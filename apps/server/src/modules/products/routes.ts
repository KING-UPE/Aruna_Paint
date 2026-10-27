import { dateSchema, idSchema, paginationSchema } from '@aruna/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canSeeItemCost, perm, shopOnly, superAdminOnly } from '../../auth/guard';
import { actorOf } from '../../core/context';
import { TX_OPTIONS } from '../../db';
import {
  binCard,
  changePrices,
  createProduct,
  editSubProduct,
  getProduct,
  listProducts,
  priceHistory,
  renameHistory,
  renameProduct,
  searchForStock,
  updateProduct,
} from './service';

const bool = z
  .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
  .transform((v) => v === true || v === '1' || v === 'true');

export async function productRoutes(app: FastifyInstance) {
  const { db, events } = app.deps;
  const idParam = (p: unknown) => idSchema.parse((p as { id: string }).id);

  app.get('/api/products', { preHandler: perm('products.view', 'stock.view') }, async (req) => {
    const q = paginationSchema
      .extend({
        q: z.string().optional(),
        categoryId: idSchema.optional(),
        brandId: idSchema.optional(),
        supplierId: idSchema.optional(),
        locationId: idSchema.optional(),
        lowStock: bool.optional(),
        outOfStock: bool.optional(),
        expiringDays: z.coerce.number().int().min(0).max(3650).optional(),
        type: z.enum(['STANDARD', 'MIX']).optional(),
        includeInactive: bool.optional(),
      })
      .parse(req.query);
    return listProducts(db, q);
  });

  /** Item auto-suggest for purchases, transfers, adjustments, reorder and reports. */
  app.get(
    '/api/products/search',
    { preHandler: perm('products.view', 'stock.view', 'purchases.view') },
    async (req) => {
      const q = z
        .object({
          q: z.string().default(''),
          includeMix: bool.default(false),
          supplierId: idSchema.optional(),
          locationId: idSchema.optional(),
        })
        .parse(req.query);
      return {
        items: await searchForStock(db, q.q, {
          locationId: q.locationId ?? req.ctx.locationId,
          includeMix: q.includeMix,
          canSeeCost: canSeeItemCost(req),
          supplierId: q.supplierId,
        }),
      };
    },
  );

  app.get('/api/products/:id', { preHandler: perm('products.view', 'stock.view') }, async (req) =>
    getProduct(db, idParam(req.params), { canSeeCost: canSeeItemCost(req) }),
  );

  /** "10001 was changed to 20001": every code and name change, for the Super Admin. */
  app.get('/api/products/:id/renames', { preHandler: superAdminOnly() }, async (req) => ({
    items: await renameHistory(db, idParam(req.params)),
  }));

  app.post('/api/products', { preHandler: [shopOnly(), perm('products.create')] }, async (req) => {
    const out = await db.$transaction(
      (tx) => createProduct(tx, actorOf(req.ctx), req.body),
      TX_OPTIONS,
    );
    events.publish({ type: 'products' });
    return out;
  });

  /** Quick edit from the list: code and name of the product and of each sub-product. */
  app.patch(
    '/api/products/:id/names',
    { preHandler: [shopOnly(), perm('products.edit')] },
    async (req) => {
      const out = await db.$transaction(
        (tx) => renameProduct(tx, actorOf(req.ctx), idParam(req.params), req.body),
        TX_OPTIONS,
      );
      events.publish({ type: 'products' });
      return canSeeItemCost(req)
        ? out
        : await getProduct(db, out.product.id, { canSeeCost: false });
    },
  );

  app.put('/api/products/:id', { preHandler: [shopOnly(), perm('products.edit')] }, async (req) => {
    const out = await db.$transaction(
      (tx) => updateProduct(tx, actorOf(req.ctx), idParam(req.params), req.body),
      TX_OPTIONS,
    );
    events.publish({ type: 'products' });
    // Cost privacy: only cost viewers get cost fields back.
    return canSeeItemCost(req) ? out : await getProduct(db, out.product.id, { canSeeCost: false });
  });

  app.post(
    '/api/products/:id/prices',
    { preHandler: [shopOnly(), perm('products.edit')] },
    async (req) => {
      const out = await db.$transaction(
        (tx) =>
          changePrices(
            tx,
            { ...actorOf(req.ctx), userId: req.ctx.user.id },
            idParam(req.params),
            req.body,
          ),
        TX_OPTIONS,
      );
      events.publish({ type: 'products' });
      return out;
    },
  );

  app.patch(
    '/api/sub-products/:id',
    { preHandler: [shopOnly(), perm('products.edit', 'stock.edit')] },
    async (req) => {
      await db.$transaction(
        (tx) => editSubProduct(tx, actorOf(req.ctx), idParam(req.params), req.body),
        TX_OPTIONS,
      );
      return { ok: true };
    },
  );

  app.get('/api/sub-products/:id/bin-card', { preHandler: perm('stock.view') }, async (req) => {
    const q = z
      .object({
        locationId: idSchema.optional(),
        from: dateSchema.optional(),
        to: dateSchema.optional(),
      })
      .parse(req.query);
    return binCard(db, idParam(req.params), { ...q, canSeeCost: canSeeItemCost(req) });
  });

  app.get(
    '/api/sub-products/:id/price-history',
    { preHandler: perm('products.view', 'stock.view') },
    async (req) => ({
      items: await priceHistory(db, idParam(req.params)),
    }),
  );
}
