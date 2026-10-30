import type { FastifyInstance } from 'fastify';
import { createSession } from '../../auth/session';
import { scopeShop } from '../../core/dbscope';
import { needsSetup, runSetup } from './service';

export async function setupRoutes(app: FastifyInstance) {
  const { db, config, settings } = app.deps;

  /** Public: also the shop's colour theme, so the login screen already wears it. */
  app.get('/api/setup/status', { config: { public: true } }, async () => {
    if (app.deps.shops) {
      // The online panel is never set up by hand: each shop appears with its first sync.
      const shops = await app.deps.shops.list();
      const current = scopeShop();
      return {
        needsSetup: false,
        waitingForShop: shops.length === 0,
        mode: config.mode,
        shops: shops.map((s) => ({ id: s.id, name: s.name })),
        currentShop: current,
        // The chosen shop's colour theme.
        appearance: await settings.get('appearance'),
      };
    }
    return {
      needsSetup: await needsSetup(db),
      waitingForShop: false,
      mode: config.mode,
      appearance: await settings.get('appearance'),
    };
  });

  /** First-run wizard. Works only while no user exists. */
  app.post('/api/setup', { config: { public: true } }, async (req, reply) => {
    const result = await runSetup(db, config, req.body as never);
    const counter = await db.counter.findFirst({ orderBy: { createdAt: 'asc' } });
    await createSession(app, reply, req, result.adminId, counter?.id ?? null);
    return { recoveryCodes: result.recoveryCodes, counterCode: counter?.code ?? null };
  });
}
