import {
  APPROVALS,
  DomainError,
  SHORTCUT_SCREENS,
  codeKey,
  nameKey,
  normalizeCombo,
  passwordSchema,
  pinSchema,
  validateKeyAssignment,
  type ApprovalKind,
  type ShortcutScreen,
} from '@aruna/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../core/audit';
import { actorOf } from '../core/context';
import { TX_OPTIONS } from '../db';
import { requireApproval } from './approvals';
import { hashPassword, normalizeRecoveryCode, pinHmac, sha256, verifyPassword } from './crypto';
import { clearSessionCookie, createSession } from './session';

const loginSchema = z.object({
  username: z.string().min(1).max(60),
  password: z.string().min(1).max(200),
  counterCode: z.string().max(20).optional().nullable(),
});

export async function authRoutes(app: FastifyInstance) {
  const { db, config, settings } = app.deps;

  /** Username and password only. A counter PC also says which counter it is. */
  app.post('/api/auth/login', { config: { public: true } }, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const user = await db.user.findUnique({ where: { usernameKey: nameKey(body.username) } });
    const ok = user && user.active && (await verifyPassword(body.password, user.passwordHash));
    if (!ok) {
      await audit(
        db,
        { userId: user?.id ?? null, ip: req.ip },
        {
          action: 'login.failed',
          entity: 'user',
          entityId: user?.id ?? null,
          note: `username: ${body.username}`,
        },
      );
      throw new DomainError('UNAUTHENTICATED', 'Wrong username or password.');
    }
    let counterId: string | null = null;
    if (body.counterCode) {
      const counter = await db.counter.findUnique({ where: { code: codeKey(body.counterCode) } });
      if (counter && counter.active) {
        counterId = counter.id;
      }
    }
    if (!counterId) {
      const defaultCounter = await db.counter.findFirst({
        where: { active: true },
        orderBy: { code: 'asc' },
      });
      counterId = defaultCounter?.id ?? null;
    }
    await createSession(app, reply, req, user.id, counterId);
    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await audit(
      db,
      { userId: user.id, counterId, ip: req.ip },
      { action: 'login', entity: 'user', entityId: user.id },
    );
    return { ok: true, mustChangePassword: user.mustChangePassword };
  });

  app.post(
    '/api/auth/logout',
    { config: { allowLocked: true, allowPasswordChange: true } },
    async (req, reply) => {
      await db.session.update({
        where: { id: req.ctx.sessionId },
        data: { revokedAt: new Date() },
      });
      await audit(db, actorOf(req.ctx), {
        action: 'logout',
        entity: 'user',
        entityId: req.ctx.user.id,
      });
      clearSessionCookie(reply);
      return { ok: true };
    },
  );

  app.get(
    '/api/auth/me',
    { config: { allowLocked: true, allowPasswordChange: true } },
    async (req) => me(app, req),
  );

  /**
   * Cashiers switch user with their PIN; the same call unlocks a locked screen.
   * PINs are unique, so the PIN alone says who is now at the counter.
   */
  app.post('/api/auth/pin', { config: { allowLocked: true } }, async (req) => {
    const { pin } = z.object({ pin: pinSchema }).parse(req.body);
    const user = await db.user.findUnique({ where: { pinHmac: pinHmac(pin, config.pinSecret) } });
    if (!user || !user.active) {
      await audit(db, actorOf(req.ctx), {
        action: 'pin.failed',
        entity: 'session',
        entityId: req.ctx.sessionId,
      });
      throw new DomainError('UNAUTHENTICATED', 'That PIN is not right.', 'pin');
    }
    const switched = user.id !== req.ctx.user.id;
    await db.session.update({
      where: { id: req.ctx.sessionId },
      data: { userId: user.id, lockedAt: null, lastActivityAt: new Date() },
    });
    await audit(
      db,
      { userId: user.id, counterId: req.ctx.counter?.id, ip: req.ip },
      {
        action: switched ? 'login.pin_switch' : 'unlock.pin',
        entity: 'user',
        entityId: user.id,
        note: switched ? `from ${req.ctx.user.username}` : '',
      },
    );
    return { ok: true, switched };
  });

  /**
   * Checks an approver's PIN the moment it is typed (e.g. a changed mix paint price), so the
   * cashier sees right away whether it was accepted. The action itself checks it again.
   */
  app.post('/api/auth/verify-approval', async (req) => {
    const body = z
      .object({
        kind: z.enum(Object.keys(APPROVALS) as [ApprovalKind, ...ApprovalKind[]]),
        pin: pinSchema,
      })
      .parse(req.body);
    const result = await requireApproval(
      db,
      req.ctx,
      body.kind,
      { pin: body.pin },
      config.pinSecret,
    );
    const approver = await db.user.findUniqueOrThrow({
      where: { id: result.approverId },
      select: { fullName: true },
    });
    return { approver: approver.fullName, override: result.override };
  });

  /** Unlock with the password, for users without a PIN. */
  app.post('/api/auth/unlock', { config: { allowLocked: true } }, async (req) => {
    const { password } = z.object({ password: z.string().min(1) }).parse(req.body);
    const user = await db.user.findUniqueOrThrow({ where: { id: req.ctx.user.id } });
    if (!(await verifyPassword(password, user.passwordHash))) {
      throw new DomainError('UNAUTHENTICATED', 'Wrong password.', 'password');
    }
    await db.session.update({
      where: { id: req.ctx.sessionId },
      data: { lockedAt: null, lastActivityAt: new Date() },
    });
    await audit(db, actorOf(req.ctx), {
      action: 'unlock.password',
      entity: 'user',
      entityId: user.id,
    });
    return { ok: true };
  });

  app.post(
    '/api/auth/lock',
    { config: { allowLocked: true, allowPasswordChange: true } },
    async (req) => {
      await db.session.update({ where: { id: req.ctx.sessionId }, data: { lockedAt: new Date() } });
      return { ok: true };
    },
  );

  /** A reset password must be changed at next login. */
  app.post('/api/auth/change-password', { config: { allowPasswordChange: true } }, async (req) => {
    const body = z
      .object({ currentPassword: z.string().min(1), newPassword: passwordSchema })
      .parse(req.body);
    const user = await db.user.findUniqueOrThrow({ where: { id: req.ctx.user.id } });
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      throw new DomainError('VALIDATION', 'The current password is not right.', 'currentPassword');
    }
    if (body.currentPassword === body.newPassword) {
      throw new DomainError('VALIDATION', 'Choose a new password.', 'newPassword');
    }
    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(body.newPassword), mustChangePassword: false },
      });
      // Log out the user's other sessions.
      await tx.session.updateMany({
        where: { userId: user.id, id: { not: req.ctx.sessionId }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await audit(tx, actorOf(req.ctx), {
        action: 'password.change',
        entity: 'user',
        entityId: user.id,
      });
    }, TX_OPTIONS);
    return { ok: true };
  });

  /** A forgotten Super Admin password is reset with one of the printed recovery codes. */
  app.post('/api/auth/recover', { config: { public: true } }, async (req) => {
    const body = z
      .object({
        username: z.string().min(1),
        recoveryCode: z.string().min(8),
        newPassword: passwordSchema,
      })
      .parse(req.body);
    const user = await db.user.findUnique({
      where: { usernameKey: nameKey(body.username) },
      include: { roles: { include: { role: true } } },
    });
    const isSuperAdmin = user?.roles.some((r) => r.role.code === 'SUPER_ADMIN');
    const codeHash = sha256(normalizeRecoveryCode(body.recoveryCode));
    const code = await db.recoveryCode.findFirst({ where: { codeHash, usedAt: null } });
    if (!user || !isSuperAdmin || !code) {
      await audit(
        db,
        { userId: user?.id ?? null, ip: req.ip },
        { action: 'recover.failed', entity: 'user', entityId: user?.id ?? null },
      );
      throw new DomainError('UNAUTHENTICATED', 'That recovery code or username is not right.');
    }
    await db.$transaction(async (tx) => {
      await tx.recoveryCode.update({ where: { id: code.id }, data: { usedAt: new Date() } });
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await hashPassword(body.newPassword),
          mustChangePassword: false,
          active: true,
        },
      });
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await audit(
        tx,
        { userId: user.id, ip: req.ip },
        { action: 'recover', entity: 'user', entityId: user.id },
      );
    }, TX_OPTIONS);
    const left = await db.recoveryCode.count({ where: { usedAt: null } });
    return { ok: true, recoveryCodesLeft: left };
  });

  /** Each user can remap any shortcut and save their own key map. */
  app.put('/api/auth/shortcuts', async (req) => {
    const body = z
      .object({
        screen: z.enum(SHORTCUT_SCREENS),
        action: z.string().min(1),
        keys: z.string().min(1).max(40),
      })
      .parse(req.body);
    const overrides = await db.userShortcut.findMany({ where: { userId: req.ctx.user.id } });
    const problem = validateKeyAssignment(
      body.screen as ShortcutScreen,
      body.action,
      body.keys,
      overrides,
    );
    if (problem) throw new DomainError('VALIDATION', problem, 'keys');
    const keys = normalizeCombo(body.keys);
    await db.userShortcut.upsert({
      where: {
        userId_screen_action: { userId: req.ctx.user.id, screen: body.screen, action: body.action },
      },
      create: { userId: req.ctx.user.id, screen: body.screen, action: body.action, keys },
      update: { keys },
    });
    return { ok: true };
  });

  /** "Reset to default" brings the Super Admin's default keys back. */
  app.delete('/api/auth/shortcuts', async (req) => {
    await db.userShortcut.deleteMany({ where: { userId: req.ctx.user.id } });
    return { ok: true };
  });

  async function me(app: FastifyInstance, req: FastifyRequest) {
    const ctx = req.ctx;
    const [shortcuts, billing, shop, session, appearance] = await Promise.all([
      db.userShortcut.findMany({
        where: { userId: ctx.user.id },
        select: { screen: true, action: true, keys: true },
      }),
      settings.get('billing'),
      settings.get('shop'),
      db.session.findUniqueOrThrow({ where: { id: ctx.sessionId } }),
      settings.get('appearance'),
    ]);
    const location = await db.location.findUnique({ where: { id: ctx.locationId } });
    return {
      user: ctx.user,
      roles: ctx.roleCodes,
      permissions: ctx.permissions.toArray(),
      counter: ctx.counter,
      location: location ? { id: location.id, code: location.code, name: location.name } : null,
      locked: session.lockedAt !== null,
      shortcuts,
      settings: {
        shopName: shop.shopName,
        idleLockMinutes: billing.idleLockMinutes,
        timeFormat: billing.timeFormat,
        quotationValidityDays: billing.quotationValidityDays,
      },
      appearance,
      mode: app.deps.config.mode,
      testMode: ctx.testMode,
    };
  }
}
