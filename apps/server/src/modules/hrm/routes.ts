import { DomainError, periodContaining } from '@aruna/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { perm, shopOnly } from '../../auth/guard';
import { actorOf } from '../../core/context';
import { TX_OPTIONS } from '../../db';
import {
  getHrmMonthlySummary,
  setMonthStartDay,
  updateHrmMonth,
  updateHrmMonthSchema,
} from './service';

const querySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

export async function hrmRoutes(app: FastifyInstance) {
  const { db, settings, events } = app.deps;

  /**
   * View monthly sales, fixed expense deductions, and commission distribution.
   * Accessible by both Super Admin and Admin (view-only for Admin).
   */
  app.get('/api/hrm/summary', { preHandler: perm('hrm.view') }, async (req) => {
    const q = querySchema.parse(req.query);
    // Without a month, show the period that contains today.
    const { monthStartDay } = await settings.get('closing');
    const current = periodContaining(new Date(), monthStartDay);
    const summary = await getHrmMonthlySummary(
      db,
      settings,
      q.year ?? current.year,
      q.month ?? current.month,
    );
    const canEdit = req.ctx.permissions.has('hrm.edit');

    return {
      ...summary,
      canEdit,
    };
  });

  app.put('/api/hrm/month-start', { preHandler: [shopOnly(), perm('hrm.edit')] }, async (req) => {
    const { day } = z.object({ day: z.number().int().min(1).max(28) }).parse(req.body);
    const saved = await db.$transaction(
      (tx) => setMonthStartDay(tx, settings, actorOf(req.ctx), day),
      TX_OPTIONS,
    );
    events.publish({ type: 'settings' });
    return { monthStartDay: saved };
  });

  /**
   * Save expenses, salaries, and commission table members.
   * Strictly allowed ONLY for Super Admin (Owner).
   */
  app.put('/api/hrm/month/:period', { preHandler: [shopOnly(), perm('hrm.edit')] }, async (req) => {
    const { period } = req.params as { period: string };
    if (!/^\d{4}-\d{2}$/.test(period)) {
      throw new DomainError('VALIDATION', 'Period must be in YYYY-MM format.');
    }

    const input = updateHrmMonthSchema.parse(req.body);
    const actor = actorOf(req.ctx);

    const updated = await db.$transaction(
      (tx) => updateHrmMonth(tx, settings, actor, period, input),
      TX_OPTIONS,
    );

    events.publish({ type: 'settings' });
    return { success: true, updated };
  });
}
