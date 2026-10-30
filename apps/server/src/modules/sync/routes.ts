import { DomainError, idSchema, shopDate } from '@aruna/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { perm, superAdminOnly } from '../../auth/guard';
import { SESSION_COOKIE, SHOP_COOKIE } from '../../auth/session';
import { scopeShop, useShopData, withShopData } from '../../core/dbscope';
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
    const shops = app.deps.shops!;
    /** A shop server calling: its own copy in the cloud, made the first time it connects. */
    const asShop = async (req: FastifyRequest, name = '') => {
      const nodeId = checkNodeKey(app, req);
      await shops.ensure(nodeId, name);
      useShopData(nodeId);
      return nodeId;
    };

    // Shop server → cloud: its changes, applied once each, plus how it is doing.
    app.post(
      '/api/sync/push',
      { config: { public: true }, bodyLimit: 50 * 1024 * 1024 },
      async (req) => {
        const body = req.body as PushBody;
        const nodeId = await asShop(req, body.name);
        return applyPush(db, shops.control, catalog, nodeId, body);
      },
    );

    // Online changes the shop hasn't finished with.
    app.get('/api/sync/commands', { config: { public: true } }, async (req) => {
      await asShop(req);
      const items = await db.syncCommand.findMany({
        where: { status: { in: ['PENDING', 'CONFLICT'] } },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
      return { items };
    });

    // What the shop did with one.
    app.post('/api/sync/commands/:id/result', { config: { public: true } }, async (req) => {
      await asShop(req);
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

    // The online panel's sign-in page: which shops there are, and which one this browser chose.
    app.get('/api/cloud/shops', { config: { public: true } }, async (req) => ({
      items: (await shops.list()).map((n) => ({
        id: n.id,
        name: n.name,
        signedIn: Boolean(req.cookies[`${SESSION_COOKIE}_${n.id}`]),
      })),
      current: scopeShop(),
    }));

    // Look at another shop; its own sign-in is kept, so going back needs none.
    app.post('/api/cloud/switch', { config: { public: true } }, async (req, reply) => {
      const { shopId } = z.object({ shopId: z.string() }).parse(req.body);
      if (!(await shops.open(shopId)))
        throw new DomainError('NOT_FOUND', 'That shop was not found.');
      reply.setCookie(SHOP_COOKIE, shopId, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: req.protocol === 'https',
        maxAge: 365 * 86_400,
      });
      return { signedIn: Boolean(req.cookies[`${SESSION_COOKIE}_${shopId}`]) };
    });
  }

  /** The Sync page; online, the list of shops with how each is doing. */
  app.get(
    '/api/sync/status',
    { preHandler: perm('settings.view', 'cloud.access') },
    async (req) => {
      const commands = await db.syncCommand.findMany({
        orderBy: { createdAt: 'desc' },
        take: RECENT,
      });
      if (cloud) {
        const current = scopeShop();
        // The Super Admin sees every shop; others see the shop they signed in to.
        const all = await app.deps.shops!.list();
        const list = req.ctx.roleCodes.includes('SUPER_ADMIN')
          ? all
          : all.filter((n) => n.id === current);
        const since = new Date(`${shopDate()}T00:00:00+05:30`);
        const nodes = await Promise.all(
          list.map(async (n) => {
            const today = await withShopData(n.id, () =>
              db.sale.aggregate({
                where: { kind: 'INVOICE', status: 'COMPLETED', completedAt: { gte: since } },
                _count: true,
                _sum: { netTotal: true },
              }),
            ).catch(() => null);
            return {
              id: n.id,
              name: n.name,
              current: n.id === current,
              lastSeenAt: n.lastSeenAt,
              lastPushAt: n.lastPushAt,
              waiting: n.waiting,
              version: n.version,
              counters: (n.info as { counters?: unknown[] } | null)?.counters ?? [],
              today: {
                bills: today?._count ?? 0,
                total: today?._sum.netTotal?.toFixed(2) ?? '0.00',
              },
            };
          }),
        );
        return { mode: 'cloud' as const, nodes, commands };
      }
      return { mode: 'shop' as const, agent: await app.deps.sync!.status(), commands };
    },
  );

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
