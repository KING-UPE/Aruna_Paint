import { createHash, timingSafeEqual } from 'node:crypto';
import { DomainError } from '@aruna/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../../db';
import { uuidv7 } from '../../lib/ids';
import { mirrorChange, TableCatalog, type RowChange } from '../../core/syncapply';
import { ONLINE_CHANGES, SHOP_REQUESTS } from './online';

/** Writes the online panel does for itself (signing in, the lock) or for syncing; never sent on. */
const CLOUD_OWN = (route: string) =>
  route.startsWith('POST /api/auth/') ||
  route.startsWith('POST /api/sync/') ||
  route.startsWith('POST /api/cloud/') ||
  route.startsWith('PUT /api/auth/');

const routeKey = (req: FastifyRequest) => `${req.method} ${req.routeOptions.url ?? req.url}`;

declare module 'fastify' {
  interface FastifyRequest {
    /** Cloud: the sync_outbox id before an online change started. */
    syncMark?: bigint;
    syncPins?: Map<string, string | null>;
    syncRelease?: () => void;
  }
}

/** The shop's own link to the cloud is set at the shop only: a wrong one would cut it off. */
function shopOnlySetting(req: FastifyRequest) {
  const key = (req.params as { key?: string } | undefined)?.key;
  return req.routeOptions.url === '/api/settings/:key' && key === 'cloud';
}

/** Online changes run one at a time, so each one's captured rows are its own. */
function lock() {
  let tail = Promise.resolve();
  return () => {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const ready = tail.then(() => release);
    tail = tail.then(() => next);
    return ready;
  };
}

async function pins(db: Db) {
  const rows = await db.user.findMany({ select: { id: true, pinHmac: true } });
  return new Map(rows.map((r) => [r.id, r.pinHmac]));
}

/** Cloud mode: the gate on writes, and turning each online change into a command for the shop. */
export function registerCloudCapture(app: FastifyInstance) {
  const { db } = app.deps;
  const acquire = lock();

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.method === 'GET' || req.method === 'HEAD') return;
    const key = routeKey(req);
    // A recovery code resets the Super Admin's password at the shop, where it counts.
    if (key === 'POST /api/auth/recover')
      throw new DomainError('FORBIDDEN', 'Use a recovery code at the shop.');
    if (CLOUD_OWN(key) && key !== 'POST /api/auth/change-password') return;
    // Only the Super Admin changes anything online, and only what an Admin can't do.
    if (!req.ctx?.roleCodes.includes('SUPER_ADMIN'))
      throw new DomainError(
        'FORBIDDEN',
        'The online panel is view-only. Changes are made at the shop.',
      );
    if (SHOP_REQUESTS[key]) {
      // Nothing changes here: the shop does it at its next sync.
      const command = await db.syncCommand.create({
        data: {
          id: uuidv7(),
          createdById: req.ctx.user.id,
          createdByName: req.ctx.user.fullName,
          route: key,
          summary: SHOP_REQUESTS[key],
          changes: [],
        },
      });
      return reply.code(202).send({ requested: true, commandId: command.id });
    }
    if (!ONLINE_CHANGES.has(key) || shopOnlySetting(req))
      throw new DomainError('FORBIDDEN', 'This can only be done at the shop.');
    const release = await acquire();
    let released = false;
    req.syncRelease = () => {
      if (!released) release();
      released = true;
    };
    try {
      const [mark] = await db.$queryRaw<{ id: bigint | null }[]>`
        SELECT max(id) AS id FROM sync_outbox`;
      req.syncPins = await pins(db);
      req.syncMark = mark?.id ?? 0n;
    } catch (err) {
      req.syncRelease();
      throw err;
    }
  });

  // Before the answer goes out, so the change is waiting for the shop by the time anyone looks.
  app.addHook('onSend', async (req, _reply, payload) => {
    if (req.syncMark === undefined) return payload;
    const mark = req.syncMark;
    req.syncMark = undefined;
    try {
      const rows = await db.syncOutbox.findMany({
        where: { id: { gt: mark } },
        orderBy: { id: 'asc' },
      });
      if (!rows.length) return payload;
      const changes: RowChange[] = rows.map((r) => ({
        table: r.tableName,
        op: r.op as RowChange['op'],
        pk: r.pk as Record<string, unknown>,
        data: (r.data as Record<string, unknown> | null) ?? null,
        old: (r.old as Record<string, unknown> | null) ?? null,
      }));
      // A PIN never leaves the shop, except one set here on purpose: it goes down with the change.
      const after = await pins(db);
      for (const ch of changes) {
        if (ch.table !== 'users' || !ch.data) continue;
        const id = String(ch.pk.id);
        if (after.get(id) !== req.syncPins?.get(id)) ch.data.pin_hmac = after.get(id) ?? null;
      }
      const summary = changes
        .filter((c) => c.table === 'audit_logs' && c.data)
        .map((c) => String(c.data!.action))
        .join(', ');
      await db.syncCommand.create({
        data: {
          id: uuidv7(),
          createdById: req.ctx?.user.id ?? null,
          createdByName: req.ctx?.user.fullName ?? '',
          route: routeKey(req),
          summary,
          changes: changes as unknown as object,
        },
      });
      // The cloud's own capture is only for this; nothing else reads it.
      await db.syncOutbox.deleteMany({ where: { id: { lte: rows[rows.length - 1]!.id } } });
      return payload;
    } finally {
      req.syncRelease?.();
    }
  });
  // In case the answer never got that far.
  app.addHook('onResponse', async (req) => req.syncRelease?.());
}

