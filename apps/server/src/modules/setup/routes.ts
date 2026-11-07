import { DomainError } from '@aruna/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createSession } from '../../auth/session';
import { audit } from '../../core/audit';
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
    const waitingForOwner = setUp && (await db.user.count()) === 0;
    return {
      needsSetup: !setUp,
      waitingForShop: false,
      // Linked to the online panel and set up without an account: the owner's comes with a sync.
      waitingForOwner,
      // While waiting, how the link is doing, so the login page can say why nobody can sign in
      // yet (never the shop key).
      link: waitingForOwner ? await linkStatus() : null,
      mode: config.mode,
      appearance: await settings.get('appearance'),
    };
  });

  async function linkStatus() {
    const s = await app.deps.sync?.status();
    if (!s) return null;
    let host = '';
    try {
      host = s.url ? new URL(s.url).host : '';
    } catch {
      host = s.url;
    }
    return { host, online: s.online, lastTryAt: s.lastTryAt, lastError: s.lastError };
  }

  /**
   * A shop linked with a wrong panel address or shop key can fix it while it still waits for the
   * owner's account (no user exists, so nobody could sign in to Settings). Same window, and same
   * trust, as the first-run wizard itself: it closes once the owner's account has arrived.
   */
  app.post('/api/setup/cloud', { config: { public: true } }, async (req) => {
    if (config.mode !== 'shop' || (await needsSetup(db)) || (await db.user.count()) > 0)
      throw new DomainError('FORBIDDEN', 'Sign in and change the link in Settings → Cloud mirror.');
    const input = z
      .object({
        url: z.string().trim().url({ message: 'Type the online panel address, like https://….' }),
        shopKey: z.string().trim().min(8, { message: 'Type the shop key.' }),
      })
      .parse(req.body);
    await db.setting.upsert({
      where: { key: 'cloud' },
      create: { key: 'cloud', value: input },
      update: { value: input },
    });
    await audit(
      db,
      { userId: null, ip: req.ip },
      {
        action: 'setup.cloud_link',
        entity: 'settings',
        entityId: 'cloud',
        after: { url: input.url },
      },
    );
    settings.invalidate();
    await app.deps.sync?.sync().catch(() => undefined);
    return { link: await linkStatus() };
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
