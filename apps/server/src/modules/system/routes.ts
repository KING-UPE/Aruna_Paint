import { DomainError } from '@aruna/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyPassword } from '../../auth/crypto';
import { perm, shopOnly, superAdminOnly } from '../../auth/guard';
import { audit } from '../../core/audit';
import { actorOf } from '../../core/context';

export const APP_VERSION = process.env.npm_package_version ?? '0.1.0';

export async function systemRoutes(app: FastifyInstance) {
  const { db, events, settings } = app.deps;

  /** The status bar: "Online · synced 10 s ago" or "Offline · 128 changes waiting", and the version. */
  app.get('/api/system/status', async () => {
    const [pending, lastBackup, cloud, alerts] = await Promise.all([
      db.syncOutbox.count({ where: { sentAt: null } }),
      db.backup.findFirst({ orderBy: { at: 'desc' } }),
      settings.get('cloud'),
      db.alert.count({ where: { resolvedAt: null } }),
    ]);
    return {
      version: APP_VERSION,
      mode: app.deps.config.mode,
      serverTime: new Date(),
      sync: { linked: Boolean(cloud.url), pending, lastSyncedAt: null as Date | null },
      lastBackup: lastBackup
        ? {
            at: lastBackup.at,
            kind: lastBackup.kind,
            status: lastBackup.status,
            sizeBytes: lastBackup.sizeBytes.toString(),
          }
        : null,
      openAlerts: alerts,
    };
  });

  app.get('/api/alerts', { preHandler: perm('dashboard.view') }, async () => ({
    items: await db.alert.findMany({
      where: { resolvedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  }));

  app.get('/api/backups', { preHandler: perm('backups.view') }, async () => {
    const rows = await db.backup.findMany({ orderBy: { at: 'desc' }, take: 100 });
    return { items: rows.map((b) => ({ ...b, sizeBytes: b.sizeBytes.toString() })) };
  });

  app.post('/api/backups', { preHandler: [shopOnly(), perm('backups.create')] }, async (req) => {
    const row = await app.deps.backups.run('MANUAL');
    if (!row)
      throw new DomainError(
        'INVALID_STATE',
        "Backups pause in test mode: the real data isn't changing. Turn test mode off first.",
      );
    await audit(db, actorOf(req.ctx), {
      action: 'backup.manual',
      entity: 'backup',
      entityId: row.id,
      after: { status: row.status },
    });
    return { ...row, sizeBytes: row.sizeBytes.toString() };
  });

  /** Test mode status for every screen's banner, the sign-in screen included. */
  app.get('/api/test-mode', { config: { public: true } }, async () => {
    const { byUserId: _by, ...status } = app.deps.testMode.get();
    return status;
  });

  /** Super Admin only, with the password again so nobody turns it on from an unlocked screen. */
  app.post('/api/test-mode/on', { preHandler: [shopOnly(), superAdminOnly()] }, async (req) => {
    const body = z
      .object({ password: z.string().min(1), hours: z.number().positive() })
      .parse(req.body);
    const user = await db.user.findUniqueOrThrow({ where: { id: req.ctx.user.id } });
    if (!(await verifyPassword(body.password, user.passwordHash)))
      throw new DomainError('UNAUTHENTICATED', 'Wrong password.', 'password');
    return app.deps.testMode.turnOn({ userId: user.id, name: user.fullName }, body.hours);
  });

  app.post('/api/test-mode/off', { preHandler: [shopOnly(), superAdminOnly()] }, async (req) =>
    app.deps.testMode.turnOff({ userId: req.ctx.user.id }),
  );

  /**
   * Live updates over a WebSocket: a sale or purchase anywhere tells every counter which stock
   * changed, so their lists refresh without reloading.
   */
  app.get('/api/live', { websocket: true }, (socket) => {
    const off = events.subscribe((event) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    });
    socket.on('close', off);
    socket.on('error', off);
  });
}