/** Shop servers sign their sync calls with the cloud's SYNC_KEY. */
export function checkNodeKey(app: FastifyInstance, req: FastifyRequest) {
  const key = app.deps.config.syncKey;
  const auth = req.headers.authorization ?? '';
  const sent = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = createHash('sha256').update(sent).digest();
  const b = createHash('sha256').update(key).digest();
  if (!key || !sent || !timingSafeEqual(a, b))
    throw new DomainError('UNAUTHENTICATED', 'Wrong shop key. Check Settings → Cloud at the shop.');
  const nodeId = String(req.headers['x-sync-node'] ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(nodeId)) throw new DomainError('VALIDATION', 'Missing shop id.');
  return nodeId;
}

export interface PushBody {
  name: string;
  version: string;
  waiting: number;
  counters: { code: string; name: string; lastBillAt: string | null }[];
  changes: (RowChange & { id: string })[];
}

/** Rows the shop sent back after refusing an online change. */
export async function undoOnCloud(db: Db, catalog: TableCatalog, rows: RowChange[]) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL aruna.sync_apply = 'on'`);
    for (const ch of rows) {
      await tx.$executeRawUnsafe('SAVEPOINT one_row');
      await mirrorChange(tx, catalog, ch).then(
        () => tx.$executeRawUnsafe('RELEASE SAVEPOINT one_row'),
        () => tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT one_row'),
      );
    }
  });
}

/**
 * The shop's changes, applied once each, in order, without capturing them again, on that shop's
 * copy (`db`, scoped to the shop); `control` is the cloud's list of shops.
 */
export async function applyPush(
  db: Db,
  control: Db,
  catalog: TableCatalog,
  nodeId: string,
  body: PushBody,
) {
  const node = await control.syncNode.findUniqueOrThrow({ where: { id: nodeId } });
  const fresh = body.changes.filter((c) => BigInt(c.id) > node.lastChangeId);
  const last = body.changes.length
    ? body.changes.reduce((m, c) => (BigInt(c.id) > m ? BigInt(c.id) : m), node.lastChangeId)
    : node.lastChangeId;
  // One row that can't be applied must not hold up the rest: it is noted and skipped.
  const errors: string[] = [];
  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL aruna.sync_apply = 'on'`);
      for (const ch of fresh) {
        await tx.$executeRawUnsafe('SAVEPOINT one_change');
        try {
          await mirrorChange(tx, catalog, ch);
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT one_change');
        } catch (err) {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT one_change');
          if (errors.length < 5)
            errors.push(
              `${ch.table} #${ch.id}: ${err instanceof Error ? err.message.split('\n').pop() : String(err)}`,
            );
        }
      }
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
  // How the shop is doing, in the cloud's list of shops.
  await control.syncNode.update({
    where: { id: nodeId },
    data: {
      name: body.name,
      version: body.version,
      waiting: Math.max(0, body.waiting - body.changes.length),
      info: { counters: body.counters, ...(errors.length ? { errors } : {}) },
      lastSeenAt: new Date(),
      ...(body.changes.length ? { lastPushAt: new Date(), lastChangeId: last } : {}),
    },
  });
  return { lastChangeId: last.toString() };
}
