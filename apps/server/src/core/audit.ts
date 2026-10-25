import type { Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { toJson } from '../lib/json';
import type { ActorRef } from './context';

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  note?: string;
  /** The person who typed their PIN for a manager override. */
  approverId?: string | null;
}

/** Every create, edit, price change, override, reprint, void, return and login. */
export async function audit(tx: Tx, actor: ActorRef, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      userId: actor.userId,
      approverId: entry.approverId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      before:
        entry.before === undefined ? undefined : (toJson(entry.before) as Prisma.InputJsonValue),
      after: entry.after === undefined ? undefined : (toJson(entry.after) as Prisma.InputJsonValue),
      note: entry.note ?? '',
      counterId: actor.counterId ?? null,
      ip: actor.ip ?? '',
    },
  });
}

/** Only the fields that changed, for compact before/after records. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    const bv = toJson(before[k]);
    const av = toJson(after[k]);
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      b[k] = bv;
      a[k] = av;
    }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}
