import { D, DomainError, money, returnRefund, saleReturnSchema } from '@aruna/shared';
import type { Tx } from '../../db';
import { audit } from '../../core/audit';
import { actorOf, type RequestContext } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { moveStock } from '../../core/stock';
import { requireApproval } from '../../auth/approvals';
import { openShiftFor, requireCounter } from './service';

/**
 * Returns: no time limit; Cashiers, Admins and the Super Admin process them without approval.
 * The refund is the cash the customer actually paid for those units, after line discounts.
 * Restocked units go back to the sub-product they were sold from (a hidden zero-stock
 * sub-product reappears); damaged units go to the Damaged location. Loose and mixed paint can't
 * be returned. Returns of old-system bills, without a system invoice, are Admin only.
 */
export async function createReturn(tx: Tx, ctx: RequestContext, pinSecret: string, raw: unknown) {
  const input = saleReturnSchema.parse(raw);
  const counter = requireCounter(ctx);
  const shift = await openShiftFor(tx, counter.id, true, ctx.user.id);
  const damaged = await tx.location.findFirst({ where: { kind: 'DAMAGED', active: true } });
  if (!damaged) throw new DomainError('INVALID_STATE', 'The Damaged location is missing.');
  const reasons = await tx.reason.findMany({
    where: { id: { in: input.lines.map((l) => l.reasonId) } },
  });
  const reasonById = new Map(reasons.map((r) => [r.id, r]));
  for (const [i, l] of input.lines.entries()) {
    const r = reasonById.get(l.reasonId);
    if (!r || !r.active || !r.appliesTo.includes('RETURN'))
      throw new DomainError('VALIDATION', 'Pick a return reason.', `lines.${i}.reasonId`);
  }

  let approverId: string | null = null;
  const lines: {
    saleLineId: string | null;
    subProductId: string;
    name: string;
    qty: string;
    unitCost: string;
    amount: string;
    reasonId: string;
    disposition: 'RESTOCK' | 'DAMAGED';
  }[] = [];
  let sale = null;

  if (input.saleId) {
    sale = await tx.sale.findUnique({ where: { id: input.saleId }, include: { lines: true } });
    if (!sale || sale.kind !== 'INVOICE' || sale.status === 'HELD')
      throw new DomainError('NOT_FOUND', 'Invoice not found.');
    if (sale.status === 'VOID') throw new DomainError('INVALID_STATE', 'This bill is void.');
    const lineById = new Map(sale.lines.map((l) => [l.id, l]));
    const seen = new Set<string>();
    for (const [i, l] of input.lines.entries()) {
      const sl = l.saleLineId ? lineById.get(l.saleLineId) : undefined;
      if (!sl)
        throw new DomainError(
          'VALIDATION',
          'Pick a line from this invoice.',
          `lines.${i}.saleLineId`,
        );
      if (seen.has(sl.id))
        throw new DomainError('VALIDATION', 'Each line once.', `lines.${i}.saleLineId`);
      seen.add(sl.id);
      if (sl.isLoose)
        throw new DomainError(
          'VALIDATION',
          'Loose and mixed paint cannot be returned.',
          `lines.${i}.saleLineId`,
        );
      let amount;
      try {
        amount = returnRefund(
          {
            soldQty: sl.qty,
            returnedQty: sl.returnedQty,
            amount: sl.amount,
            refundedAmount: sl.refundedAmount,
          },
          l.qty,
        );
      } catch (err) {
        if (err instanceof DomainError)
          throw new DomainError(err.code, err.message, `lines.${i}.qty`, err.details);
        throw err;
      }
      if (!D(l.qty).isInteger()) {
        const sp = await tx.subProduct.findUniqueOrThrow({
          where: { id: sl.subProductId },
          include: { product: { include: { unit: true } } },
        });
        if (!sp.product.unit.allowsDecimal) {
          throw new DomainError(
            'VALIDATION',
            'Pieces and cans are whole numbers.',
            `lines.${i}.qty`,
          );
        }
      }
      await tx.saleLine.update({
        where: { id: sl.id },
        data: {
          returnedQty: { increment: l.qty },
          refundedAmount: { increment: amount.toFixed(2) },
        },
      });
      lines.push({
        saleLineId: sl.id,
        subProductId: sl.subProductId,
        name: sl.name,
        qty: l.qty,
        unitCost: sl.unitCost.toFixed(2),
        amount: amount.toFixed(2),
        reasonId: l.reasonId,
        disposition: l.disposition,
      });
    }
  } else {
    approverId = (await requireApproval(tx, ctx, 'OLD_SYSTEM_RETURN', input.approval, pinSecret))
      .approverId;
    const subs = await tx.subProduct.findMany({
      where: { id: { in: input.lines.flatMap((l) => (l.subProductId ? [l.subProductId] : [])) } },
      include: { product: true },
    });
    const subById = new Map(subs.map((s) => [s.id, s]));
    for (const [i, l] of input.lines.entries()) {
      const sp = l.subProductId ? subById.get(l.subProductId) : undefined;
      if (!sp)
        throw new DomainError(
          'VALIDATION',
          'Pick the item being returned.',
          `lines.${i}.subProductId`,
        );
      if (sp.product.type === 'MIX')
        throw new DomainError(
          'VALIDATION',
          'Loose and mixed paint cannot be returned.',
          `lines.${i}.subProductId`,
        );
      if (!l.refund)
        throw new DomainError('VALIDATION', 'Enter the refund for this line.', `lines.${i}.refund`);
      lines.push({
        saleLineId: null,
        subProductId: sp.id,
        name: sp.name,
        qty: l.qty,
        unitCost: sp.actualPrice.toFixed(2),
        amount: money(l.refund).toFixed(2),
        reasonId: l.reasonId,
        disposition: l.disposition,
      });
    }
  }

  const refundTotal = money(lines.reduce((s, l) => s.plus(D(l.amount)), D(0)));
  const no = await nextNumber(tx, 'SALES_RETURN');
  const ret = await tx.saleReturn.create({
    data: {
      no,
      saleId: sale?.id ?? null,
      oldBillRef: input.oldBillRef,
      locationId: counter.locationId,
      counterId: counter.id,
      shiftId: shift?.id ?? null,
      cashierId: ctx.user.id,
      approverId: approverId && approverId !== ctx.user.id ? approverId : null,
      refundTotal: refundTotal.toFixed(2),
      note: input.note,
      lines: {
        create: lines.map((l) => ({
          saleLineId: l.saleLineId,
          subProductId: l.subProductId,
          qty: l.qty,
          unitCost: l.unitCost,
          amount: l.amount,
          reasonId: l.reasonId,
          disposition: l.disposition,
        })),
      },
    },
    include: { lines: true },
  });
  for (const line of ret.lines) {
    await moveStock(tx, {
      subProductId: line.subProductId,
      locationId:
        line.disposition === 'DAMAGED' ? damaged.id : (sale?.locationId ?? counter.locationId),
      qty: line.qty,
      type: 'SALE_RETURN',
      unitCost: line.unitCost,
      docId: ret.id,
      docNo: no,
      lineId: line.id,
      userId: ctx.user.id,
      note: reasonById.get(line.reasonId)!.name,
    });
  }
  if (sale)
    await tx.sale.update({
      where: { id: sale.id },
      data: { refundedTotal: { increment: refundTotal.toFixed(2) } },
    });
  await audit(tx, actorOf(ctx), {
    action: sale ? 'sale.return' : 'sale.return_old_system',
    entity: 'sale_return',
    entityId: ret.id,
    approverId: ret.approverId,
    after: {
      no,
      sale: sale?.no ?? input.oldBillRef,
      refundTotal: refundTotal.toFixed(2),
      lines: lines.length,
    },
  });
  return {
    id: ret.id,
    no,
    refundTotal: refundTotal.toFixed(2),
    subProductIds: [...new Set(lines.map((l) => l.subProductId))],
    receipt: {
      no,
      saleNo: sale?.no ?? null,
      oldBillRef: input.oldBillRef,
      at: ret.createdAt,
      cashier: ctx.user.fullName,
      lines: lines.map((l) => ({
        name: l.name,
        qty: l.qty,
        amount: l.amount,
        disposition: l.disposition,
        reason: reasonById.get(l.reasonId)!.name,
      })),
      refundTotal: refundTotal.toFixed(2),
    },
  };
}
