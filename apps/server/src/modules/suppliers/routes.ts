import { dateSchema, idSchema } from '@aruna/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { perm, shopOnly } from '../../auth/guard';
import { actorOf } from '../../core/context';
import { TX_OPTIONS } from '../../db';
import { dateOnly } from '../../lib/json';
import {
  createSupplier,
  createSupplierPayment,
  deleteSupplier,
  getSupplier,
  listSuppliers,
  setChequeStatus,
  supplierLedger,
  updateSupplier,
} from './service';

export async function supplierRoutes(app: FastifyInstance) {
  const { db } = app.deps;
  const idParam = (p: unknown) => idSchema.parse((p as { id: string }).id);

  /** Auto-suggest searches by code, name or phone and shows the balance. */
  app.get(
    '/api/suppliers',
    { preHandler: perm('suppliers.view', 'purchases.view') },
    async (req) => {
      const q = z
        .object({
          q: z.string().optional(),
          includeInactive: z.coerce.boolean().default(false),
          limit: z.coerce.number().int().max(500).optional(),
        })
        .parse(req.query);
      return { items: await listSuppliers(db, q) };
    },
  );

  app.get(
    '/api/suppliers/:id',
    { preHandler: perm('suppliers.view', 'purchases.view') },
    async (req) => getSupplier(db, idParam(req.params)),
  );

  app.post('/api/suppliers', { preHandler: [shopOnly(), perm('suppliers.create')] }, async (req) =>
    db.$transaction((tx) => createSupplier(tx, actorOf(req.ctx), req.body), TX_OPTIONS),
  );

  app.put('/api/suppliers/:id', { preHandler: [shopOnly(), perm('suppliers.edit')] }, async (req) =>
    db.$transaction(
      (tx) => updateSupplier(tx, actorOf(req.ctx), idParam(req.params), req.body),
      TX_OPTIONS,
    ),
  );

  app.delete('/api/suppliers/:id', { preHandler: [shopOnly(), perm('suppliers.edit')] }, async (req) =>
    db.$transaction(
      (tx) => deleteSupplier(tx, actorOf(req.ctx), idParam(req.params)),
      TX_OPTIONS,
    ),
  );

  app.get('/api/suppliers/:id/ledger', { preHandler: perm('suppliers.view') }, async (req) => {
    const q = z
      .object({
        from: dateSchema.optional(),
        to: dateSchema.optional(),
        types: z
          .string()
          .optional()
          .transform((v) =>
            v
              ? (v.split(',') as ('PURCHASE' | 'PAYMENT' | 'RETURN' | 'ADJUSTMENT' | 'REVERSAL')[])
              : undefined,
          ),
      })
      .parse(req.query);
    return supplierLedger(db, idParam(req.params), q);
  });

  app.post(
    '/api/supplier-payments',
    { preHandler: [shopOnly(), perm('supplier_payments.create')] },
    async (req) =>
      db.$transaction(
        (tx) =>
          createSupplierPayment(
            tx,
            { ...actorOf(req.ctx), userId: req.ctx.user.id },
            req.ctx.locationId,
            req.body,
          ),
        TX_OPTIONS,
      ),
  );

  app.get('/api/supplier-payments', { preHandler: perm('supplier_payments.view') }, async (req) => {
    const q = z.object({ supplierId: idSchema.optional() }).parse(req.query);
    const items = await db.supplierPayment.findMany({
      where: q.supplierId ? { supplierId: q.supplierId } : {},
      include: {
        supplier: { select: { code: true, name: true } },
        cheque: true,
        createdBy: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return { items: items.map((p) => ({ ...p, date: dateOnly(p.date) })) };
  });

  /** The cheque register; post-dated cheques show before their date. */
  app.get('/api/cheques', { preHandler: perm('supplier_payments.view') }, async (req) => {
    const q = z
      .object({ status: z.enum(['PENDING', 'CLEARED', 'BOUNCED', 'CANCELLED']).optional() })
      .parse(req.query);
    const items = await db.cheque.findMany({
      where: q.status ? { status: q.status } : {},
      include: { payment: { include: { supplier: { select: { code: true, name: true } } } } },
      orderBy: { chequeDate: 'asc' },
    });
    return { items: items.map((c) => ({ ...c, chequeDate: dateOnly(c.chequeDate) })) };
  });

  app.post(
    '/api/cheques/:id/status',
    { preHandler: [shopOnly(), perm('supplier_payments.create')] },
    async (req) => {
      const { status } = z
        .object({ status: z.enum(['CLEARED', 'BOUNCED', 'CANCELLED']) })
        .parse(req.body);
      await db.$transaction(
        (tx) => setChequeStatus(tx, actorOf(req.ctx), idParam(req.params), status),
        TX_OPTIONS,
      );
      return { ok: true };
    },
  );
}
