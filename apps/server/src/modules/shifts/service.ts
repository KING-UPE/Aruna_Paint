import { D, money } from '@aruna/shared';
import type { Tx } from '../../db';
import { audit } from '../../core/audit';
import { dateOnly } from '../../lib/json';

/**
 * One day of the shop: its bills and refunds, and each user's share (every PC is the same, so
 * sales are told apart by who made them). Days from before counters were removed keep their
 * counter code.
 */
export async function shiftSummary(tx: Tx, shiftId: string) {
  const shift = await tx.shift.findUniqueOrThrow({
    where: { id: shiftId },
    include: {
      counter: { select: { code: true } },
      openedBy: { select: { fullName: true } },
      closedBy: { select: { fullName: true } },
    },
  });
  const salesWhere = { shiftId, kind: 'INVOICE' as const, status: 'COMPLETED' as const };
  const [sales, voids, refunds, salesByUser, refundsByUser] = await Promise.all([
    tx.sale.aggregate({ where: salesWhere, _sum: { netTotal: true }, _count: true }),
    tx.sale.count({ where: { shiftId, kind: 'INVOICE', status: 'VOID' } }),
    tx.saleReturn.aggregate({ where: { shiftId }, _sum: { refundTotal: true }, _count: true }),
    tx.sale.groupBy({
      by: ['cashierId'],
      where: salesWhere,
      _sum: { netTotal: true },
      _count: true,
    }),
    tx.saleReturn.groupBy({
      by: ['cashierId'],
      where: { shiftId },
      _sum: { refundTotal: true },
      _count: true,
    }),
  ]);
  const ids = [...new Set([...salesByUser, ...refundsByUser].map((r) => r.cashierId))];
  const users = await tx.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullName: true },
  });
  const name = new Map(users.map((u) => [u.id, u.fullName]));
  const byUser = ids
    .map((id) => {
      const s = salesByUser.find((r) => r.cashierId === id);
      const r = refundsByUser.find((x) => x.cashierId === id);
      const sales = D(s?._sum.netTotal ?? 0);
      const refunds = D(r?._sum.refundTotal ?? 0);
      return {
        userId: id,
        name: name.get(id) ?? '',
        bills: s?._count ?? 0,
        sales: money(sales).toFixed(2),
        returns: r?._count ?? 0,
        refunds: money(refunds).toFixed(2),
        net: money(sales.minus(refunds)).toFixed(2),
      };
    })
    .sort((a, b) => Number(b.net) - Number(a.net));
  const cashSales = D(sales._sum.netTotal ?? 0);
  const cashRefunds = D(refunds._sum.refundTotal ?? 0);
  return {
    id: shift.id,
    no: shift.no,
    status: shift.status,
    counter: shift.counter?.code ?? null,
    businessDate: dateOnly(shift.businessDate)!,
    openedBy: shift.openedBy.fullName,
    openedAt: shift.openedAt,
    closedBy: shift.closedBy?.fullName ?? null,
    closedAt: shift.closedAt,
    billCount: sales._count,
    voidCount: voids,
    returnCount: refunds._count,
    cashSales: money(cashSales).toFixed(2),
    cashRefunds: money(cashRefunds).toFixed(2),
    net: money(cashSales.minus(cashRefunds)).toFixed(2),
    byUser,
  };
}

/** The shop's day that is open now, if a bill has started it. */
export async function currentShift(tx: Tx) {
  const shift = await tx.shift.findFirst({
    where: { counterId: null, status: 'OPEN' },
    orderBy: { openedAt: 'desc' },
  });
  return shift ? shiftSummary(tx, shift.id) : null;
}

/**
 * Days close by themselves: a day left open closes when the shop starts the next day. Nobody
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
