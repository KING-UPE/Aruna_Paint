import { DASHBOARD_RANGES } from '@aruna/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canSeeCostTotals, perm } from '../../auth/guard';
import { dashboard } from './service';

export async function dashboardRoutes(app: FastifyInstance) {
  const { db, settings } = app.deps;

  /** The Admin dashboard's charts for one date range, compared with the period before. */
  app.get('/api/dashboard', { preHandler: perm('dashboard.view') }, async (req) => {
    const { range } = z.object({ range: z.enum(DASHBOARD_RANGES).default('30d') }).parse(req.query);
    const { monthStartDay } = await settings.get('closing');
    return dashboard(db, {
      range,
      monthStartDay,
      canSeeProfit: canSeeCostTotals(req),
      canSeeSuppliers: req.ctx.permissions.has('suppliers.view'),
    });
  });
}
