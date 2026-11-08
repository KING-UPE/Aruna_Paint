import { readFileSync } from 'node:fs';
import { DomainError } from '@aruna/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { perm, shopOnly, superAdminOnly } from '../../auth/guard';
import { scopeShop } from '../../core/dbscope';
import { audit } from '../../core/audit';
import { actorOf } from '../../core/context';

/**
 * The installed build has its version written in by the installer build (`installer/build.mjs`
 * defines ARUNA_BUILD_VERSION); `pnpm dev` and `pnpm start` read it from package.json, and
 * anything else run from the source reads the root package.json.
 */
export const APP_VERSION =
  process.env.ARUNA_BUILD_VERSION ?? process.env.npm_package_version ?? sourceVersion();

/** Run from the source (tests, `npx tsx`): the root package.json, the same one the screens use. */
function sourceVersion(): string {
  try {
    const file = new URL('../../../../../package.json', import.meta.url);
    return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

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
  // Online: the shop being looked at, and when its data was last brought up to date.
  const shop = scopeShop();
  const node = shop
    ? await app.deps.shops!.control.syncNode.findUnique({ where: { id: shop } })
    : null;
  const seen = node?.lastSeenAt?.getTime() ?? 0;
  return {
    linked: Boolean(node),
    online: seen > Date.now() - 60_000,
    pending: node?.waiting ?? 0,
    lastSyncedAt: node?.lastPushAt ?? node?.lastSeenAt ?? null,
    lastError: '',
    shopName: node?.name ?? '',
  };
}

/** Who runs software updates: the Super Admin and Admins (whoever looks after the shop's day). */
const managesUpdates = (req: FastifyRequest) =>
  req.ctx.roleCodes.includes('SUPER_ADMIN') || req.ctx.roleCodes.includes('ADMIN');

function updateManager() {
  return async (req: FastifyRequest) => {
    if (!managesUpdates(req))
      throw new DomainError('FORBIDDEN', 'Only the Super Admin or an Admin installs updates.');
  };
}

export async function systemRoutes(app: FastifyInstance) {
  const { db, events } = app.deps;

  /** The status bar: "Online · synced 10 s ago" or "Offline · 128 changes waiting", and the version. */
  app.get('/api/system/status', async (req) => {
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
      // A downloaded update, for the "update ready" pop-up (those who install updates only).
      update: await updateReady(req),
    };
  });

  async function updateReady(req: FastifyRequest) {
    if (!req.ctx?.user || !managesUpdates(req)) return null;
    const u = app.deps.updates.get();
    if (!u.canInstall || !u.available || !u.downloaded || !u.latest) return null;
    return {
      version: u.latest.version,
      notes: u.latest.notes,
      choice: u.choice,
      installing: u.state === 'installing',
      installAt: (await app.deps.settings.get('updates')).installAt,
    };
  }

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

  /** Software updates: this version, the newest release and how the last update went. */
  app.get('/api/updates', { preHandler: updateManager() }, async () => app.deps.updates.get());

  app.post('/api/updates/check', { preHandler: [shopOnly(), updateManager()] }, async () =>
    app.deps.updates.checkAndDownload(),
  );

  /** The pop-up's "Tonight" or "Next time the shop opens". */
  app.post('/api/updates/choice', { preHandler: [shopOnly(), updateManager()] }, async (req) => {
    const { when } = z.object({ when: z.enum(['night', 'startup']) }).parse(req.body);
    try {
      const status = await app.deps.updates.choose(when);
      await audit(db, actorOf(req.ctx), {
        action: 'update.scheduled',
        entity: 'software',
        after: { version: status.latest?.version, when },
      });
      return status;
    } catch (err) {
      throw new DomainError('INVALID_STATE', err instanceof Error ? err.message : String(err));
    }
  });

  /** Installs the downloaded version now. The server restarts within a minute or two. */
  app.post('/api/updates/install', { preHandler: [shopOnly(), updateManager()] }, async (req) => {
    const before = app.deps.updates.get();
    try {
      const status = await app.deps.updates.install();
      await audit(db, actorOf(req.ctx), {
        action: 'update.start',
        entity: 'software',
        before: { version: before.current },
        after: { version: status.latest?.version },
      });
      return status;
    } catch (err) {
      throw new DomainError('INVALID_STATE', err instanceof Error ? err.message : String(err));
    }
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
