import {
  DomainError,
  MODULES,
  SPECIAL_PERMISSIONS,
  type ModuleKey,
  type Permission,
} from '@aruna/shared';
import type { FastifyRequest } from 'fastify';

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

/** The shop server is the only writer; the cloud mirror is view-only. */
export function shopOnly() {
  return async (req: FastifyRequest) => {
    if (req.server.deps.config.mode !== 'shop') {
      throw new DomainError(
        'FORBIDDEN',
        'The online panel is view-only. Make this change at the shop.',
      );
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
