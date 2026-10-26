import { idSchema, passwordSchema, pinSchema } from '@aruna/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { perm, shopOnly } from '../../auth/guard';
import { audit } from '../../core/audit';
import { actorOf } from '../../core/context';
import { TX_OPTIONS } from '../../db';
import {
  createRole,
  createUser,
  deleteRole,
  deleteUser,
  listRoles,
  listUsers,
  resetPassword,
  resetPin,
  updateRole,
  updateUser,
} from './service';

/** Users and roles are for the Super Admin only. */
export async function userRoutes(app: FastifyInstance) {
  const { db, config } = app.deps;
  const idParam = (p: unknown) => idSchema.parse((p as { id: string }).id);

  app.get('/api/users', { preHandler: perm('users.view') }, async () => ({
    items: await listUsers(db),
  }));

  app.post('/api/users', { preHandler: [shopOnly(), perm('users.create')] }, async (req) =>
    db.$transaction(
      (tx) => createUser(tx, actorOf(req.ctx), req.body, config.pinSecret),
      TX_OPTIONS,
    ),
  );

  app.patch('/api/users/:id', { preHandler: [shopOnly(), perm('users.edit')] }, async (req) =>
    db.$transaction(
      (tx) => updateUser(tx, actorOf(req.ctx), idParam(req.params), req.body),
      TX_OPTIONS,
    ),
  );

  app.delete('/api/users/:id', { preHandler: [shopOnly(), perm('users.edit')] }, async (req) => {
    await db.$transaction(
      (tx) => deleteUser(tx, actorOf(req.ctx), idParam(req.params)),
      TX_OPTIONS,
    );
    return { ok: true };
  });

  app.post(
    '/api/users/:id/reset-password',
    { preHandler: [shopOnly(), perm('users.edit')] },
    async (req) => {
      const { password } = z.object({ password: passwordSchema }).parse(req.body);
      await db.$transaction(
        (tx) => resetPassword(tx, actorOf(req.ctx), idParam(req.params), password),
        TX_OPTIONS,
      );
      return { ok: true };
    },
  );

  app.post(
    '/api/users/:id/reset-pin',
    { preHandler: [shopOnly(), perm('users.edit')] },
    async (req) => {
      const { pin } = z.object({ pin: pinSchema.nullable() }).parse(req.body);
      await db.$transaction(
        (tx) => resetPin(tx, actorOf(req.ctx), idParam(req.params), pin, config.pinSecret),
        TX_OPTIONS,
      );
      return { ok: true };
    },
  );

  /** Login history and active sessions; the Super Admin can force a logout. */
  app.get('/api/users/:id/sessions', { preHandler: perm('users.view') }, async (req) => {
    const userId = idParam(req.params);
    const sessions = await db.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { counter: true },
      orderBy: { lastActivityAt: 'desc' },
    });
    const logins = await db.auditLog.findMany({
      where: { userId, action: { startsWith: 'login' } },
      orderBy: { at: 'desc' },
      take: 50,
    });
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        counter: s.counter?.code ?? null,
        ip: s.ip,
        createdAt: s.createdAt,
        lastActivityAt: s.lastActivityAt,
        locked: s.lockedAt !== null,
      })),
      logins: logins.map((l) => ({ at: l.at, action: l.action, ip: l.ip, note: l.note })),
    };
  });

  app.post('/api/sessions/:id/revoke', { preHandler: [perm('users.edit')] }, async (req) => {
    const id = idParam(req.params);
    await db.$transaction(async (tx) => {
      const s = await tx.session.update({ where: { id }, data: { revokedAt: new Date() } });
      await audit(tx, actorOf(req.ctx), {
        action: 'session.revoke',
        entity: 'user',
        entityId: s.userId,
      });
    }, TX_OPTIONS);
    return { ok: true };
  });

  app.get('/api/roles', { preHandler: perm('users.view') }, async () => ({
    items: await listRoles(db),
  }));

  app.post('/api/roles', { preHandler: [shopOnly(), perm('users.create')] }, async (req) =>
    db.$transaction((tx) => createRole(tx, actorOf(req.ctx), req.body), TX_OPTIONS),
  );

  app.patch('/api/roles/:id', { preHandler: [shopOnly(), perm('users.edit')] }, async (req) => {
    await db.$transaction(
      (tx) => updateRole(tx, actorOf(req.ctx), idParam(req.params), req.body),
      TX_OPTIONS,
    );
    return { ok: true };
  });

  app.delete('/api/roles/:id', { preHandler: [shopOnly(), perm('users.edit')] }, async (req) => {
    await db.$transaction(
      (tx) => deleteRole(tx, actorOf(req.ctx), idParam(req.params)),
      TX_OPTIONS,
    );
    return { ok: true };
  });
}
