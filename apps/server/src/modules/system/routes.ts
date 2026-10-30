import { DomainError } from '@aruna/shared';
import type { FastifyInstance } from 'fastify';
import { perm, shopOnly, superAdminOnly } from '../../auth/guard';
import { audit } from '../../core/audit';
import { actorOf } from '../../core/context';

export const APP_VERSION = process.env.npm_package_version ?? '0.1.0';

/**
 * For the status bar. At the shop: "Online · synced 10 s ago" or "Offline · 128 changes waiting".
 * At the cloud: when the shop last synced.
 */
async function syncSummary(app: FastifyInstance) {
  if (app.deps.sync) {
    const s = await app.deps.sync.status();
    return {
      linked: s.linked,
      online: s.online,
      pending: s.waiting,
      lastSyncedAt: s.lastSyncAt,
      lastError: s.lastError,
    };
  }
  const nodes = await app.deps.testMode.production.syncNode.findMany();
  const seen = nodes.map((n) => n.lastSeenAt?.getTime() ?? 0);
  const last = seen.length ? Math.max(...seen) : 0;
  return {
    linked: nodes.length > 0,
    online: last > Date.now() - 60_000,
    pending: nodes.reduce((t, n) => t + n.waiting, 0),
    lastSyncedAt: last ? new Date(last) : null,
    lastError: '',
  };
}

export async function systemRoutes(app: FastifyInstance) {
  const { db, events } = app.deps;

  /** The status bar: "Online · synced 10 s ago" or "Offline · 128 changes waiting", and the version. */
  app.get('/api/system/status', async () => {
    const [lastBackup, alerts] = await Promise.all([
      db.backup.findFirst({ orderBy: { at: 'desc' } }),
      db.alert.count({ where: { resolvedAt: null } }),
    ]);
    return {
      version: APP_VERSION,
      mode: app.deps.config.mode,
      serverTime: new Date(),
      sync: await syncSummary(app),
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

  /** Who is in test mode and how fresh the test copy is (Super Admin). */
  app.get('/api/test-mode', { preHandler: superAdminOnly() }, async () =>
    app.deps.testMode.status(),
  );

  /** Start testing again from the real data as it is now. */
  app.post('/api/test-mode/refresh', { preHandler: [shopOnly(), superAdminOnly()] }, async (req) =>
    app.deps.testMode.refresh(actorOf(req.ctx)),
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
