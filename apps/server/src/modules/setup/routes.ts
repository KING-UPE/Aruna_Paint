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
        shops: shops.map((s) => ({ id: s.id, name: s.name, lastSeenAt: s.lastSeenAt })),
        currentShop: current,
        // The chosen shop's colour theme.
        appearance: await settings.get('appearance'),
      };
    }
    const setUp = !(await needsSetup(db));
    return {
      needsSetup: !setUp,
      waitingForShop: false,
      // Linked to the online panel and set up without an account: the owner's comes with a sync.
      waitingForOwner: setUp && (await db.user.count()) === 0,
      mode: config.mode,
      appearance: await settings.get('appearance'),
    };
  });

  /** First-run wizard. Works only while no user exists. */
  app.post('/api/setup', { config: { public: true } }, async (req, reply) => {
    const result = await runSetup(db, config, req.body as never);
    // The server ran before setup (the installer starts it) and has the empty settings in memory;
    // without this the sync agent keeps seeing no cloud link and the owner never arrives.
    settings.invalidate();
    // A shop linked here syncs at once, so the owner's account arrives within seconds.
    void app.deps.sync?.sync().catch(() => undefined);
    if (result.adminId) await createSession(app, reply, req, result.adminId);
    return { recoveryCodes: result.recoveryCodes, signedIn: Boolean(result.adminId) };
  });
}
