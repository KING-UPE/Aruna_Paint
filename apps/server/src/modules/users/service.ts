import {
  DomainError,
  assignablePermissions,
  isPermission,
  isSuperAdminOnly,
  rolePermissions,
  nameKey,
  passwordSchema,
  percentSchema,
  pinSchema,
  type Permission,
} from '@aruna/shared';
import { z } from 'zod';
import type { Tx } from '../../db';
import { audit } from '../../core/audit';
import type { ActorRef } from '../../core/context';
import { hashPassword, pinHmac } from '../../auth/crypto';

const usernameSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[A-Za-z0-9._-]+$/, { message: 'Use letters, digits and . _ - only.' });

export const createUserSchema = z.object({
  username: usernameSchema,
  fullName: z.string().min(1).max(120),
  password: passwordSchema,
  pin: pinSchema.optional().nullable(),
  roleIds: z.array(z.uuid()).min(1, { message: 'Tick at least one role.' }),
  commissionRate: percentSchema.optional().nullable(),
  mustChangePassword: z.boolean().default(true),
  permissionOverrides: z
    .array(z.object({ permission: z.string(), granted: z.boolean() }))
    .default([]),
});

export const updateUserSchema = z.object({
  fullName: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
  roleIds: z.array(z.uuid()).min(1, { message: 'Tick at least one role.' }).optional(),
  commissionRate: percentSchema.optional().nullable(),
  /** The full list of this user's changes on top of their roles; replaces the old list. */
  permissionOverrides: z
    .array(z.object({ permission: z.string(), granted: z.boolean() }))
    .optional(),
});

export const roleSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(300).default(''),
  permissions: z.array(z.string()).default([]),
});

function publicUser(u: {
  id: string;
  username: string;
  fullName: string;
  active: boolean;
  mustChangePassword: boolean;
  testMode: boolean;
  pinHmac: string | null;
  commissionRate: { toString(): string } | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  roles: { role: { id: string; code: string; name: string } }[];
  permissionOverrides?: { permission: string; granted: boolean }[];
}) {
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    active: u.active,
    mustChangePassword: u.mustChangePassword,
    testMode: u.testMode,
    hasPin: u.pinHmac !== null,
    commissionRate: u.commissionRate?.toString() ?? null,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    roles: u.roles.map((r) => ({ id: r.role.id, code: r.role.code, name: r.role.name })),
    permissionOverrides: (u.permissionOverrides ?? [])
      .map((o) => ({ permission: o.permission, granted: o.granted }))
      .sort((a, b) => a.permission.localeCompare(b.permission)),
  };
}

const userInclude = { roles: { include: { role: true } }, permissionOverrides: true } as const;

/** Only real, non-Super Admin-only permissions can be added or taken away per user. */
function checkOverrides(list: { permission: string; granted: boolean }[]) {
  const bad = list.filter((o) => !isPermission(o.permission) || isSuperAdminOnly(o.permission));
  if (bad.length) {
    throw new DomainError(
      'VALIDATION',
      `These can only belong to the Super Admin: ${bad.map((b) => b.permission).join(', ')}.`,
      'permissionOverrides',
    );
  }
  const seen = new Map<string, boolean>();
  for (const o of list) seen.set(o.permission, o.granted);
  return [...seen].map(([permission, granted]) => ({ permission, granted }));
}

async function saveOverrides(
  tx: Tx,
  userId: string,
  list: { permission: string; granted: boolean }[],
) {
  await tx.userPermission.deleteMany({ where: { userId } });
  if (list.length)
    await tx.userPermission.createMany({ data: list.map((o) => ({ userId, ...o })) });
}

export async function listUsers(tx: Tx) {
  const users = await tx.user.findMany({
    include: userInclude,
    orderBy: [{ active: 'desc' }, { fullName: 'asc' }],
  });
  return users.map(publicUser);
}

async function superAdminRoleId(tx: Tx): Promise<string> {
  return (await tx.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } })).id;
}

