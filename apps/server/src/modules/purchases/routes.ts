import { dateSchema, idSchema, paginationSchema, purchaseReverseSchema } from '@aruna/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireApproval } from '../../auth/approvals';
import { canSeeItemCost, perm, shopOnly } from '../../auth/guard';
import { actorOf } from '../../core/context';
import { TX_OPTIONS } from '../../db';
import {
  createPurchase,
  deleteDraft,
  duplicateInvoice,
  getPurchase,
  listPurchases,
  postPurchase,
  reopenPurchase,
  reversePurchase,
  updatePurchase,
} from './service';

export async function purchaseRoutes(app: FastifyInstance) {
  const { db, events, config } = app.deps;
  const idParam = (p: unknown) => idSchema.parse((p as { id: string }).id);
  const actor = (req: { ctx: Parameters<typeof actorOf>[0] }) => ({
    ...actorOf(req.ctx),
    userId: req.ctx.user.id,
  });

  app.get('/api/purchases', { preHandler: perm('purchases.view') }, async (req) => {
    const q = paginationSchema
      .extend({
        supplierId: idSchema.optional(),
        status: z.enum(['DRAFT', 'POSTED', 'REVERSED']).optional(),
        from: dateSchema.optional(),
        to: dateSchema.optional(),
        q: z.string().optional(),
      })
      .parse(req.query);
    return listPurchases(db, q);
  });

  app.get('/api/purchases/check-invoice', { preHandler: perm('purchases.view') }, async (req) => {
    const q = z
      .object({ supplierId: idSchema, invoiceNo: z.string(), exceptId: idSchema.optional() })
      .parse(req.query);
    return { duplicate: await duplicateInvoice(db, q.supplierId, q.invoiceNo, q.exceptId) };
  });

  app.get('/api/purchases/:id', { preHandler: perm('purchases.view') }, async (req) =>
    getPurchase(db, idParam(req.params), canSeeItemCost(req)),
  );

  /** Save as draft, or save and post in one step (Ctrl+Enter) with `post`. */
  app.post(
    '/api/purchases',
    { preHandler: [shopOnly(), perm('purchases.create')] },
    async (req) => {
      const body = req.body as { post?: unknown } & Record<string, unknown>;
      const result = await db.$transaction(async (tx) => {
        const id = await createPurchase(tx, actor(req), req.ctx.locationId, body);
        if (body.post) return postPurchase(tx, actor(req), id, body.post === true ? {} : body.post);
        return { id };
      }, TX_OPTIONS);
      if ('subProductIds' in result)
        events.publish({ type: 'stock', subProductIds: result.subProductIds });
      return result;
    },
  );

  app.put(
    '/api/purchases/:id',
    { preHandler: [shopOnly(), perm('purchases.edit', 'purchases.create')] },
    async (req) => {
      await db.$transaction(
        (tx) => updatePurchase(tx, actor(req), idParam(req.params), req.ctx.locationId, req.body),
        TX_OPTIONS,
      );
      return { ok: true };
    },
  );

  app.delete(
    '/api/purchases/:id',
    { preHandler: [shopOnly(), perm('purchases.edit', 'purchases.create')] },
    async (req) => {
      await db.$transaction((tx) => deleteDraft(tx, actor(req), idParam(req.params)), TX_OPTIONS);
      return { ok: true };
    },
  );

  app.post(
    '/api/purchases/:id/post',
    { preHandler: [shopOnly(), perm('purchases.create')] },
    async (req) => {
      const result = await db.$transaction(
        (tx) => postPurchase(tx, actor(req), idParam(req.params), req.body),
        TX_OPTIONS,
      );
      events.publish({ type: 'stock', subProductIds: result.subProductIds });
      return result;
    },
  );

  app.post(
    '/api/purchases/:id/reopen',
    { preHandler: [shopOnly(), perm('purchases.edit')] },
    async (req) => {
      await db.$transaction(
        (tx) => reopenPurchase(tx, actor(req), idParam(req.params)),
        TX_OPTIONS,
      );
      events.publish({ type: 'products' });
      return { ok: true };
    },
  );

  app.post(
    '/api/purchases/:id/reverse',
    { preHandler: [shopOnly(), perm('purchases.view')] },
    async (req) => {
      const body = purchaseReverseSchema.parse(req.body);
      const subIds = await db.$transaction(async (tx) => {
        const { approverId } = await requireApproval(
          tx,
          req.ctx,
          'REVERSE_PURCHASE',
          body.approval,
          config.pinSecret,
        );
        return reversePurchase(tx, actor(req), idParam(req.params), body.reason, approverId);
      }, TX_OPTIONS);
      events.publish({ type: 'stock', subProductIds: subIds });
      return { ok: true };
    },
  );
}
