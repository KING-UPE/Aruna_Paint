import { dateSchema, idSchema, shopDate } from '@aruna/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { perm, shopOnly } from '../../auth/guard';
import { parseDateOnly } from '../../lib/json';
import { renderDayEnd } from '../../printing/receipts';
import { currentShift, shiftSummary } from './service';

type Summary = Awaited<ReturnType<typeof shiftSummary>>;

/**
 * Those who approve day ends (Admins, the Super Admin) see every user's line; a cashier sees the
 * shop's totals and their own line.
 */
function forViewer(req: FastifyRequest, s: Summary): Summary {
  if (req.ctx.permissions.has('day_end.approve')) return s;
  return { ...s, byUser: s.byUser.filter((u) => u.userId === req.ctx.user.id) };
}

export async function shiftRoutes(app: FastifyInstance) {
  const { db, settings, printer } = app.deps;

  app.get(
    '/api/shifts/current',
    { preHandler: perm('day_end.view', 'billing.view') },
    async (req) => {
      const s = await currentShift(db);
      return { shift: s ? forViewer(req, s) : null };
    },
  );

  /** Print the report of today (still open) or of any earlier day, any number of times. */
  app.post(
    '/api/shifts/:id/print',
    { preHandler: [shopOnly(), perm('day_end.view')] },
    async (req) => {
      const id = idSchema.parse((req.params as { id: string }).id);
      const s = forViewer(req, await shiftSummary(db, id));
      const all = await settings.getAll();
      const report = renderDayEnd({ ...s, closedBy: s.closedBy ?? '' }, all);
      return { print: await printer.print(report, s.no) };
    },
  );

  /** The shop's days: one date, or the latest ones (any date) to print an old report. */
  app.get('/api/shifts', { preHandler: perm('day_end.view') }, async (req) => {
    const q = z
      .object({
        date: dateSchema.optional(),
        recent: z.enum(['1', 'true']).optional(),
      })
      .parse(req.query);
    const shifts = await db.shift.findMany({
      where: q.recent ? {} : { businessDate: parseDateOnly(q.date ?? shopDate()) },
      orderBy: q.recent ? { openedAt: 'desc' } : { openedAt: 'asc' },
      take: q.recent ? 30 : undefined,
    });
    return {
      items: await Promise.all(
        shifts.map(async (s) => forViewer(req, await shiftSummary(db, s.id))),
      ),
    };
  });
}
