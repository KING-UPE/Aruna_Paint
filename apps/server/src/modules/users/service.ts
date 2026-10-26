import {
  BUILT_IN_ROLE_PERMISSIONS,
  DomainError,
  assignablePermissions,
  nameKey,
  passwordSchema,
  percentSchema,
  pinSchema,
  type BuiltInRole,
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
});

export const updateUserSchema = z.object({
  fullName: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
  roleIds: z.array(z.uuid()).min(1, { message: 'Tick at least one role.' }).optional(),
  commissionRate: percentSchema.optional().nullable(),
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
  pinHmac: string | null;
  commissionRate: { toString(): string } | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  roles: { role: { id: string; code: string; name: string } }[];
}) {
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    active: u.active,
    mustChangePassword: u.mustChangePassword,
    hasPin: u.pinHmac !== null,
    commissionRate: u.commissionRate?.toString() ?? null,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    roles: u.roles.map((r) => ({ id: r.role.id, code: r.role.code, name: r.role.name })),
  };
}

export async function listUsers(tx: Tx) {
  const users = await tx.user.findMany({
    include: { roles: { include: { role: true } } },
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
    },
    include: { roles: { include: { role: true } } },
  });
  const out = publicUser(user);
  await audit(tx, actor, { action: 'user.create', entity: 'user', entityId: user.id, after: out });
  return out;
}

export async function updateUser(tx: Tx, actor: ActorRef, id: string, raw: unknown) {
  const input = updateUserSchema.parse(raw);
  const before = await tx.user.findUnique({
    where: { id },
    include: { roles: { include: { role: true } } },
  });
  if (!before) throw new DomainError('NOT_FOUND', 'User not found.');
  if (input.roleIds) await assertRolesExist(tx, input.roleIds);
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
  const after = await tx.user.findUniqueOrThrow({
    where: { id },
    include: { roles: { include: { role: true } } },
  });
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
    include: { roles: { include: { role: true } } },
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
  await tx.auditLog.updateMany({ where: { userId: id }, data: { userId: null } });
  await tx.auditLog.updateMany({ where: { approverId: id }, data: { approverId: null } });

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
  return roles.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    builtIn: r.builtIn,
    userCount: r._count.users,
    permissions: r.builtIn
      ? (BUILT_IN_ROLE_PERMISSIONS[r.code as BuiltInRole] ?? [])
      : r.permissions.map((p) => p.permission),
  }));
}

function checkPermissions(perms: string[]): Permission[] {
  const allowed = new Set<string>(assignablePermissions());
  const bad = perms.filter((p) => !allowed.has(p));
  if (bad.length)
    throw new DomainError(
      'VALIDATION',
      `These can't be given to a custom role: ${bad.join(', ')}.`,
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

export async function updateRole(tx: Tx, actor: ActorRef, id: string, raw: unknown) {
  const input = roleSchema.partial().parse(raw);
  const role = await tx.role.findUnique({ where: { id }, include: { permissions: true } });
  if (!role) throw new DomainError('NOT_FOUND', 'Role not found.');
  if (role.builtIn) throw new DomainError('INVALID_STATE', 'Built-in roles cannot be changed.');
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
  if (input.permissions) {
    const perms = checkPermissions(input.permissions);
    await tx.rolePermission.deleteMany({ where: { roleId: id } });
    await tx.rolePermission.createMany({
      data: perms.map((permission) => ({ roleId: id, permission })),
    });
  }
  await audit(tx, actor, {
    action: 'role.update',
    entity: 'role',
    entityId: id,
    before: { name: role.name, permissions: role.permissions.map((p) => p.permission) },
    after: input,
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
