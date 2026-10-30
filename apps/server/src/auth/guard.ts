import {
  DomainError,
  MODULES,
  SPECIAL_PERMISSIONS,
  type ModuleKey,
  type Permission,
} from '@aruna/shared';
import type { FastifyRequest } from 'fastify';
import { ONLINE_CHANGES } from '../modules/sync/online';

function label(p: Permission): string {
  if (p in SPECIAL_PERMISSIONS)
    return SPECIAL_PERMISSIONS[p as keyof typeof SPECIAL_PERMISSIONS].label;
  const [mod, action] = p.split('.') as [ModuleKey, string];
  return `${action} ${MODULES[mod]?.label ?? mod}`;
}

/** preHandler: the user must hold at least one of these permissions. */
export function perm(...perms: Permission[]) {
  return async (req: FastifyRequest) => {
    if (!req.ctx.permissions.any(...perms)) {
      throw new DomainError(
        'FORBIDDEN',
        `You don't have permission to ${label(perms[0]!)}.`,
        undefined,
        {
          permission: perms[0],
        },
      );
    }
  };
}

/** preHandler: only a Super Admin (for things the plan keeps to the owner, like rename history). */
export function superAdminOnly() {
  return async (req: FastifyRequest) => {
    if (!req.ctx.roleCodes.includes('SUPER_ADMIN')) {
      throw new DomainError('FORBIDDEN', 'Only the Super Admin can see this.');
    }
  };
}

/**
 * Writes happen at the shop. The online panel may make only the changes in ONLINE_CHANGES, which
 * the shop applies when it next syncs.
 */
export function shopOnly() {
  return async (req: FastifyRequest) => {
    if (req.server.deps.config.mode === 'shop') return;
    if (!ONLINE_CHANGES.has(`${req.method} ${req.routeOptions.url}`)) {
      throw new DomainError('FORBIDDEN', 'This can only be done at the shop.');
    }
  };
}

/** Cost privacy: each product's cost/profit/margin needs cost.item; totals need cost.totals. */
export function canSeeItemCost(req: FastifyRequest): boolean {
  return req.ctx.permissions.has('cost.item') || req.ctx.permissions.has('cost.totals');
}

export function canSeeCostTotals(req: FastifyRequest): boolean {
  return req.ctx.permissions.has('cost.totals');
}
