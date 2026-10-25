import { idSchema, mixTransferSchema } from '@aruna/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireApproval } from '../../auth/approvals';
import { canSeeItemCost, perm, shopOnly } from '../../auth/guard';
import { actorOf } from '../../core/context';
import { TX_OPTIONS } from '../../db';
import { mixStatus, transferToMix } from './service';

export async function mixPaintRoutes(app: FastifyInstance) {
  const { db, events, config } = app.deps;

  app.get(
    '/api/mix-paint/:id',
    { preHandler: perm('mix_paint.view', 'billing.view') },
    async (req) => {
      const id = idSchema.parse((req.params as { id: string }).id);
      const q = z.object({ locationId: idSchema.optional() }).parse(req.query);
      return mixStatus(db, id, q.locationId ?? req.ctx.locationId, canSeeItemCost(req));
    },
  );

  /**
   * Stock Managers and Admins move cans. At the counter a cashier sends one of their PINs;
   * changing the price per liter from the counter also needs an Admin.
   */
  app.post(
    '/api/mix-paint/transfers',
    { preHandler: [shopOnly(), perm('mix_paint.view', 'billing.create')] },
    async (req) => {
      const input = mixTransferSchema.parse(req.body);
      const result = await db.$transaction(async (tx) => {
        const { approverId, override } = await requireApproval(
          tx,
          req.ctx,
          'OPEN_CAN',
          input.approval,
          config.pinSecret,
        );
        return transferToMix(
          tx,
          { ...actorOf(req.ctx), userId: req.ctx.user.id },
          { ...input, locationId: input.locationId ?? req.ctx.locationId },
          { approverId, fromCounter: override || !req.ctx.permissions.has('mix_paint.create') },
        );
      }, TX_OPTIONS);
      events.publish({
        type: 'stock',
        subProductIds: [result.mixSubProductId, result.sourceSubProductId],
      });
      return result;
    },
  );

  app.get('/api/mix-paint/transfers', { preHandler: perm('mix_paint.view') }, async (req) => {
    const canSeeCost = canSeeItemCost(req);
    const rows = await db.mpTransfer.findMany({
      include: {
        sourceSubProduct: { select: { code: true, name: true } },
        mixSubProduct: { select: { code: true, name: true } },
        createdBy: { select: { fullName: true } },
        approvedBy: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        no: r.no,
        at: r.createdAt,
        source: r.sourceSubProduct,
        mix: r.mixSubProduct,
        cans: r.cans,
        liters: r.liters.toFixed(3),
        oldPricePerLiter: r.oldPricePerLiter.toFixed(2),
        newPricePerLiter: r.newPricePerLiter.toFixed(2),
        fromCounter: r.fromCounter,
        by: r.createdBy.fullName,
        approvedBy: r.approvedBy?.fullName ?? null,
        ...(canSeeCost
          ? {
              costPerLiter: r.costPerLiter.toFixed(2),
              oldAverageCost: r.oldAverageCost.toFixed(2),
              newAverageCost: r.newAverageCost.toFixed(2),
            }
          : {}),
      })),
    };
  });
}
