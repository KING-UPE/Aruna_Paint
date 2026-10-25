import { D, DomainError, adjustmentSchema, transferSchema } from '@aruna/shared';
import { z } from 'zod';
import type { Tx } from '../../db';
import { audit } from '../../core/audit';
import type { ActorRef } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { moveStock } from '../../core/stock';

type Actor = ActorRef & { userId: string };

/** Moves stock between locations; posts at once and returns what to print on the transfer note. */
export async function createTransfer(tx: Tx, actor: Actor, raw: unknown) {
  const input = transferSchema.parse(raw);
  if (input.fromLocationId === input.toLocationId) {
    throw new DomainError('VALIDATION', 'From and to must be different locations.', 'toLocationId');
  }
  const locations = await tx.location.findMany({
    where: { id: { in: [input.fromLocationId, input.toLocationId] }, active: true },
  });
  if (locations.length !== 2)
    throw new DomainError('VALIDATION', 'Pick two active locations.', 'toLocationId');
  const no = await nextNumber(tx, 'TRANSFER');
  const transfer = await tx.transfer.create({
    data: {
      no,
      fromLocationId: input.fromLocationId,
      toLocationId: input.toLocationId,
      note: input.note,
      createdById: actor.userId,
      lines: { create: input.lines.map((l) => ({ subProductId: l.subProductId, qty: l.qty })) },
    },
    include: { lines: { include: { subProduct: true } } },
  });
  for (const line of transfer.lines) {
    // Qty can't exceed what the source holds; the stock move refuses it.
    await moveStock(tx, {
      subProductId: line.subProductId,
      locationId: input.fromLocationId,
      qty: D(line.qty).negated(),
      type: 'TRANSFER_OUT',
      unitCost: line.subProduct.actualPrice,
      docId: transfer.id,
      docNo: no,
      lineId: line.id,
      userId: actor.userId,
      label: line.subProduct.code,
    });
    await moveStock(tx, {
      subProductId: line.subProductId,
      locationId: input.toLocationId,
      qty: line.qty,
      type: 'TRANSFER_IN',
      unitCost: line.subProduct.actualPrice,
      docId: transfer.id,
      docNo: no,
      lineId: line.id,
      userId: actor.userId,
    });
  }
  await audit(tx, actor, {
    action: 'transfer.create',
    entity: 'transfer',
    entityId: transfer.id,
    after: { no, lines: input.lines },
  });
  return { id: transfer.id, no, subProductIds: transfer.lines.map((l) => l.subProductId) };
}

/**
 * Adds or removes qty of a sub-product (or liters of mix paint) with a reason. Removing stock is
 * a write-off and needs Admin approval, given by the caller as `approverId`.
 */
export async function createAdjustment(
  tx: Tx,
  actor: Actor,
  input: z.output<typeof adjustmentSchema> & { locationId: string },
  approverId: string | null,
) {
  const reasons = await tx.reason.findMany({
    where: { id: { in: input.lines.map((l) => l.reasonId) } },
  });
  const reasonById = new Map(reasons.map((r) => [r.id, r]));
  const subs = await tx.subProduct.findMany({
    where: { id: { in: input.lines.map((l) => l.subProductId) } },
    include: { product: { include: { unit: true } } },
  });
  const subById = new Map(subs.map((s) => [s.id, s]));
  for (const [i, l] of input.lines.entries()) {
    const r = reasonById.get(l.reasonId);
    if (!r || !r.active || !r.appliesTo.includes('ADJUSTMENT')) {
      throw new DomainError('VALIDATION', 'Pick an adjustment reason.', `lines.${i}.reasonId`);
    }
    const sp = subById.get(l.subProductId);
    if (!sp) throw new DomainError('VALIDATION', 'Unknown item.', `lines.${i}.subProductId`);
    if (!sp.product.unit.allowsDecimal && sp.product.type !== 'MIX' && !D(l.qty).isInteger()) {
      throw new DomainError('VALIDATION', 'Pieces and cans are whole numbers.', `lines.${i}.qty`);
    }
  }
  const no = await nextNumber(tx, 'ADJUSTMENT');
  const adjustment = await tx.adjustment.create({
    data: {
      no,
      locationId: input.locationId,
      status: 'POSTED',
      note: input.note,
      createdById: actor.userId,
      approvedById: approverId,
      postedAt: new Date(),
      lines: {
        create: input.lines.map((l) => ({
          subProductId: l.subProductId,
          qty: D(l.qty).toFixed(3),
          unitCost: subById.get(l.subProductId)!.actualPrice,
          reasonId: l.reasonId,
        })),
      },
    },
    include: { lines: true },
  });
  for (const line of adjustment.lines) {
    const sp = subById.get(line.subProductId)!;
    await moveStock(tx, {
      subProductId: line.subProductId,
      locationId: input.locationId,
      qty: line.qty,
      type: 'ADJUSTMENT',
      unitCost: line.unitCost,
      docId: adjustment.id,
      docNo: no,
      lineId: line.id,
      userId: actor.userId,
      note: reasonById.get(line.reasonId)!.name,
      label: sp.code,
    });
  }
  await audit(tx, actor, {
    action: 'adjustment.create',
    entity: 'adjustment',
    entityId: adjustment.id,
    approverId: approverId && approverId !== actor.userId ? approverId : null,
    after: { no, lines: input.lines },
  });
  return { id: adjustment.id, no, subProductIds: adjustment.lines.map((l) => l.subProductId) };
}
