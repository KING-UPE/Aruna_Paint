import { DomainError, idSchema, passwordSchema, pinSchema } from '@aruna/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { perm, shopOnly } from '../../auth/guard';
import { actorOf } from '../../core/context';
import { TX_OPTIONS, type Tx } from '../../db';
import {
  createUser,
  createUserSchema,
  deleteUser,
  listUsers,
  resetPassword,
  resetPin,
  updateUser,
} from './service';

const isCashierOnly = (roles: { code: string }[]) =>
  roles.length === 1 && roles[0]!.code === 'CASHIER';

/** Only accounts whose one role is Cashier are managed here; every other one is the Super Admin's. */
async function cashier(tx: Tx, id: string) {
  const user = await tx.user.findUnique({
    where: { id },
    include: { roles: { include: { role: true } } },
  });
  if (!user) throw new DomainError('NOT_FOUND', 'Cashier not found.');
  if (!isCashierOnly(user.roles.map((r) => r.role)))
    throw new DomainError(
      'FORBIDDEN',
      'Only cashier accounts are managed here. The Super Admin manages the others.',
    );
  return user;
}

const newCashierSchema = createUserSchema.pick({
  username: true,
  fullName: true,
  password: true,
  pin: true,
});
const editCashierSchema = z.object({
  fullName: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
});

/**
 * Cashier management: Admins (and the Super Admin) add cashiers, change their names, reset their
 * passwords and PINs, switch them off and delete them (the shop's request). A cashier with bills
 * is switched off instead of deleted, so their old bills keep their name.
 */
export async function cashierRoutes(app: FastifyInstance) {
  const { db, config } = app.deps;
  const idParam = (p: unknown) => idSchema.parse((p as { id: string }).id);

  app.get('/api/cashiers', { preHandler: perm('cashiers.view') }, async () => ({
    items: (await listUsers(db)).filter((u) => isCashierOnly(u.roles)),
  }));

  app.post('/api/cashiers', { preHandler: [shopOnly(), perm('cashiers.create')] }, async (req) => {
    const input = newCashierSchema.parse(req.body);
    return db.$transaction(async (tx) => {
      const role = await tx.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
      return createUser(
        tx,
        actorOf(req.ctx),
        { ...input, roleIds: [role.id], mustChangePassword: true },
        config.pinSecret,
      );
    }, TX_OPTIONS);
  });

  app.patch(
    '/api/cashiers/:id',
    { preHandler: [shopOnly(), perm('cashiers.edit')] },
    async (req) => {
      const input = editCashierSchema.parse(req.body);
      const id = idParam(req.params);
      return db.$transaction(async (tx) => {
        await cashier(tx, id);
        return updateUser(tx, actorOf(req.ctx), id, input);
      }, TX_OPTIONS);
    },
  );

  app.post(
    '/api/cashiers/:id/reset-password',
    { preHandler: [shopOnly(), perm('cashiers.edit')] },
    async (req) => {
      const { password } = z.object({ password: passwordSchema }).parse(req.body);
      const id = idParam(req.params);
      await db.$transaction(async (tx) => {
        await cashier(tx, id);
        await resetPassword(tx, actorOf(req.ctx), id, password);
      }, TX_OPTIONS);
      return { ok: true };
    },
  );

  app.post(
    '/api/cashiers/:id/reset-pin',
    { preHandler: [shopOnly(), perm('cashiers.edit')] },
    async (req) => {
      const { pin } = z.object({ pin: pinSchema }).parse(req.body);
      const id = idParam(req.params);
      await db.$transaction(async (tx) => {
        await cashier(tx, id);
        await resetPin(tx, actorOf(req.ctx), id, pin, config.pinSecret);
      }, TX_OPTIONS);
      return { ok: true };
    },
  );

  app.delete(
    '/api/cashiers/:id',
    { preHandler: [shopOnly(), perm('cashiers.edit')] },
    async (req) => {
      const id = idParam(req.params);
      await db.$transaction((tx) => cashier(tx, id), TX_OPTIONS);
      try {
        await db.$transaction((tx) => deleteUser(tx, actorOf(req.ctx), id), TX_OPTIONS);
        return { deleted: true };
      } catch (err) {
        // Records with history are kept: the account is switched off instead.
        if (!(err instanceof DomainError) || err.code !== 'IN_USE') throw err;
        await db.$transaction(
          (tx) => updateUser(tx, actorOf(req.ctx), id, { active: false }),
          TX_OPTIONS,
        );
        return { deleted: false, switchedOff: true };
      }
    },
  );
}
