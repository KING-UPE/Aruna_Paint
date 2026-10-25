import { DomainError } from '@aruna/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RequestContext } from '../core/context';
import { newToken, sha256 } from './crypto';
import { loadUserPermissions } from './permissions';

export const SESSION_COOKIE = 'aruna_sid';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** No login needed (login itself, first-run setup, health). */
    public?: boolean;
    /** Allowed while the screen is locked (unlock with a PIN, logout). */
    allowLocked?: boolean;
    /** Allowed before a reset password has been changed. */
    allowPasswordChange?: boolean;
  }
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

/** Loads the session on every /api request; the server checks permissions, not just the screens. */
export function registerSessionHook(app: FastifyInstance): void {
  app.decorateRequest('ctx', null as unknown as RequestContext);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const config = req.routeOptions.config ?? {};
    if (config.public) return;

    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw new DomainError('UNAUTHENTICATED', 'Please log in.');
    const { db, settings } = app.deps;
    const session = await db.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: true, counter: true },
    });
    const now = new Date();
    if (!session || session.revokedAt || session.expiresAt < now || !session.user.active) {
      clearSessionCookie(reply);
      throw new DomainError('UNAUTHENTICATED', 'Please log in.');
    }

    // The screen locks after a set idle time; a PIN (or password) unlocks it.
    const { idleLockMinutes } = await settings.get('billing');
    let lockedAt = session.lockedAt;
    if (!lockedAt && now.getTime() - session.lastActivityAt.getTime() > idleLockMinutes * 60_000) {
      lockedAt = now;
      await db.session.update({ where: { id: session.id }, data: { lockedAt } });
    }
    if (lockedAt && !config.allowLocked) {
      throw new DomainError('LOCKED', 'The screen is locked. Type your PIN to continue.');
    }
    if (session.user.mustChangePassword && !config.allowPasswordChange) {
      throw new DomainError('PASSWORD_CHANGE_REQUIRED', 'Please change your password first.');
    }

    // Background polls (status bar) send X-Passive so they don't keep the screen awake.
    const passive = req.headers['x-passive'] === '1';
    if (!passive && !lockedAt && now.getTime() - session.lastActivityAt.getTime() > 15_000) {
      await db.session.update({ where: { id: session.id }, data: { lastActivityAt: now } });
    }

    const { roleCodes, permissions } = await loadUserPermissions(db, session.userId);
    let counter = session.counter;
    if (!counter) {
      counter = await db.counter.findFirst({
        where: { active: true },
        orderBy: { code: 'asc' },
      });
      if (counter) {
        await db.session
          .update({ where: { id: session.id }, data: { counterId: counter.id } })
          .catch(() => {});
      }
    }
    const shop = counter ? null : await defaultLocationId(app);
    req.ctx = {
      sessionId: session.id,
      user: {
        id: session.user.id,
        username: session.user.username,
        fullName: session.user.fullName,
        mustChangePassword: session.user.mustChangePassword,
      },
      roleCodes,
      permissions,
      counter: counter
        ? {
            id: counter.id,
            code: counter.code,
            name: counter.name,
            locationId: counter.locationId,
          }
        : null,
      locationId: counter?.locationId ?? shop!,
      ip: req.ip,
    };
  });
}

let cachedShopId: string | null = null;

/** The first active shop; PCs that aren't counters work there. */
export async function defaultLocationId(app: FastifyInstance): Promise<string> {
  if (cachedShopId) return cachedShopId;
  const shop = await app.deps.db.location.findFirst({
    where: { kind: 'SHOP', active: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  if (!shop) throw new DomainError('INVALID_STATE', 'No shop location is set up yet.');
  cachedShopId = shop.id;
  return shop.id;
}

export function resetLocationCache(): void {
  cachedShopId = null;
}

export async function createSession(
  app: FastifyInstance,
  reply: FastifyReply,
  req: FastifyRequest,
  userId: string,
  counterId: string | null,
): Promise<void> {
  if (!counterId) {
    const defaultCounter = await app.deps.db.counter.findFirst({
      where: { active: true },
      orderBy: { code: 'asc' },
    });
    counterId = defaultCounter?.id ?? null;
  }
  const token = newToken();
  const days = app.deps.config.sessionDays;
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  await app.deps.db.session.create({
    data: {
      tokenHash: sha256(token),
      userId,
      counterId,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
      expiresAt,
    },
  });
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: req.protocol === 'https',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function sessionToken(req: FastifyRequest): string | undefined {
  return req.cookies[SESSION_COOKIE];
}
