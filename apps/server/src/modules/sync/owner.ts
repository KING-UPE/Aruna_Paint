import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError, nameKey, passwordSchema, pinSchema } from '@aruna/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db';
import { hashPassword, pinHmac } from '../../auth/crypto';
import { audit } from '../../core/audit';
import type { CloudShops } from '../../core/shops';
import { recordCloudChange } from './cloud';

/**
 * The owner: one account for every shop (the owner's request). It lives in the cloud's own
 * database, signs in once on the online panel and sees every shop, new ones included, and is
 * copied to each shop as a Super Admin, so the same username, password and PIN work at every
 * shop's PCs. A password changed online or at any shop reaches every shop.
 */
export interface Owner {
  username: string;
  usernameKey: string;
  fullName: string;
  passwordHash: string;
  pinHmac: string | null;
  /** Goes up with every password change, so sign-ins with the old one end. */
  version: number;
  updatedAt: string;
}

const STATE = 'owner';
export const OWNER_COOKIE = 'aruna_owner';
const COOKIE_DAYS = 30;

export async function getOwner(control: Db): Promise<Owner | null> {
  const row = await control.syncState.findUnique({ where: { key: STATE } });
  return (row?.value as unknown as Owner | undefined) ?? null;
}

async function saveOwner(control: Db, owner: Owner) {
  const value = owner as unknown as object;
  await control.syncState.upsert({
    where: { key: STATE },
    create: { key: STATE, value },
    update: { value },
  });
}

const same = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export const ownerSetupSchema = z.object({
  /** The cloud's shop key (SYNC_KEY): only whoever set up the cloud knows it. */
  shopKey: z.string().min(1),
  username: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[A-Za-z0-9._-]+$/, { message: 'Use letters, digits and . _ - only.' }),
  fullName: z.string().min(1).max(120),
  password: passwordSchema,
  pin: pinSchema.optional().nullable(),
});

/** Once: the owner account, proven with the shop key. Then it is copied to every shop. */
export async function setUpOwner(
  shops: CloudShops,
  config: { syncKey: string; pinSecret: string },
  raw: unknown,
): Promise<Owner> {
  const input = ownerSetupSchema.parse(raw);
  if (await getOwner(shops.control))
    throw new DomainError('INVALID_STATE', 'The owner account is already set up.');
  if (!config.syncKey || !same(input.shopKey, config.syncKey))
    throw new DomainError('UNAUTHENTICATED', 'Wrong shop key.', 'shopKey');
  const owner: Owner = {
    username: input.username,
    usernameKey: nameKey(input.username),
    fullName: input.fullName,
    passwordHash: await hashPassword(input.password),
    pinHmac: input.pin ? pinHmac(input.pin, config.pinSecret) : null,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  await saveOwner(shops.control, owner);
  await provisionAll(shops, owner);
  return owner;
}

/** A new password (and name) for the owner, to reach every shop but `from`, which has it. */
export async function updateOwner(
  shops: CloudShops,
  owner: Owner,
  change: { passwordHash?: string; fullName?: string },
  from?: string,
): Promise<Owner> {
  const next: Owner = {
    ...owner,
    ...change,
    version:
      change.passwordHash && change.passwordHash !== owner.passwordHash
        ? owner.version + 1
        : owner.version,
    updatedAt: new Date().toISOString(),
  };
  await saveOwner(shops.control, next);
  await provisionAll(shops, next, from);
  return next;
}

// ---- The owner's sign-in on the panel: a signed cookie, valid for every shop ----

function sign(syncKey: string, payload: string) {
  return createHmac('sha256', `aruna-owner:${syncKey}`).update(payload).digest('base64url');
}

export function setOwnerCookie(
  reply: FastifyReply,
  req: FastifyRequest,
  syncKey: string,
  owner: Owner,
) {
  const exp = Date.now() + COOKIE_DAYS * 86_400_000;
  const payload = Buffer.from(`${owner.usernameKey}|${owner.version}|${exp}`).toString('base64url');
  reply.setCookie(OWNER_COOKIE, `${payload}.${sign(syncKey, payload)}`, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: req.protocol === 'https',
    maxAge: COOKIE_DAYS * 86_400,
  });
}

export function clearOwnerCookie(reply: FastifyReply) {
  reply.clearCookie(OWNER_COOKIE, { path: '/' });
}

