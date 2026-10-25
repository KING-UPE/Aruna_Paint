import { APPROVALS, DomainError, type ApprovalKind } from '@aruna/shared';
import type { Tx } from '../db';
import type { RequestContext } from '../core/context';
import { pinHmac } from './crypto';
import { loadUserPermissions } from './permissions';

export interface ApprovalResult {
  /** The person who approved; the acting user when they hold the permission themselves. */
  approverId: string;
  /** True when someone else typed their PIN (a manager override). */
  override: boolean;
}

/**
 * Manager override: when a cashier hits a limit, an Admin types their PIN on the same screen.
 * Both names go into the log. Users who hold the permission themselves don't need a PIN.
 */
export async function requireApproval(
  tx: Tx,
  ctx: RequestContext,
  kind: ApprovalKind,
  approval: { pin: string } | undefined,
  pinSecret: string,
): Promise<ApprovalResult> {
  const def = APPROVALS[kind];
  if (ctx.permissions.has(def.permission)) return { approverId: ctx.user.id, override: false };
  if (!approval?.pin) {
    throw new DomainError(
      'APPROVAL_REQUIRED',
      `${def.label} needs an approver's PIN.`,
      'approval.pin',
      {
        kind,
        permission: def.permission,
      },
    );
  }
  const approver = await tx.user.findUnique({
    where: { pinHmac: pinHmac(approval.pin, pinSecret) },
  });
  if (!approver || !approver.active) {
    throw new DomainError('APPROVAL_REQUIRED', 'That PIN is not right.', 'approval.pin', {
      kind,
      permission: def.permission,
    });
  }
  const { permissions } = await loadUserPermissions(tx, approver.id);
  if (!permissions.has(def.permission)) {
    throw new DomainError(
      'APPROVAL_REQUIRED',
      `${approver.fullName} can't approve this.`,
      'approval.pin',
      {
        kind,
        permission: def.permission,
      },
    );
  }
  return { approverId: approver.id, override: true };
}
