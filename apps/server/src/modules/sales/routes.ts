import { D, billHistoryQuerySchema, convertQuotationSchema, idSchema, shopDate } from '@aruna/shared';
import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canSeeItemCost, perm, shopOnly } from '../../auth/guard';
import { TX_OPTIONS } from '../../db';
import { nextNumber, peekNumber } from '../../core/numbering';
import { dateOnly, parseDateOnly } from '../../lib/json';
import { billingItems, describeItems } from './lookup';
import { printReturn, printSale } from './printing';
import { createReturn } from './returns';
import {
  completeSale,
  convertQuotation,
  discardHeld,
  holdSale,
  listHeld,
  recordReprint,
  voidSale,
} from './service';

function dayRange(from?: string, to?: string): Prisma.DateTimeNullableFilter | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: new Date(`${from}T00:00:00+05:30`) } : {}),
    ...(to ? { lte: new Date(`${to}T23:59:59.999+05:30`) } : {}),
  };
}

export async function salesRoutes(app: FastifyInstance) {
  const { db, events, settings, config } = app.deps;
  const idParam = (p: unknown) => idSchema.parse((p as { id: string }).id);

  app.get(
    '/api/billing/items',
    { preHandler: perm('billing.view', 'quotations.view') },
    async (req) => {
      const { q } = z.object({ q: z.string().default('') }).parse(req.query);
      return { items: await billingItems(db, q, req.ctx.locationId) };
    },
  );

  /** Items by product id, e.g. to load a recalled held bill back onto the screen. */
  app.get(
    '/api/billing/items/by-products',
    { preHandler: perm('billing.view', 'quotations.view') },
    async (req) => {
      const { ids } = z.object({ ids: z.string().default('') }).parse(req.query);
      const list = ids.split(',').filter((x) => idSchema.safeParse(x).success);
      return {
        items: list.length
          ? await describeItems(
              db,
              list.map((id) => ({ id, matchedSubProductId: null })),
              req.ctx.locationId,
            )
          : [],
      };
    },
  );

  /** Customer name suggestions for quotations: earlier names with their phone. */
  app.get(
    '/api/billing/customers',
    { preHandler: perm('billing.view', 'quotations.view') },
    async (req) => {
      const { q } = z.object({ q: z.string().default('') }).parse(req.query);
      if (q.trim().length < 2) return { items: [] };
      const rows = await db.$queryRaw<{ name: string; phone: string }[]>`
      SELECT customer_name AS name, (array_agg(customer_phone ORDER BY created_at DESC))[1] AS phone
        FROM sales WHERE customer_name ILIKE ${`%${q.trim()}%`}
       GROUP BY customer_name ORDER BY MAX(created_at) DESC LIMIT 10`;
      return { items: rows };
    },
  );

  /** The bottom bar: this counter's sales today, next numbers and the day's state. */
  app.get(
    '/api/billing/status',
    { preHandler: perm('billing.view', 'quotations.view') },
    async (req) => {
      const counter = req.ctx.counter;
      const today = shopDate();
      const todayRange = dayRange(today, today)!;
      let shift = counter
        ? await db.shift.findFirst({ where: { counterId: counter.id, status: 'OPEN' } })
        : null;
      if (counter && !shift) {
        const existingToday = await db.shift.findUnique({
          where: {
            counterId_businessDate: { counterId: counter.id, businessDate: parseDateOnly(today) },
          },
        });
        if (!existingToday) {
          const no = await nextNumber(db, 'DAY_END', { counterCode: counter.code });
          shift = await db.shift.create({
            data: {
              no,
              counterId: counter.id,
              locationId: counter.locationId,
              businessDate: parseDateOnly(today),
              openingFloat: D(0),
              openedById: req.ctx.user.id,
            },
          });
        }
      }
      const [agg, pending, nextInvoice, nextQuotation, cloud] = await Promise.all([
        counter
          ? db.sale.aggregate({
              where: {
                counterId: counter.id,
                kind: 'INVOICE',
                status: 'COMPLETED',
                completedAt: todayRange,
              },
              _sum: { netTotal: true },
              _count: true,
            })
          : null,
        db.syncOutbox.count({ where: { sentAt: null } }),
        peekNumber(db, 'INVOICE', { counterCode: counter?.code }),
        peekNumber(db, 'QUOTATION', { counterCode: counter?.code }),
        settings.get('cloud'),
      ]);
      return {
        counter,
        today: { total: (agg?._sum.netTotal ?? 0).toString(), bills: agg?._count ?? 0 },
        shift: shift
          ? {
              id: shift.id,
              no: shift.no,
              businessDate: dateOnly(shift.businessDate),
              needDayEnd: dateOnly(shift.businessDate) !== today,
            }
          : null,
        nextNumbers: { INVOICE: nextInvoice, QUOTATION: nextQuotation },
        sync: { linked: Boolean(cloud.url), pending, lastSyncedAt: null },
        serverTime: new Date(),
      };
    },
  );

  /** F10: pay and finish the bill (or issue the quotation), then print. */
  app.post(
    '/api/sales',
    { preHandler: [shopOnly(), perm('billing.create', 'quotations.create')] },
    async (req) => {
      const body = (req.body ?? {}) as { kind?: string; print?: boolean };
      const isQuotation = body.kind === 'QUOTATION';
      await perm(isQuotation ? 'quotations.create' : 'billing.create')(req);
      const all = await settings.getAll();
      const result = await db.$transaction(
        (tx) => completeSale(tx, req.ctx, all, config.pinSecret, req.body),
        TX_OPTIONS,
      );
      if (result.kind === 'INVOICE')
        events.publish({ type: 'stock', subProductIds: result.subProductIds });
      events.publish({ type: 'sale', counterId: req.ctx.counter!.id });
      const print = await printSale(app, result.id, {
        print: body.print !== false,
        counterId: req.ctx.counter!.id,
      });
      return { ...result, print };
    },
  );

  app.post(
    '/api/sales/hold',
    { preHandler: [shopOnly(), perm('billing.create', 'quotations.create')] },
    async (req) => {
      const all = await settings.getAll();
      return db.$transaction((tx) => holdSale(tx, req.ctx, all, req.body), TX_OPTIONS);
    },
  );

  app.get(
    '/api/sales/held',
    { preHandler: perm('billing.view', 'quotations.view') },
    async (req) => ({
      items: await listHeld(db, req.ctx.locationId),
    }),
  );

  app.delete(
    '/api/sales/held/:id',
    { preHandler: [shopOnly(), perm('billing.create', 'quotations.create')] },
    async (req) => {
      await db.$transaction((tx) => discardHeld(tx, req.ctx, idParam(req.params)), TX_OPTIONS);
      return { ok: true };
    },
  );

  /** Bill history: invoice or quotation no (any part, letters or digits), dates, customer, cashier or amount. */
  app.get('/api/sales', { preHandler: perm('bill_history.view') }, async (req) => {
    const q = billHistoryQuerySchema.parse(req.query);
    const where: Prisma.SaleWhereInput = {
      status: q.status ? q.status : { not: 'HELD' },
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.q ? { no: { contains: q.q.trim(), mode: 'insensitive' } } : {}),
      ...(q.customer ? { customerName: { contains: q.customer.trim(), mode: 'insensitive' } } : {}),
      ...(q.cashierId ? { cashierId: q.cashierId } : {}),
      ...(q.counterId ? { counterId: q.counterId } : {}),
      ...(q.amount ? { netTotal: q.amount } : {}),
      ...(dayRange(q.from, q.to) ? { completedAt: dayRange(q.from, q.to) } : {}),
    };
    const sumWhere: Prisma.SaleWhereInput = q.status
      ? where
      : { ...where, status: { notIn: ['HELD', 'VOID'] } };
    const [items, total, aggregate] = await Promise.all([
      db.sale.findMany({
        where,
        include: {
          cashier: { select: { fullName: true } },
          counter: { select: { code: true } },
          convertedTo: { select: { no: true } },
          convertedFrom: { select: { no: true } },
        },
        orderBy: { completedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      db.sale.count({ where }),
      db.sale.aggregate({
        where: sumWhere,
        _sum: { netTotal: true },
      }),
    ]);
    return {
      items: items.map((s) => ({
        id: s.id,
        no: s.no,
        kind: s.kind,
        status: s.status,
        completedAt: s.completedAt,
        cashier: s.cashier.fullName,
        counter: s.counter.code,
        wholesale: s.wholesale,
        customerName: s.customerName,
        itemCount: s.itemCount,
        netTotal: s.netTotal.toFixed(2),
        refundedTotal: s.refundedTotal.toFixed(2),
        validUntil: dateOnly(s.validUntil),
        convertedTo: s.convertedTo?.no ?? null,
        convertedFrom: s.convertedFrom?.no ?? null,
        printCount: s.printCount,
      })),
      total,
      totalAmount: D(aggregate._sum.netTotal?.toString() ?? '0').toFixed(2),
      page: q.page,
      pageSize: q.pageSize,
    };
  });

  app.get('/api/sales/:id', { preHandler: perm('bill_history.view') }, async (req) => {
    const canSeeCost = canSeeItemCost(req);
    const s = await db.sale.findUniqueOrThrow({
      where: { id: idParam(req.params) },
      include: {
        lines: {
          orderBy: { lineNo: 'asc' },
          include: { priceApprover: { select: { fullName: true } } },
        },
        cashier: { select: { fullName: true } },
        counter: { select: { code: true } },
        voidedBy: { select: { fullName: true } },
        voidApprover: { select: { fullName: true } },
        voidReason: { select: { name: true } },
        returns: {
          include: { lines: true, cashier: { select: { fullName: true } } },
          orderBy: { createdAt: 'asc' },
        },
        reprints: { include: { user: { select: { fullName: true } } }, orderBy: { at: 'asc' } },
        convertedTo: { select: { id: true, no: true } },
        convertedFrom: { select: { id: true, no: true } },
      },
    });
    return {
      id: s.id,
      no: s.no,
      kind: s.kind,
      status: s.status,
      wholesale: s.wholesale,
      customerName: s.customerName,
      customerPhone: s.customerPhone,
      validUntil: dateOnly(s.validUntil),
      completedAt: s.completedAt,
      cashier: s.cashier.fullName,
      counter: s.counter.code,
      itemCount: s.itemCount,
      totalQty: s.totalQty.toFixed(3),
      gross: s.gross.toFixed(2),
      discount: s.discount.toFixed(2),
      roundingAdjustment: s.roundingAdjustment.toFixed(2),
      netTotal: s.netTotal.toFixed(2),
      cashGiven: s.cashGiven?.toFixed(2) ?? null,
      change: s.change?.toFixed(2) ?? null,
      refundedTotal: s.refundedTotal.toFixed(2),
      void: s.voidedAt
        ? {
            at: s.voidedAt,
            by: s.voidedBy?.fullName,
            approver: s.voidApprover?.fullName,
            reason: s.voidReason?.name,
            note: s.voidNote,
          }
        : null,
      convertedTo: s.convertedTo,
      convertedFrom: s.convertedFrom,
      lines: s.lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        productId: l.productId,
        subProductId: l.subProductId,
        code: l.code,
        name: l.name,
        unitName: l.unitName,
        isLoose: l.isLoose,
        qty: l.qty.toFixed(3),
        unitPrice: l.unitPrice.toFixed(2),
        rPrice: l.rPrice.toFixed(2),
        discountPerUnit: l.discountPerUnit.toFixed(2),
        gross: l.gross.toFixed(2),
        discount: l.discount.toFixed(2),
        amount: l.amount.toFixed(2),
        returnedQty: l.returnedQty.toFixed(3),
        returnableQty: l.isLoose ? '0.000' : l.qty.minus(l.returnedQty).toFixed(3),
        refundedAmount: l.refundedAmount.toFixed(2),
        priceApprover: l.priceApprover?.fullName ?? null,
        ...(canSeeCost
          ? { unitCost: l.unitCost.toFixed(2), costPrice: l.costPrice.toFixed(2) }
          : {}),
      })),
      returns: s.returns.map((r) => ({
        id: r.id,
        no: r.no,
        at: r.createdAt,
        by: r.cashier.fullName,
        refundTotal: r.refundTotal.toFixed(2),
      })),
      reprints: s.reprints.map((r) => ({ copyNo: r.copyNo, at: r.at, by: r.user.fullName })),
    };
  });

  /** V: void with a reason and an Admin PIN; same day only. */
  app.post(
    '/api/sales/:id/void',
    { preHandler: [shopOnly(), perm('bill_history.view')] },
    async (req) => {
      const result = await db.$transaction(
        (tx) => voidSale(tx, req.ctx, config.pinSecret, idParam(req.params), req.body),
        TX_OPTIONS,
      );
      events.publish({ type: 'stock', subProductIds: result.subProductIds });
      return { ok: true };
    },
  );

  /** P: reprint, stamped "REPRINT #n · date and time · user". */
  app.post(
    '/api/sales/:id/reprint',
    { preHandler: [shopOnly(), perm('bill_history.view')] },
    async (req) => {
      const id = idParam(req.params);
      const reprint = await db.$transaction((tx) => recordReprint(tx, req.ctx, id), TX_OPTIONS);
      const print = await printSale(app, id, {
        print: true,
        counterId: req.ctx.counter?.id ?? null,
        reprint: { copyNo: reprint.copyNo, at: reprint.at, user: req.ctx.user.fullName },
      });
      return { copyNo: reprint.copyNo, print };
    },
  );

  /** C: convert a quotation to an invoice; stock and prices are checked again. */
  app.post(
    '/api/sales/:id/convert',
    { preHandler: [shopOnly(), perm('billing.create')] },
    async (req) => {
      const body = convertQuotationSchema.parse(req.body ?? {});
      const all = await settings.getAll();
      const result = await db.$transaction(
        (tx) => convertQuotation(tx, req.ctx, all, config.pinSecret, idParam(req.params), body),
        TX_OPTIONS,
      );
      events.publish({ type: 'stock', subProductIds: result.subProductIds });
      const print = await printSale(app, result.id, {
        print: body.print,
        counterId: req.ctx.counter!.id,
      });
      return { ...result, print };
    },
  );

  /** R: return lines of an invoice (or an old-system bill, Admin only). */
  app.post('/api/returns', { preHandler: [shopOnly(), perm('returns.create')] }, async (req) => {
    const result = await db.$transaction(
      (tx) => createReturn(tx, req.ctx, config.pinSecret, req.body),
      TX_OPTIONS,
    );
    events.publish({ type: 'stock', subProductIds: result.subProductIds });
    const shouldPrint = (req.body as { print?: boolean }).print !== false;
    const print = shouldPrint
      ? await printReturn(app, req.ctx.counter?.id ?? null, result.receipt)
      : { printed: false };
    return { id: result.id, no: result.no, refundTotal: result.refundTotal, print };
  });

  app.get('/api/returns', { preHandler: perm('returns.view') }, async (req) => {
    const q = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query);
    const range = dayRange(q.from, q.to);
    const rows = await db.saleReturn.findMany({
      where: range ? { createdAt: range as Prisma.DateTimeFilter } : {},
      include: {
        sale: { select: { no: true } },
        cashier: { select: { fullName: true } },
        approver: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        no: r.no,
        at: r.createdAt,
        sale: r.sale?.no ?? null,
        oldBillRef: r.oldBillRef,
        by: r.cashier.fullName,
        approver: r.approver?.fullName ?? null,
        refundTotal: r.refundTotal.toFixed(2),
      })),
    };
  });
}
