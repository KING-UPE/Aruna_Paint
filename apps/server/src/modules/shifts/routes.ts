import { DomainError, dateSchema, idSchema, shopDate } from '@aruna/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { perm, shopOnly } from '../../auth/guard';
import { parseDateOnly } from '../../lib/json';
import { renderDayEnd } from '../../printing/receipts';
import { currentShift, shiftSummary } from './service';

export async function shiftRoutes(app: FastifyInstance) {
  const { db, settings, printer } = app.deps;

  app.get(
    '/api/shifts/current',
    { preHandler: perm('day_end.view', 'billing.view') },
    async (req) => ({
      shift: await currentShift(db, req.ctx),
    }),
  );

  const printReport = async (
    counterId: string | null,
    s: Awaited<ReturnType<typeof shiftSummary>>,
  ) => {
    const all = await settings.getAll();
    return printer.print(
      counterId,
      renderDayEnd({ ...s, counter: s.counter.code, closedBy: s.closedBy ?? '' }, all),
      s.no,
    );
  };

  /** Print the report of today (still open) or of any earlier day, any number of times. */
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
