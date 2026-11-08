import { DomainError, idSchema, shopDate } from '@aruna/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { perm, superAdminOnly } from '../../auth/guard';
import { ownerSession, SESSION_COOKIE, SHOP_COOKIE } from '../../auth/session';
import { scopeShop, useShopData, withShopData } from '../../core/dbscope';
import { TableCatalog, type RowChange } from '../../core/syncapply';
import { applyPush, checkNodeKey, undoOnCloud, type PushBody } from './cloud';
import { ownerAfterPush, ownerFromCookie } from './owner';

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
        const result = await applyPush(db, shops.control, catalog, nodeId, body);
        // The owner's account: a password changed at this shop goes everywhere; a new shop gets it.
        await ownerAfterPush(shops, nodeId, body.changes).catch(() => undefined);
        return result;
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
      // The panel's PIN secret, for a new shop to take before any PIN exists there, so PINs
      // set online (the owner's included) work at the shop. Only a shop with the key gets it.
      return { items, pinSecret: config.pinSecret };
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
    app.get('/api/cloud/shops', { config: { public: true } }, async (req) => {
      // An owner (the Super Admin) is signed in to every shop at once.
      const owner = Boolean(await ownerFromCookie(req, shops.control, config.syncKey));
      return {
        items: (await shops.list()).map((n) => ({
          id: n.id,
          name: n.name,
          lastSeenAt: n.lastSeenAt,
          signedIn: owner || Boolean(req.cookies[`${SESSION_COOKIE}_${n.id}`]),
        })),
        current: scopeShop(),
      };
    });

    // The owner takes a shop off the panel (one linked by mistake, a test shop, a PC set up
    // again), the one being looked at included: its copy here goes, the shop keeps its own data.
    // Only the owner: other Super Admins belong to their own shops.
    const ownerOnly = (req: FastifyRequest) => {
      if (!req.ctx.user.owner)
        throw new DomainError('FORBIDDEN', 'Only the owner takes a shop off the panel.');
    };
    const forget = (reply: FastifyReply, ids: string[], current: string | null) => {
      for (const id of ids) reply.clearCookie(`${SESSION_COOKIE}_${id}`, { path: '/' });
      if (current && ids.includes(current)) reply.clearCookie(SHOP_COOKIE, { path: '/' });
    };
    app.delete('/api/cloud/shops/:id', { preHandler: superAdminOnly() }, async (req, reply) => {
      ownerOnly(req);
      const id = z.string().parse((req.params as { id: string }).id);
      const current = scopeShop();
      if (!(await shops.remove(id))) throw new DomainError('NOT_FOUND', 'That shop was not found.');
      req.log.info({ shop: id, by: req.ctx.user.username }, 'shop removed from the panel');
      forget(reply, [id], current);
      return { ok: true, removedCurrent: id === current };
    });

    // Every shop at once, for a fresh start. The words typed in the warning come with it.
    app.post(
      '/api/cloud/shops/remove-all',
      { preHandler: superAdminOnly() },
      async (req, reply) => {
        ownerOnly(req);
        const { confirm } = z.object({ confirm: z.string() }).parse(req.body);
        if (confirm.trim().toUpperCase() !== 'REMOVE ALL')
          throw new DomainError('VALIDATION', 'Type REMOVE ALL to confirm.', 'confirm');
        const current = scopeShop();
        const ids = (await shops.control.syncNode.findMany({ select: { id: true } })).map(
          (n) => n.id,
        );
        for (const id of ids) await shops.remove(id);
        req.log.info({ shops: ids, by: req.ctx.user.username }, 'all shops removed from the panel');
        forget(reply, ids, current);
        return { removed: ids.length };
      },
    );

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
      if (req.cookies[`${SESSION_COOKIE}_${shopId}`]) return { signedIn: true };
      // The owner needs no sign-in at any shop: one starts for them there.
      useShopData(shopId);
      return { signedIn: Boolean(await ownerSession(app, req, reply)) };
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
        // The owner sees every shop; others see the shop they signed in to.
        const all = await app.deps.shops!.list();
        const list = req.ctx.user.owner ? all : all.filter((n) => n.id === current);
        const since = new Date(`${shopDate()}T00:00:00+05:30`);
        const nodes = await Promise.all(
          list.map(async (n) => {
            // On Vercel each copy of the server opens only the shops it was asked about: open
            // every one listed. A shop that can't be read shows no figures, never a blank page.
            const today = await app.deps
              .shops!.open(n.id)
              .then((ok) =>
                ok
                  ? withShopData(n.id, () =>
                      db.sale.aggregate({
                        where: {
                          kind: 'INVOICE',
                          status: 'COMPLETED',
                          completedAt: { gte: since },
                        },
                        _count: true,
                        _sum: { netTotal: true },
                      }),
                    )
                  : null,
              )
              .catch((err) => {
                req.log.warn({ err, shop: n.id }, 'shop figures unavailable');
                return null;
              });
            return {
              id: n.id,
              name: n.name,
              current: n.id === current,
              lastSeenAt: n.lastSeenAt,
              lastPushAt: n.lastPushAt,
              waiting: n.waiting,
              version: n.version,
              lastBillAt: (n.info as { lastBillAt?: string | null } | null)?.lastBillAt ?? null,
              today: {
                bills: today?._count ?? 0,
                total: today?._sum?.netTotal?.toFixed(2) ?? '0.00',
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
