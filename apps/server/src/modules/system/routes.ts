import type { FastifyInstance } from 'fastify';
import { perm, shopOnly } from '../../auth/guard';
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
    await audit(db, actorOf(req.ctx), {
      action: 'backup.manual',
      entity: 'backup',
      entityId: row.id,
      after: { status: row.status },
    });
    return { ...row, sizeBytes: row.sizeBytes.toString() };
  });

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