/** At least one active Super Admin must always exist. */
async function assertSuperAdminRemains(tx: Tx) {
  const saId = await superAdminRoleId(tx);
  const count = await tx.user.count({ where: { active: true, roles: { some: { roleId: saId } } } });
  if (count === 0)
    throw new DomainError('INVALID_STATE', 'At least one active Super Admin must remain.');
}

async function assertRolesExist(tx: Tx, roleIds: string[]) {
  const found = await tx.role.count({ where: { id: { in: roleIds } } });
  if (found !== new Set(roleIds).size)
    throw new DomainError('VALIDATION', 'Unknown role.', 'roleIds');
}

async function assertPinFree(tx: Tx, hmac: string, exceptUserId?: string) {
  const owner = await tx.user.findUnique({ where: { pinHmac: hmac } });
  if (owner && owner.id !== exceptUserId) {
    throw new DomainError(
      'DUPLICATE',
      'That PIN is already used by someone else. Choose another.',
      'pin',
    );
  }
}

export async function createUser(tx: Tx, actor: ActorRef, raw: unknown, pinSecret: string) {
  const input = createUserSchema.parse(raw);
  if (await tx.user.findUnique({ where: { usernameKey: nameKey(input.username) } })) {
    throw new DomainError('DUPLICATE', 'That username is taken.', 'username');
  }
  await assertRolesExist(tx, input.roleIds);
  const hmac = input.pin ? pinHmac(input.pin, pinSecret) : null;
  if (hmac) await assertPinFree(tx, hmac);
  const overrides = checkOverrides(input.permissionOverrides);
  const user = await tx.user.create({
    data: {
      username: input.username,
      usernameKey: nameKey(input.username),
      fullName: input.fullName,
      passwordHash: await hashPassword(input.password),
      mustChangePassword: input.mustChangePassword,
      pinHmac: hmac,
      commissionRate: input.commissionRate ?? null,
      roles: { create: input.roleIds.map((roleId) => ({ roleId })) },
      permissionOverrides: { create: overrides },
    },
    include: userInclude,
  });
  const out = publicUser(user);
  await audit(tx, actor, { action: 'user.create', entity: 'user', entityId: user.id, after: out });
  return out;
}

