import { DomainError, idSchema } from '@aruna/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { perm, superAdminOnly } from '../../auth/guard';
import { TableCatalog, type RowChange } from '../../core/syncapply';
import { applyPush, checkNodeKey, undoOnCloud, type PushBody } from './cloud';

const RECENT = 50;

/**
 * Two-way sync. At the cloud: the shop server sends its changes and picks up the changes made
 * online. At both ends: the Sync page (machines, last sync, online changes and their conflicts).
 */
export async function syncRoutes(app: FastifyInstance) {
  const { db, config } = app.deps;
  const catalog = new TableCatalog();
  const cloud = config.mode === 'cloud';
  const idParam = (p: unknown) => idSchema.parse((p as { id: string }).id);

  if (cloud) {
    // Shop server → cloud: its changes, applied once each, plus how it is doing.
    app.post(
      '/api/sync/push',
      { config: { public: true }, bodyLimit: 50 * 1024 * 1024 },
      async (req) => applyPush(db, catalog, checkNodeKey(app, req), req.body as PushBody),
    );

    // Online changes the shop hasn't finished with.
    app.get('/api/sync/commands', { config: { public: true } }, async (req) => {
      checkNodeKey(app, req);
      const items = await db.syncCommand.findMany({
        where: { status: { in: ['PENDING', 'CONFLICT'] } },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
      return { items };
    });

    // What the shop did with one.
    app.post('/api/sync/commands/:id/result', { config: { public: true } }, async (req) => {
      checkNodeKey(app, req);
      const body = z
        .object({
          status: z.enum(['APPLIED', 'CONFLICT', 'FAILED', 'DISCARDED']),
          message: z.string().default(''),
          conflicts: z.unknown().optional(),
          decision: z.enum(['APPLY', 'DISCARD']).nullable().optional(),
          decidedByName: z.string().default(''),
          undo: z.array(z.unknown()).default([]),
        })
        .parse(req.body);
      // The shop didn't take it: its real rows replace what the online change did here.
      if (body.undo.length) await undoOnCloud(db, catalog, body.undo as RowChange[]);
      await db.syncCommand.update({
        where: { id: idParam(req.params) },
        data: {
          status: body.status,
          message: body.message,
          conflicts: (body.conflicts ?? undefined) as object | undefined,
          processedAt: new Date(),
          ...(body.decision ? { decision: body.decision, decidedByName: body.decidedByName } : {}),
        },
      });
      return { ok: true };
    });
  }

  /** The Sync page. */
  app.get('/api/sync/status', { preHandler: perm('settings.view') }, async () => {
    const commands = await db.syncCommand.findMany({
      orderBy: { createdAt: 'desc' },
      take: RECENT,
    });
    if (cloud) {
      const nodes = await db.syncNode.findMany({ orderBy: { name: 'asc' } });
      return {
        mode: 'cloud' as const,
        nodes: nodes.map((n) => ({
          id: n.id,
          name: n.name,
          lastSeenAt: n.lastSeenAt,
          lastPushAt: n.lastPushAt,
          waiting: n.waiting,
          version: n.version,
          counters: (n.info as { counters?: unknown[] } | null)?.counters ?? [],
        })),
        commands,
      };
    }
    return { mode: 'shop' as const, agent: await app.deps.sync!.status(), commands };
  });

  /** The Super Admin's answer to a conflict: use the online change, or keep the shop version. */
  app.post('/api/sync/commands/:id/resolve', { preHandler: superAdminOnly() }, async (req) => {
    const { action } = z.object({ action: z.enum(['APPLY', 'DISCARD']) }).parse(req.body);
    const id = idParam(req.params);
    const c = await db.syncCommand.findUnique({ where: { id } });
    if (!c) throw new DomainError('NOT_FOUND', 'That online change was not found.');
    if (c.status !== 'CONFLICT')
      throw new DomainError('INVALID_STATE', 'Only a conflict needs an answer.');
    const by = { id: req.ctx.user.id, name: req.ctx.user.fullName };
    if (cloud) {
      // The shop follows the answer when it next syncs.
      return db.syncCommand.update({
        where: { id },
        data: {
          decision: action,
          decidedById: by.id,
          decidedByName: by.name,
          decidedAt: new Date(),
        },
      });
    }
    await app.deps.sync!.process(
      {
        ...c,
        createdAt: c.createdAt.toISOString(),
        changes: c.changes as never,
        decision: action,
      },
      action,
      by,
    );
    void app.deps.sync!.sync().catch(() => undefined);
    return db.syncCommand.findUniqueOrThrow({ where: { id } });
  });

  if (!cloud) {
    app.post('/api/sync/now', { preHandler: perm('settings.view') }, async () =>
      app.deps.sync!.sync(),
    );
  }
}
