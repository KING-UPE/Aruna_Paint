import {
  D,
  DomainError,
  cashMovementSchema,
  closeShiftSchema,
  money,
  openShiftSchema,
  shopDate,
} from '@aruna/shared';
import type { Prisma } from '@prisma/client';
import type { Tx } from '../../db';
import { audit } from '../../core/audit';
import { actorOf, type ActorRef, type RequestContext } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { dateOnly, parseDateOnly } from '../../lib/json';
import { requireCounter } from '../sales/service';

/** What the drawer should hold: float + cash sales − refunds + cash in − cash out. */
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

/** Start of day: the opening cash float. One day per counter per date. */
export async function openShift(tx: Tx, ctx: RequestContext, raw: unknown) {
  const input = openShiftSchema.parse(raw);
  const counter = requireCounter(ctx);
  const open = await tx.shift.findFirst({ where: { counterId: counter.id, status: 'OPEN' } });
  if (open) throw new DomainError('INVALID_STATE', 'The day is already open on this counter.');
  const today = shopDate();
  if (
    await tx.shift.findUnique({
      where: {
        counterId_businessDate: { counterId: counter.id, businessDate: parseDateOnly(today) },
      },
    })
  ) {
    throw new DomainError(
      'INVALID_STATE',
      'The day end for today is already done on this counter.',
    );
  }
  const no = await nextNumber(tx, 'DAY_END', { counterCode: counter.code });
  const shift = await tx.shift.create({
    data: {
      no,
      counterId: counter.id,
      locationId: counter.locationId,
      businessDate: parseDateOnly(today),
      openingFloat: input.openingFloat ?? '0.00',
      openedById: ctx.user.id,
    },
  });
  await audit(tx, actorOf(ctx), {
    action: 'shift.open',
    entity: 'shift',
    entityId: shift.id,
    after: { no, openingFloat: input.openingFloat ?? '0.00' },
  });
  return shiftSummary(tx, shift.id);
}

export async function currentShift(tx: Tx, ctx: RequestContext) {
  const counter = requireCounter(ctx);
  const shift = await tx.shift.findFirst({
    where: { counterId: counter.id, status: 'OPEN' },
    orderBy: { openedAt: 'desc' },
  });
  return shift ? shiftSummary(tx, shift.id) : null;
}

/** Cash in and out during the day with a reason, such as small daily expenses. */
export async function addCashMovement(tx: Tx, ctx: RequestContext, raw: unknown) {
  const input = cashMovementSchema.parse(raw);
  const counter = requireCounter(ctx);
  const shift = await tx.shift.findFirst({ where: { counterId: counter.id, status: 'OPEN' } });
  if (!shift)
    throw new DomainError('INVALID_STATE', 'Start the day first.', undefined, { needShift: true });
  const reason = await tx.reason.findUnique({ where: { id: input.reasonId } });
  const use = input.kind === 'IN' ? 'CASH_IN' : 'CASH_OUT';
  if (!reason || !reason.active || !reason.appliesTo.includes(use)) {
    throw new DomainError(
      'VALIDATION',
      `Pick a cash ${input.kind === 'IN' ? 'in' : 'out'} reason.`,
      'reasonId',
    );
  }
  if (input.kind === 'OUT') {
    const summary = await shiftSummary(tx, shift.id);
    if (D(input.amount).greaterThan(D(summary.expectedCash))) {
      throw new DomainError(
        'VALIDATION',
        `The drawer should only hold Rs ${summary.expectedCash}.`,
        'amount',
      );
    }
  }
  const m = await tx.cashMovement.create({
    data: {
      shiftId: shift.id,
      kind: input.kind,
      amount: input.amount,
      reasonId: reason.id,
      note: input.note,
      userId: ctx.user.id,
    },
  });
  await audit(tx, actorOf(ctx), {
    action: `cash.${input.kind.toLowerCase()}`,
    entity: 'shift',
    entityId: shift.id,
    after: { amount: input.amount, reason: reason.name, note: input.note },
  });
  return { id: m.id, summary: await shiftSummary(tx, shift.id) };
}

/**
 * Day end shows the expected cash. The cashier counts notes and coins, and any difference is
 * recorded. The report prints, then a backup and a sync run.
 */
export async function closeShift(tx: Tx, ctx: RequestContext, raw: unknown) {
  const input = closeShiftSchema.parse(raw);
  const counter = requireCounter(ctx);
  const shift = await tx.shift.findFirst({ where: { counterId: counter.id, status: 'OPEN' } });
  if (!shift) throw new DomainError('INVALID_STATE', 'There is no open day on this counter.');
  const held = await tx.sale.count({ where: { counterId: counter.id, status: 'HELD' } });
  await finishShift(tx, actorOf(ctx), shift.id, input, false);
  return { summary: await shiftSummary(tx, shift.id), heldBills: held };
}

/**
 * A day left open closes by itself when its counter starts the next day: nobody has to remember
 * the day end, and nothing prints (the report can be printed later from Day end).
 */
export async function autoCloseShift(tx: Tx, shiftId: string, userId: string) {
  await finishShift(
    tx,
    { userId },
    shiftId,
    { denominations: {}, note: 'Closed automatically when the next day started.' },
    true,
  );
}

async function finishShift(
  tx: Tx,
  actor: ActorRef,
  shiftId: string,
  input: { denominations: Record<string, number | undefined>; note: string },
  auto: boolean,
) {
  const shift = await tx.shift.findUniqueOrThrow({ where: { id: shiftId } });
  const summary = await shiftSummary(tx, shift.id);
  const hasDenominations = input.denominations && Object.keys(input.denominations).length > 0;
  const counted = hasDenominations
    ? money(
        Object.entries(input.denominations).reduce(
          (s, [note, count]) => s.plus(D(note).times(count ?? 0)),
          D(0),
        ),
      )
    : D(summary.expectedCash);
  const difference = hasDenominations ? money(counted.minus(D(summary.expectedCash))) : D(0);
  await tx.shift.update({
    where: { id: shift.id },
    data: {
      status: 'CLOSED',
      cashSales: summary.cashSales,
      cashRefunds: summary.cashRefunds,
      cashIn: summary.cashIn,
      cashOut: summary.cashOut,
      expectedCash: summary.expectedCash,
      countedCash: counted.toFixed(2),
      difference: difference.toFixed(2),
      denominations: input.denominations as Prisma.InputJsonValue,
      closedById: actor.userId,
      closedAt: new Date(),
      note: input.note,
    },
  });
  await audit(tx, actor, {
    action: auto ? 'shift.auto_close' : 'shift.close',
    entity: 'shift',
    entityId: shift.id,
    after: {
      no: shift.no,
      expected: summary.expectedCash,
      counted: counted.toFixed(2),
      difference: difference.toFixed(2),
    },
  });
}
