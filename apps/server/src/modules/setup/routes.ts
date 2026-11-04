import type { FastifyInstance } from 'fastify';
import { createSession } from '../../auth/session';
import { scopeShop } from '../../core/dbscope';
import { needsSetup, runSetup } from './service';
import { getOwner } from '../sync/owner';

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
        shops: shops.map((s) => ({ id: s.id, name: s.name, lastSeenAt: s.lastSeenAt })),
        currentShop: current,
        // The owner signs in once for every shop; set up once, with the shop key.
        ownerSetUp: Boolean(await getOwner(app.deps.shops.control)),
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
    await createSession(app, reply, req, result.adminId);
    return { recoveryCodes: result.recoveryCodes };
  });
}
