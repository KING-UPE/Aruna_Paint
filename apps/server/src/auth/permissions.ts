import { resolvePermissions, type PermissionSet } from '@aruna/shared';
import type { Tx } from '../db';
import type { Db } from '../db';

/** Combines every ticked role of a user. */
export async function loadUserPermissions(
  db: Db | Tx,
  userId: string,
): Promise<{ roleCodes: string[]; permissions: PermissionSet }> {
  const roles = await db.userRole.findMany({
    where: { userId },
    include: { role: { include: { permissions: true } } },
  });
  const list = roles.map((r) => ({
    code: r.role.code,
    permissions: r.role.permissions.map((p) => p.permission),
  }));
  return { roleCodes: list.map((r) => r.code), permissions: resolvePermissions(list) };
}