/** The owner, when this browser signed in as the owner and that sign-in still holds. */
export async function ownerFromCookie(
  req: FastifyRequest,
  control: Db,
  syncKey: string,
): Promise<Owner | null> {
  const raw = req.cookies[OWNER_COOKIE];
  if (!raw || !syncKey) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig || !same(sig, sign(syncKey, payload))) return null;
  const [key, version, exp] = Buffer.from(payload, 'base64url').toString().split('|');
  if (!exp || Number(exp) < Date.now()) return null;
  const owner = await getOwner(control);
  if (!owner || owner.usernameKey !== key || String(owner.version) !== version) return null;
  return owner;
}

// ---- The owner's account at each shop ----

/**
 * Makes the owner's account at one shop match: a Super Admin with the owner's username, name,
 * password and PIN. The change goes to the shop like an online change. Returns why it couldn't,
 * or null when the account is right.
 */
export async function provisionOwner(
  shops: CloudShops,
  shopId: string,
  owner: Owner,
): Promise<string | null> {
  if (!(await shops.open(shopId))) return 'That shop was not found.';
  const db = shops.client(shopId)!;
  const role = await db.role.findUnique({ where: { code: 'SUPER_ADMIN' } });
  if (!role) return "This shop's data is still arriving from the shop. Try again in a minute.";
  const existing = await db.user.findUnique({
    where: { usernameKey: owner.usernameKey },
    include: { roles: { include: { role: true } } },
  });
  if (existing && !existing.roles.some((r) => r.role.code === 'SUPER_ADMIN'))
    return `At this shop the username "${owner.username}" belongs to someone else. Rename that account at the shop first.`;
  // A PIN is unique at each shop: the owner's goes on only where nobody else has it.
  let pin = owner.pinHmac;
  if (pin) {
    const holder = await db.user.findUnique({ where: { pinHmac: pin } });
    if (holder && holder.id !== existing?.id) pin = existing?.pinHmac ?? null;
  }
  if (
    existing &&
    existing.passwordHash === owner.passwordHash &&
    existing.fullName === owner.fullName &&
    existing.active &&
    !existing.mustChangePassword &&
    existing.pinHmac === pin
  )
    return null;
  await recordCloudChange(shopId, db, { byId: null, byName: owner.fullName, route: 'owner' }, () =>
    db.$transaction(async (tx) => {
      const data = {
        fullName: owner.fullName,
        passwordHash: owner.passwordHash,
        pinHmac: pin,
        active: true,
        mustChangePassword: false,
      };
      const user = existing
        ? await tx.user.update({ where: { id: existing.id }, data })
        : await tx.user.create({
            data: {
              ...data,
              username: owner.username,
              usernameKey: owner.usernameKey,
              roles: { create: [{ roleId: role.id }] },
            },
          });
      await audit(
        tx,
        { userId: user.id },
        {
          action: existing ? 'owner.update' : 'owner.create',
          entity: 'user',
          entityId: user.id,
          note: 'The owner account, the same at every shop.',
        },
      );
    }),
  );
  return null;
}

/** The owner's account at every shop but `except`; a shop that can't take it yet is skipped. */
export async function provisionAll(shops: CloudShops, owner: Owner, except?: string) {
  for (const node of await shops.list()) {
    if (node.id === except) continue;
    await provisionOwner(shops, node.id, owner).catch(() => null);
  }
}

/**
 * After a shop's push: a password the owner changed at that shop becomes the owner's password
 * everywhere, and a shop new to the panel gets the owner's account.
 */
export async function ownerAfterPush(
  shops: CloudShops,
  shopId: string,
  changes: { table: string; data: Record<string, unknown> | null }[],
) {
  let owner = await getOwner(shops.control);
  if (!owner) return;
  const mine = changes
    .filter((c) => c.table === 'users' && c.data?.username_key === owner!.usernameKey)
    .pop()?.data;
  if (mine && typeof mine.password_hash === 'string' && mine.password_hash !== owner.passwordHash) {
    owner = await updateOwner(
      shops,
      owner,
      { passwordHash: mine.password_hash, fullName: String(mine.full_name ?? owner.fullName) },
      shopId,
    );
  }
  await provisionOwner(shops, shopId, owner);
}
