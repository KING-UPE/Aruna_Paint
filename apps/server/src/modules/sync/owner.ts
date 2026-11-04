import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../db';
import { audit } from '../../core/audit';
import type { CloudShops } from '../../core/shops';
import { recordCloudChange } from './cloud';

/**
 * The owner is the Super Admin (the owner's request: no separate account). A Super Admin who signs
 * in on the online panel with their own username and password becomes an owner: they see every
 * shop, new ones included, with that one sign-in, and their account is copied to each shop as a
 * Super Admin, so the same username and password work at every shop's PCs. A password changed
 * online or at any shop reaches every shop. Owners are kept in the cloud's own database.
 */
export interface Owner {
  username: string;
  usernameKey: string;
  fullName: string;
  passwordHash: string;
  /** Only a PIN set online goes to the shops (shops never send PINs up). */
  pinHmac: string | null;
  /** Goes up with every password change, so sign-ins with the old one end. */
  version: number;
  updatedAt: string;
}

const STATE = 'owners';
export const OWNER_COOKIE = 'aruna_owner';
const COOKIE_DAYS = 30;

export async function getOwners(control: Db): Promise<Owner[]> {
  const row = await control.syncState.findUnique({ where: { key: STATE } });
  return Object.values((row?.value as unknown as Record<string, Owner> | undefined) ?? {});
}

export async function getOwner(control: Db, usernameKey: string): Promise<Owner | null> {
  return (await getOwners(control)).find((o) => o.usernameKey === usernameKey) ?? null;
}

async function saveOwner(control: Db, owner: Owner) {
  const all = Object.fromEntries((await getOwners(control)).map((o) => [o.usernameKey, o]));
  all[owner.usernameKey] = owner;
  const value = all as unknown as object;
  await control.syncState.upsert({
    where: { key: STATE },
    create: { key: STATE, value },
    update: { value },
  });
}

const same = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/**
 * A Super Admin signed in on the panel at `shopId`: they become (or stay) an owner, with the
 * password they use there, and their account goes to every other shop.
 */
export async function becomeOwner(
  shops: CloudShops,
  shopId: string,
  user: { username: string; usernameKey: string; fullName: string; passwordHash: string },
): Promise<Owner> {
  const owner = await getOwner(shops.control, user.usernameKey);
  if (!owner) {
    const created: Owner = {
      username: user.username,
      usernameKey: user.usernameKey,
      fullName: user.fullName,
      passwordHash: user.passwordHash,
      pinHmac: null,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    await saveOwner(shops.control, created);
    await provisionAll(shops, created, shopId);
    return created;
  }
  if (owner.passwordHash !== user.passwordHash || owner.fullName !== user.fullName)
    return updateOwner(
      shops,
      owner,
      { passwordHash: user.passwordHash, fullName: user.fullName },
      shopId,
    );
  return owner;
}

/** A new password (and name) for an owner, to reach every shop but `from`, which has it. */
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
  const owner = key ? await getOwner(control, key) : null;
  if (!owner || String(owner.version) !== version) return null;
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
  // A PIN is unique at each shop: one set online goes on only where nobody else has it; else
  // the shop keeps the owner's own PIN there.
  let pin = owner.pinHmac ?? existing?.pinHmac ?? null;
  if (pin && pin !== existing?.pinHmac) {
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
 * After a shop's push: a password an owner changed at that shop becomes their password
 * everywhere, and a shop new to the panel gets the owners' accounts.
 */
export async function ownerAfterPush(
  shops: CloudShops,
  shopId: string,
  changes: { table: string; data: Record<string, unknown> | null }[],
) {
  for (let owner of await getOwners(shops.control)) {
    const mine = changes
      .filter((c) => c.table === 'users' && c.data?.username_key === owner.usernameKey)
      .pop()?.data;
    if (mine && typeof mine.password_hash === 'string' && mine.password_hash !== owner.passwordHash)
      owner = await updateOwner(
        shops,
        owner,
        { passwordHash: mine.password_hash, fullName: String(mine.full_name ?? owner.fullName) },
        shopId,
      );
    await provisionOwner(shops, shopId, owner);
  }
}
