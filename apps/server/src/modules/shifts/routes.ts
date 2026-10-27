import { DomainError, closeShiftSchema, dateSchema, idSchema, shopDate } from '@aruna/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { perm, shopOnly } from '../../auth/guard';
import { TX_OPTIONS } from '../../db';
import { parseDateOnly } from '../../lib/json';
import { renderDayEnd } from '../../printing/receipts';
import { addCashMovement, closeShift, currentShift, openShift, shiftSummary } from './service';

export async function shiftRoutes(app: FastifyInstance) {
  const { db, settings, printer } = app.deps;

  app.get(
    '/api/shifts/current',
    { preHandler: perm('day_end.view', 'billing.view') },
    async (req) => ({
      shift: await currentShift(db, req.ctx),
    }),
  );

  app.post(
    '/api/shifts/open',
    { preHandler: [shopOnly(), perm('day_end.create', 'billing.create')] },
    async (req) => db.$transaction((tx) => openShift(tx, req.ctx, req.body), TX_OPTIONS),
  );

  app.post(
    '/api/shifts/current/cash',
    { preHandler: [shopOnly(), perm('day_end.create')] },
    async (req) => db.$transaction((tx) => addCashMovement(tx, req.ctx, req.body), TX_OPTIONS),
  );

  const printReport = async (
    counterId: string | null,
    s: Awaited<ReturnType<typeof shiftSummary>>,
  ) => {
    const all = await settings.getAll();
    return printer.print(
      counterId,
      renderDayEnd(
        {
          ...s,
          counter: s.counter.code,
          closedBy: s.closedBy ?? '',
          countedCash: s.countedCash ?? '0.00',
          difference: s.difference ?? '0.00',
        },
        all,
      ),
      s.no,
    );
  };

  /** Day end: record the day's totals, then back up and sync. The report prints only if asked. */
  app.post(
    '/api/shifts/current/close',
    { preHandler: [shopOnly(), perm('day_end.create')] },
    async (req) => {
      const { print: wantPrint } = closeShiftSchema.parse(req.body ?? {});
      const result = await db.$transaction((tx) => closeShift(tx, req.ctx, req.body), TX_OPTIONS);
      const s = result.summary;
      const print = wantPrint
        ? await printReport(req.ctx.counter?.id ?? null, s)
        : { printed: false, skipped: true };
      app.deps.events.publish({ type: 'sale', counterId: s.counter.id });
      // The day-end backup runs in the background; billing never waits for it.
      void app.deps.backups.run('DAY_END');
      return { ...result, print };
    },
  );

  /** Print (or print again) the report of any day end. */
  app.post(
    '/api/shifts/:id/print',
    { preHandler: [shopOnly(), perm('day_end.view')] },
    async (req) => {
      const id = idSchema.parse((req.params as { id: string }).id);
      const s = await shiftSummary(db, id);
      if (!req.ctx.permissions.has('day_end.approve') && s.counter.id !== req.ctx.counter?.id) {
        throw new DomainError('FORBIDDEN', 'You can print the day ends of your own counter.');
      }
      return { print: await printReport(req.ctx.counter?.id ?? null, s) };
    },
  );

  /** Own counter for cashiers; every counter for people who can approve day ends. */
  app.get('/api/shifts', { preHandler: perm('day_end.view') }, async (req) => {
    const q = z
      .object({
        date: dateSchema.optional(),
        counterId: idSchema.optional(),
        /** The latest day ends (any date), newest first, to print an old report. */
        recent: z.enum(['1', 'true']).optional(),
      })
      .parse(req.query);
    const all = req.ctx.permissions.has('day_end.approve');
    const counterId = all ? q.counterId : req.ctx.counter?.id;
    if (!all && !counterId) return { items: [] };
    const shifts = await db.shift.findMany({
      where: {
        ...(q.recent ? {} : { businessDate: parseDateOnly(q.date ?? shopDate()) }),
        ...(counterId ? { counterId } : {}),
      },
      orderBy: q.recent ? { openedAt: 'desc' } : { openedAt: 'asc' },
      take: q.recent ? 30 : undefined,
    });
    return { items: await Promise.all(shifts.map((s) => shiftSummary(db, s.id))) };
  });
}
