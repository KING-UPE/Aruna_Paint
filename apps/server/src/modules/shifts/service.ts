import { D, money } from '@aruna/shared';
import type { Tx } from '../../db';
import { audit } from '../../core/audit';
import type { RequestContext } from '../../core/context';
import { dateOnly } from '../../lib/json';
import { requireCounter } from '../sales/service';

/** The day's sales and refunds on one counter (older days may also hold a float and cash moves). */
export async function shiftSummary(tx: Tx, shiftId: string) {
  const shift = await tx.shift.findUniqueOrThrow({
    where: { id: shiftId },
    include: {
      counter: true,
      openedBy: { select: { fullName: true } },
      closedBy: { select: { fullName: true } },
      cashMovements: {
        include: { reason: true, user: { select: { fullName: true } } },
        orderBy: { at: 'asc' },
      },
    },
  });
  const sales = await tx.sale.aggregate({
    where: { shiftId, kind: 'INVOICE', status: 'COMPLETED' },
    _sum: { netTotal: true },
    _count: true,
  });
  const voids = await tx.sale.count({ where: { shiftId, kind: 'INVOICE', status: 'VOID' } });
  const refunds = await tx.saleReturn.aggregate({
    where: { shiftId },
    _sum: { refundTotal: true },
    _count: true,
  });
  const cashIn = shift.cashMovements
    .filter((m) => m.kind === 'IN')
    .reduce((s, m) => s.plus(D(m.amount)), D(0));
  const cashOut = shift.cashMovements
    .filter((m) => m.kind === 'OUT')
    .reduce((s, m) => s.plus(D(m.amount)), D(0));
  const cashSales = D(sales._sum.netTotal ?? 0);
  const cashRefunds = D(refunds._sum.refundTotal ?? 0);
  const expected = money(
    D(shift.openingFloat).plus(cashSales).minus(cashRefunds).plus(cashIn).minus(cashOut),
  );
  return {
    id: shift.id,
    no: shift.no,
    status: shift.status,
    counter: { id: shift.counter.id, code: shift.counter.code, name: shift.counter.name },
    businessDate: dateOnly(shift.businessDate)!,
    openedBy: shift.openedBy.fullName,
    openedAt: shift.openedAt,
    closedBy: shift.closedBy?.fullName ?? null,
    closedAt: shift.closedAt,
    openingFloat: shift.openingFloat.toFixed(2),
    billCount: sales._count,
    voidCount: voids,
    returnCount: refunds._count,
    cashSales: money(cashSales).toFixed(2),
    cashRefunds: money(cashRefunds).toFixed(2),
    cashIn: money(cashIn).toFixed(2),
    cashOut: money(cashOut).toFixed(2),
    expectedCash: expected.toFixed(2),
    countedCash: shift.countedCash?.toFixed(2) ?? null,
    difference: shift.difference?.toFixed(2) ?? null,
    denominations: (shift.denominations as Record<string, number> | null) ?? {},
    movements: shift.cashMovements.map((m) => ({
      id: m.id,
      at: m.at,
      kind: m.kind,
      amount: m.amount.toFixed(2),
      reason: m.reason.name,
      note: m.note,
      by: m.user.fullName,
    })),
  };
}

export async function currentShift(tx: Tx, ctx: RequestContext) {
  const counter = requireCounter(ctx);
  const shift = await tx.shift.findFirst({
    where: { counterId: counter.id, status: 'OPEN' },
    orderBy: { openedAt: 'desc' },
  });
  return shift ? shiftSummary(tx, shift.id) : null;
}

/**
 * Days close by themselves: a day left open closes when its counter starts the next day. Nobody
 * finishes a day by hand (the shop asked for no Finish day button), and nothing prints; the
 * report can be printed any time from Day end. The shop uses no cash drawer, so there is no
 * opening float or cash count.
 */
export async function autoCloseShift(tx: Tx, shiftId: string, userId: string) {
  const shift = await tx.shift.findUniqueOrThrow({ where: { id: shiftId } });
  const summary = await shiftSummary(tx, shift.id);
  await tx.shift.update({
    where: { id: shift.id },
    data: {
      status: 'CLOSED',
      cashSales: summary.cashSales,
      cashRefunds: summary.cashRefunds,
      cashIn: summary.cashIn,
      cashOut: summary.cashOut,
      expectedCash: summary.expectedCash,
      closedById: userId,
      closedAt: new Date(),
      note: 'Closed automatically when the next day started.',
    },
  });
  await audit(
    tx,
    { userId },
    {
      action: 'shift.auto_close',
      entity: 'shift',
      entityId: shift.id,
      after: { no: shift.no, sales: summary.cashSales, refunds: summary.cashRefunds },
    },
  );
}