export async function updateUser(tx: Tx, actor: ActorRef, id: string, raw: unknown) {
  const input = updateUserSchema.parse(raw);
  const before = await tx.user.findUnique({ where: { id }, include: userInclude });
  if (!before) throw new DomainError('NOT_FOUND', 'User not found.');
  if (input.roleIds) await assertRolesExist(tx, input.roleIds);
  if (input.permissionOverrides)
    await saveOverrides(tx, id, checkOverrides(input.permissionOverrides));
  await tx.user.update({
    where: { id },
    data: {
      fullName: input.fullName,
      active: input.active,
      commissionRate: input.commissionRate === undefined ? undefined : input.commissionRate,
    },
  });
  if (input.roleIds) {
    await tx.userRole.deleteMany({ where: { userId: id, roleId: { notIn: input.roleIds } } });
    for (const roleId of input.roleIds) {
      await tx.userRole.upsert({
        where: { userId_roleId: { userId: id, roleId } },
        create: { userId: id, roleId },
        update: {},
      });
    }
  }
  if (input.active === false) {
    await tx.session.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  await assertSuperAdminRemains(tx);
  const after = await tx.user.findUniqueOrThrow({ where: { id }, include: userInclude });
  await audit(tx, actor, {
    action: 'user.update',
    entity: 'user',
    entityId: id,
    before: publicUser(before),
    after: publicUser(after),
  });
  return publicUser(after);
}

/** The Super Admin resets passwords; the user must change a reset password at next login. */
export async function resetPassword(tx: Tx, actor: ActorRef, id: string, password: string) {
  passwordSchema.parse(password);
  await tx.user.update({
    where: { id },
    data: { passwordHash: await hashPassword(password), mustChangePassword: true },
  });
  await tx.session.updateMany({
    where: { userId: id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await audit(tx, actor, { action: 'user.reset_password', entity: 'user', entityId: id });
}

export async function resetPin(
  tx: Tx,
  actor: ActorRef,
  id: string,
  pin: string | null,
  pinSecret: string,
) {
  if (pin !== null) pinSchema.parse(pin);
  const hmac = pin ? pinHmac(pin, pinSecret) : null;
  if (hmac) await assertPinFree(tx, hmac, id);
  await tx.user.update({ where: { id }, data: { pinHmac: hmac } });
  await audit(tx, actor, {
    action: pin ? 'user.reset_pin' : 'user.clear_pin',
    entity: 'user',
    entityId: id,
  });
}

export async function deleteUser(tx: Tx, actor: ActorRef, id: string) {
  const user = await tx.user.findUnique({
    where: { id },
    include: userInclude,
  });
  if (!user) throw new DomainError('NOT_FOUND', 'User not found.');

  const isSuperAdmin = user.roles.some((r) => r.role.code === 'SUPER_ADMIN');
  if (isSuperAdmin) {
    throw new DomainError('INVALID_STATE', 'Super Admin users cannot be deleted.');
  }

  if (actor.userId === id) {
    throw new DomainError('INVALID_STATE', 'You cannot delete your own account.');
  }

  // Check if user has associated transactions
  const [sales, purchases, shifts, closings] = await Promise.all([
    tx.sale.count({ where: { OR: [{ cashierId: id }, { voidedById: id }] } }),
    tx.purchase.count({ where: { OR: [{ createdById: id }, { postedById: id }] } }),
    tx.shift.count({ where: { OR: [{ openedById: id }, { closedById: id }] } }),
    tx.monthlyClosing.count({ where: { closedById: id } }),
  ]);

  if (sales > 0 || purchases > 0 || shifts > 0 || closings > 0) {
    throw new DomainError(
      'IN_USE',
      'This user has transaction records (sales, purchases, or shifts). You can disable their account instead of deleting.',
    );
  }

  // Clean up user-related records that reference userId
  await tx.session.deleteMany({ where: { userId: id } });
  await tx.userShortcut.deleteMany({ where: { userId: id } });
  await tx.userRole.deleteMany({ where: { userId: id } });

  try {
    await tx.user.delete({ where: { id } });
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'P2003') {
      throw new DomainError(
        'IN_USE',
        'This user has transaction records and cannot be permanently deleted. You can disable their account instead.',
      );
    }
    throw err;
  }

  await assertSuperAdminRemains(tx);

  await audit(tx, actor, {
    action: 'user.delete',
    entity: 'user',
    entityId: id,
    before: publicUser(user),
  });
}

export async function listRoles(tx: Tx) {
  const roles = await tx.role.findMany({
    include: { permissions: true, _count: { select: { users: true } } },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return roles.map((r) => {
    const stored = r.permissions.map((p) => p.permission);
    const defaults = r.builtIn ? rolePermissions({ code: r.code }) : null;
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      builtIn: r.builtIn,
      /** A built-in role whose permissions the Super Admin changed. */
      customized: r.builtIn && r.customized,
      userCount: r._count.users,
      permissions: rolePermissions({ code: r.code, customized: r.customized, permissions: stored }),
      /** What a built-in role allows out of the box; null for roles the Super Admin made. */
      defaultPermissions: defaults,
    };
  });
}

/** Custom roles take any permission except Super Admin-only ones; built-in roles also keep their own defaults. */
function checkPermissions(perms: string[], roleCode?: string): Permission[] {
  const allowed = new Set<string>(assignablePermissions());
  if (roleCode) for (const p of rolePermissions({ code: roleCode })) allowed.add(p);
  const bad = perms.filter((p) => !allowed.has(p));
  if (bad.length)
    throw new DomainError(
      'VALIDATION',
      `These can only belong to the Super Admin: ${bad.join(', ')}.`,
      'permissions',
    );
  return [...new Set(perms)] as Permission[];
}

/** The Super Admin can build a role from module permissions; it appears as another checkbox. */
export async function createRole(tx: Tx, actor: ActorRef, raw: unknown) {
  const input = roleSchema.parse(raw);
  const perms = checkPermissions(input.permissions);
  if (await tx.role.findUnique({ where: { nameKey: nameKey(input.name) } })) {
    throw new DomainError('DUPLICATE', 'A role with this name already exists.', 'name');
  }
  const count = await tx.role.count({ where: { builtIn: false } });
  const role = await tx.role.create({
    data: {
      code: `CUSTOM_${count + 1}_${Date.now().toString(36).toUpperCase()}`,
      name: input.name,
      nameKey: nameKey(input.name),
      description: input.description,
      sortOrder: 100 + count,
      permissions: { create: perms.map((permission) => ({ permission })) },
    },
  });
  await audit(tx, actor, {
    action: 'role.create',
    entity: 'role',
    entityId: role.id,
    after: { ...input, permissions: perms },
  });
  return role;
}

/**
 * Custom roles: name, description and permissions. Built-in roles keep their name, but the Super
 * Admin may change which permissions they give (the Super Admin role itself always has everything).
 */
export async function updateRole(tx: Tx, actor: ActorRef, id: string, raw: unknown) {
  const input = roleSchema.partial().parse(raw);
  const role = await tx.role.findUnique({ where: { id }, include: { permissions: true } });
  if (!role) throw new DomainError('NOT_FOUND', 'Role not found.');
  if (role.code === 'SUPER_ADMIN') {
    throw new DomainError('INVALID_STATE', 'The Super Admin always has every permission.');
  }
  const before = {
    name: role.name,
    permissions: rolePermissions({
      code: role.code,
      customized: role.customized,
      permissions: role.permissions.map((p) => p.permission),
    }),
  };
  if (!role.builtIn) {
    if (
      input.name &&
      (await tx.role.findFirst({ where: { nameKey: nameKey(input.name), id: { not: id } } }))
    ) {
      throw new DomainError('DUPLICATE', 'A role with this name already exists.', 'name');
    }
    await tx.role.update({
      where: { id },
      data: {
        name: input.name,
        nameKey: input.name ? nameKey(input.name) : undefined,
        description: input.description,
      },
    });
  }
  let perms: Permission[] | undefined;
  if (input.permissions) {
    perms = checkPermissions(input.permissions, role.builtIn ? role.code : undefined);
    await tx.rolePermission.deleteMany({ where: { roleId: id } });
    await tx.rolePermission.createMany({
      data: perms.map((permission) => ({ roleId: id, permission })),
    });
    if (role.builtIn) await tx.role.update({ where: { id }, data: { customized: true } });
  }
  await audit(tx, actor, {
    action: 'role.update',
    entity: 'role',
    entityId: id,
    before,
    after: role.builtIn
      ? { name: role.name, permissions: perms }
      : { ...input, permissions: perms },
  });
}

/** Puts a built-in role back to the permissions it came with. */
export async function resetRole(tx: Tx, actor: ActorRef, id: string) {
  const role = await tx.role.findUnique({ where: { id }, include: { permissions: true } });
  if (!role) throw new DomainError('NOT_FOUND', 'Role not found.');
  if (!role.builtIn) {
    throw new DomainError('INVALID_STATE', 'Only built-in roles have default permissions.');
  }
  await tx.rolePermission.deleteMany({ where: { roleId: id } });
  await tx.role.update({ where: { id }, data: { customized: false } });
  await audit(tx, actor, {
    action: 'role.reset',
    entity: 'role',
    entityId: id,
    before: { permissions: role.permissions.map((p) => p.permission) },
    after: { permissions: rolePermissions({ code: role.code }) },
  });
}

/** A role still ticked for any user can't be deleted. */
export async function deleteRole(tx: Tx, actor: ActorRef, id: string) {
  const role = await tx.role.findUnique({
    where: { id },
    include: { _count: { select: { users: true } } },
  });
  if (!role) throw new DomainError('NOT_FOUND', 'Role not found.');
  if (role.builtIn) throw new DomainError('INVALID_STATE', 'Built-in roles cannot be deleted.');
  if (role._count.users > 0)
    throw new DomainError('IN_USE', 'This role is still ticked for a user.');
  await tx.role.delete({ where: { id } });
  await audit(tx, actor, {
    action: 'role.delete',
    entity: 'role',
    entityId: id,
    before: { name: role.name },
  });
}
