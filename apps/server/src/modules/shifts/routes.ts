import { dateSchema, idSchema, shopDate } from '@aruna/shared';
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

  /** Day end: count the drawer, record the difference, print the report, then back up and sync. */
  app.post(
    '/api/shifts/current/close',
    { preHandler: [shopOnly(), perm('day_end.create')] },
    async (req) => {
      const result = await db.$transaction((tx) => closeShift(tx, req.ctx, req.body), TX_OPTIONS);
      const s = result.summary;
      const all = await settings.getAll();
      const print = await printer.print(
        req.ctx.counter?.id ?? null,
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
      app.deps.events.publish({ type: 'sale', counterId: s.counter.id });
      // The day-end backup runs in the background; billing never waits for it.
      void app.deps.backups.run('DAY_END');
      return { ...result, print };
    },
  );

  /** Own counter for cashiers; every counter for people who can approve day ends. */
  app.get('/api/shifts', { preHandler: perm('day_end.view') }, async (req) => {
    const q = z
      .object({ date: dateSchema.optional(), counterId: idSchema.optional() })
      .parse(req.query);
    const all = req.ctx.permissions.has('day_end.approve');
    const counterId = all ? q.counterId : req.ctx.counter?.id;
    if (!all && !counterId) return { items: [] };
    const shifts = await db.shift.findMany({
      where: {
        businessDate: parseDateOnly(q.date ?? shopDate()),
        ...(counterId ? { counterId } : {}),
      },
      orderBy: { openedAt: 'asc' },
    });
    return { items: await Promise.all(shifts.map((s) => shiftSummary(db, s.id))) };
  });
}
