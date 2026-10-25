import { D, adjustmentSchema, idSchema } from '@aruna/shared';
import type { FastifyInstance } from 'fastify';
import { requireApproval } from '../../auth/approvals';
import { perm, shopOnly } from '../../auth/guard';
import { actorOf } from '../../core/context';
import { TX_OPTIONS } from '../../db';
import { createAdjustment, createTransfer } from './service';

export async function stockRoutes(app: FastifyInstance) {
  const { db, events, config } = app.deps;
  const actor = (req: { ctx: Parameters<typeof actorOf>[0] }) => ({
    ...actorOf(req.ctx),
    userId: req.ctx.user.id,
  });

  app.post(
    '/api/transfers',
    { preHandler: [shopOnly(), perm('transfers.create')] },
    async (req) => {
      const result = await db.$transaction(
        (tx) => createTransfer(tx, actor(req), req.body),
        TX_OPTIONS,
      );
      events.publish({ type: 'stock', subProductIds: result.subProductIds });
      return result;
    },
  );

  app.get('/api/transfers', { preHandler: perm('transfers.view') }, async () => ({
    items: await db.transfer.findMany({
      include: {
        fromLocation: { select: { name: true } },
        toLocation: { select: { name: true } },
        createdBy: { select: { fullName: true } },
        lines: { include: { subProduct: { select: { code: true, name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  }));

  app.post(
    '/api/adjustments',
    { preHandler: [shopOnly(), perm('adjustments.create')] },
    async (req) => {
      const input = adjustmentSchema.parse(req.body);
      const result = await db.$transaction(async (tx) => {
        const writeOff = input.lines.some((l) => D(l.qty).isNegative());
        const approverId = writeOff
          ? (await requireApproval(tx, req.ctx, 'WRITE_OFF', input.approval, config.pinSecret))
              .approverId
          : null;
        return createAdjustment(
          tx,
          actor(req),
          { ...input, locationId: input.locationId ?? req.ctx.locationId },
          approverId,
        );
      }, TX_OPTIONS);
      events.publish({ type: 'stock', subProductIds: result.subProductIds });
      return result;
    },
  );

  app.get('/api/adjustments', { preHandler: perm('adjustments.view') }, async () => ({
    items: await db.adjustment.findMany({
      include: {
        location: { select: { name: true } },
        createdBy: { select: { fullName: true } },
        approvedBy: { select: { fullName: true } },
        lines: {
          include: {
            subProduct: { select: { code: true, name: true } },
            reason: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  }));

  /** Stock per location for one sub-product, used by billing's "Move 1 from Store?". */
  app.get(
    '/api/sub-products/:id/stock',
    { preHandler: perm('stock.view', 'billing.view') },
    async (req) => {
      const id = idSchema.parse((req.params as { id: string }).id);
      const rows = await db.stockBalance.findMany({
        where: { subProductId: id, qty: { gt: 0 } },
        include: { location: true },
      });
      return {
        items: rows.map((r) => ({
          locationId: r.locationId,
          location: r.location.name,
          kind: r.location.kind,
          qty: r.qty.toFixed(3),
        })),
      };
    },
  );
}
