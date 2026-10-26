import {
  D,
  DomainError,
  allocatePaymentOldestFirst,
  codeKey,
  money,
  nameKey,
  shopDate,
  supplierInputSchema,
  supplierPaymentSchema,
  type Decimal,
} from '@aruna/shared';
import { Prisma, type SupplierEntryType } from '@prisma/client';
import type { Tx } from '../../db';
import { audit, diff } from '../../core/audit';
import type { ActorRef } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { dateOnly, parseDateOnly } from '../../lib/json';

/** Balance = Opening + Purchases − Payments − Purchase returns ± Adjustments (from the ledger). */
export async function supplierBalances(tx: Tx, ids?: string[]): Promise<Map<string, Decimal>> {
  const rows = await tx.$queryRaw<{ id: string; balance: string }[]>`
    SELECT s.id, (s.opening_balance + COALESCE(SUM(l.credit - l.debit), 0))::text AS balance
      FROM suppliers s
      LEFT JOIN supplier_ledger l ON l.supplier_id = s.id
     WHERE ${ids ? Prisma.sql`s.id = ANY(${ids}::uuid[])` : Prisma.sql`TRUE`}
     GROUP BY s.id`;
  return new Map(rows.map((r) => [r.id, D(r.balance)]));
}

export async function supplierBalance(tx: Tx, id: string): Promise<Decimal> {
  return (await supplierBalances(tx, [id])).get(id) ?? D(0);
}

export async function addLedgerEntry(
  tx: Tx,
  e: {
    supplierId: string;
    date: Date;
    entryType: SupplierEntryType;
    docId?: string | null;
    docNo?: string;
    debit?: Decimal | string;
    credit?: Decimal | string;
    note?: string;
  },
) {
  await tx.supplierLedgerEntry.create({
    data: {
      supplierId: e.supplierId,
      date: e.date,
      entryType: e.entryType,
      docId: e.docId ?? null,
      docNo: e.docNo ?? '',
      debit: money(e.debit ?? 0).toFixed(2),
      credit: money(e.credit ?? 0).toFixed(2),
      note: e.note ?? '',
    },
  });
}

function supplierOut(s: Prisma.SupplierGetPayload<{ include: { reps: true } }>, balance: Decimal) {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    phones: s.phones,
    address: s.address,
    description: s.description,
    email: s.email,
    creditDays: s.creditDays,
    openingBalance: s.openingBalance.toFixed(2),
    active: s.active,
    balance: balance.toFixed(2),
    reps: s.reps.map((r) => ({ id: r.id, name: r.name, phone: r.phone, active: r.active })),
    createdAt: s.createdAt,
  };
}

export async function listSuppliers(
  tx: Tx,
  opts: { q?: string; includeInactive?: boolean; limit?: number },
) {
  const q = opts.q?.trim();
  const where: Prisma.SupplierWhereInput = {
    ...(opts.includeInactive ? {} : { active: true }),
    ...(q
      ? {
          OR: [
            { codeKey: { contains: codeKey(q) } },
            { nameKey: { contains: nameKey(q) } },
            { phones: { has: q.replace(/[\s-]/g, '') } },
          ],
        }
      : {}),
  };
  const suppliers = await tx.supplier.findMany({
    where,
    include: { reps: { orderBy: { name: 'asc' } } },
    orderBy: [{ code: 'asc' }],
    take: opts.limit ?? 500,
  });
  const balances = await supplierBalances(
    tx,
    suppliers.map((s) => s.id),
  );
  return suppliers.map((s) => supplierOut(s, balances.get(s.id) ?? D(0)));
}

export async function getSupplier(tx: Tx, id: string) {
  const s = await tx.supplier.findUnique({
    where: { id },
    include: { reps: { orderBy: { name: 'asc' } } },
  });
  if (!s) throw new DomainError('NOT_FOUND', 'Supplier not found.');
  return supplierOut(s, await supplierBalance(tx, id));
}

async function syncReps(
  tx: Tx,
  supplierId: string,
  reps: { id?: string; name: string; phone: string; active: boolean }[],
) {
  const existing = await tx.supplierRep.findMany({ where: { supplierId } });
  const keep = new Set(reps.filter((r) => r.id).map((r) => r.id));
  // Reps used on purchases are deactivated, never deleted.
  for (const e of existing) {
    if (!keep.has(e.id) && e.active)
      await tx.supplierRep.update({ where: { id: e.id }, data: { active: false } });
  }
  for (const r of reps) {
    if (r.id) {
      if (!existing.some((e) => e.id === r.id))
        throw new DomainError('VALIDATION', 'Unknown sales rep.', 'reps');
      await tx.supplierRep.update({
        where: { id: r.id },
        data: { name: r.name, phone: r.phone, active: r.active },
      });
    } else {
      await tx.supplierRep.create({
        data: { supplierId, name: r.name, phone: r.phone, active: r.active },
      });
    }
  }
}

async function similarName(tx: Tx, name: string, exceptId?: string) {
  return tx.supplier.findFirst({
    where: { nameKey: nameKey(name), ...(exceptId ? { id: { not: exceptId } } : {}) },
  });
}

export async function createSupplier(tx: Tx, actor: ActorRef, raw: unknown) {
  const input = supplierInputSchema.parse(raw);
  const similar = await similarName(tx, input.name);
  if (similar && !input.confirmSimilarName) {
    throw new DomainError('DUPLICATE', 'A supplier with this name already exists.', 'name', {
      warning: true,
      similar: { id: similar.id, code: similar.code, name: similar.name },
    });
  }
  let code: string;
  if (input.code) {
    code = input.code;
    if (await tx.supplier.findUnique({ where: { codeKey: codeKey(code) } })) {
      throw new DomainError('DUPLICATE', 'That supplier code is taken.', 'code');
    }
  } else {
    code = await nextNumber(tx, 'SUPPLIER', {}, async (no) =>
      Boolean(await tx.supplier.findUnique({ where: { codeKey: codeKey(no) } })),
    );
  }
  const s = await tx.supplier.create({
    data: {
      code,
      codeKey: codeKey(code),
      name: input.name,
      nameKey: nameKey(input.name),
      phones: input.phones,
      address: input.address,
      description: input.description,
      email: input.email,
      creditDays: input.creditDays,
      openingBalance: input.openingBalance,
      active: input.active,
    },
  });
  await syncReps(tx, s.id, input.reps);
  const out = await getSupplier(tx, s.id);
  await audit(tx, actor, {
    action: 'supplier.create',
    entity: 'supplier',
    entityId: s.id,
    after: out,
  });
  return out;
}

export async function updateSupplier(tx: Tx, actor: ActorRef, id: string, raw: unknown) {
  const input = supplierInputSchema.parse(raw);
  const before = await tx.supplier.findUnique({ where: { id } });
  if (!before) throw new DomainError('NOT_FOUND', 'Supplier not found.');
  const similar = await similarName(tx, input.name, id);
  if (similar && !input.confirmSimilarName && nameKey(input.name) !== before.nameKey) {
    throw new DomainError('DUPLICATE', 'A supplier with this name already exists.', 'name', {
      warning: true,
      similar: { id: similar.id, code: similar.code, name: similar.name },
    });
  }
  const code = input.code ?? before.code;
  if (
    codeKey(code) !== before.codeKey &&
    (await tx.supplier.findUnique({ where: { codeKey: codeKey(code) } }))
  ) {
    throw new DomainError('DUPLICATE', 'That supplier code is taken.', 'code');
  }
  if (!D(input.openingBalance).equals(D(before.openingBalance))) {
    if ((await tx.supplierLedgerEntry.count({ where: { supplierId: id } })) > 0) {
      throw new DomainError(
        'INVALID_STATE',
        'The opening balance cannot change once the supplier has entries. Use an adjustment.',
        'openingBalance',
      );
    }
  }
  const data = {
    code,
    codeKey: codeKey(code),
    name: input.name,
    nameKey: nameKey(input.name),
    phones: input.phones,
    address: input.address,
    description: input.description,
    email: input.email,
    creditDays: input.creditDays,
    openingBalance: input.openingBalance,
    active: input.active,
  };
  await tx.supplier.update({ where: { id }, data });
  await syncReps(tx, id, input.reps);
  const changes = diff(before as unknown as Record<string, unknown>, data);
  await audit(tx, actor, {
    action: 'supplier.update',
    entity: 'supplier',
    entityId: id,
    before: changes.before,
    after: changes.after,
  });
  return getSupplier(tx, id);
}

export async function deleteSupplier(tx: Tx, actor: ActorRef, id: string) {
  const s = await tx.supplier.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          purchases: true,
          payments: true,
          purchaseReturns: true,
          subProducts: true,
          ledger: true,
        },
      },
    },
  });
  if (!s) throw new DomainError('NOT_FOUND', 'Supplier not found.');

  if (
    s._count.purchases > 0 ||
    s._count.payments > 0 ||
    s._count.purchaseReturns > 0 ||
    s._count.subProducts > 0 ||
    s._count.ledger > 0
  ) {
    throw new DomainError(
      'IN_USE',
      'This supplier has purchase, payment, or product records and cannot be deleted. You can mark them inactive instead.',
    );
  }

  await tx.supplierRep.deleteMany({ where: { supplierId: id } });
  await tx.supplier.delete({ where: { id } });

  await audit(tx, actor, {
    action: 'supplier.delete',
    entity: 'supplier',
    entityId: id,
    before: { code: s.code, name: s.name },
  });

  return { ok: true };
}

/**
 * The supplier activity log: the opening balance on the start date, each entry with a running
 * balance, then the closing balance.
 */
export async function supplierLedger(
  tx: Tx,
  supplierId: string,
  opts: { from?: string; to?: string; types?: SupplierEntryType[] },
) {
  const supplier = await tx.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) throw new DomainError('NOT_FOUND', 'Supplier not found.');
  const from = opts.from ? parseDateOnly(opts.from) : null;
  const to = opts.to ? parseDateOnly(opts.to) : null;
  let opening = D(supplier.openingBalance);
  if (from) {
    const agg = await tx.supplierLedgerEntry.aggregate({
      where: { supplierId, date: { lt: from } },
      _sum: { credit: true, debit: true },
    });
    opening = opening.plus(D(agg._sum.credit ?? 0)).minus(D(agg._sum.debit ?? 0));
  }
  const entries = await tx.supplierLedgerEntry.findMany({
    where: { supplierId, date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  });
  let running = opening;
  const rows = [];
  for (const e of entries) {
    running = running.plus(D(e.credit)).minus(D(e.debit));
    if (opts.types?.length && !opts.types.includes(e.entryType)) continue;
    rows.push({
      id: e.id,
      date: dateOnly(e.date),
      type: e.entryType,
      docId: e.docId,
      docNo: e.docNo,
      debit: e.debit.toFixed(2),
      credit: e.credit.toFixed(2),
      balance: running.toFixed(2),
      note: e.note,
    });
  }
  return {
    supplier: { id: supplier.id, code: supplier.code, name: supplier.name },
    from: opts.from ?? null,
    to: opts.to ?? null,
    openingBalance: opening.toFixed(2),
    entries: rows,
    closingBalance: running.toFixed(2),
  };
}

/** Posted purchases that still have something to pay, oldest first. */
export async function openBills(tx: Tx, supplierId: string) {
  const rows = await tx.purchase.findMany({
    where: { supplierId, status: 'POSTED' },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  });
  return rows
    .map((p) => ({
      id: p.id,
      no: p.no,
      date: p.date,
      due: D(p.netTotal).minus(D(p.paidAmount)).minus(D(p.returnedAmount)),
    }))
    .filter((b) => b.due.greaterThan(0));
}

/**
 * Cash, cheque or bank transfer. A payment reduces the balance, oldest bills first; paying more
 * than the balance shows a warning and records an advance.
 */
export async function createSupplierPayment(
  tx: Tx,
  actor: ActorRef & { userId: string },
  locationId: string,
  raw: unknown,
  opts: { purchaseId?: string } = {},
) {
  const input = supplierPaymentSchema.parse(raw);
  const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) throw new DomainError('NOT_FOUND', 'Supplier not found.');
  const amount = D(input.amount);
  const balance = await supplierBalance(tx, supplier.id);
  const advance = money(Math.max(0, amount.minus(Math.max(0, balance.toNumber())).toNumber()));
  if (advance.greaterThan(0) && !input.confirmAdvance) {
    throw new DomainError(
      'CONFLICT',
      `This is Rs ${advance.toFixed(2)} more than the balance and will be kept as an advance.`,
      'amount',
      {
        warning: true,
        balance: balance.toFixed(2),
        advance: advance.toFixed(2),
      },
    );
  }

  const no = await nextNumber(tx, 'SUPPLIER_PAYMENT', { date: parseDateOnly(input.date) });
  const payment = await tx.supplierPayment.create({
    data: {
      no,
      supplierId: supplier.id,
      locationId,
      date: parseDateOnly(input.date),
      method: input.method,
      amount: amount.toFixed(2),
      advance: advance.toFixed(2),
      reference: input.reference,
      note: input.note,
      createdById: actor.userId,
    },
  });

  // Oldest bills first; money paid now on a GRN goes to that GRN before the others.
  const bills = await openBills(tx, supplier.id);
  const ordered = opts.purchaseId
    ? [
        ...bills.filter((b) => b.id === opts.purchaseId),
        ...bills.filter((b) => b.id !== opts.purchaseId),
      ].map((b, i) => ({
        ...b,
        date: new Date(i),
      }))
    : bills;
  const { allocations } = allocatePaymentOldestFirst(ordered, amount);
  for (const a of allocations) {
    await tx.paymentAllocation.create({
      data: { paymentId: payment.id, purchaseId: a.billId, amount: a.amount.toFixed(2) },
    });
    await tx.purchase.update({
      where: { id: a.billId },
      data: { paidAmount: { increment: a.amount.toFixed(2) } },
    });
  }
  if (input.method === 'CHEQUE' && input.cheque) {
    await tx.cheque.create({
      data: {
        paymentId: payment.id,
        number: input.cheque.number,
        bank: input.cheque.bank,
        chequeDate: parseDateOnly(input.cheque.chequeDate),
        amount: amount.toFixed(2),
      },
    });
  }
  await addLedgerEntry(tx, {
    supplierId: supplier.id,
    date: parseDateOnly(input.date),
    entryType: 'PAYMENT',
    docId: payment.id,
    docNo: no,
    debit: amount,
    note:
      input.method === 'CHEQUE'
        ? `Cheque ${input.cheque?.number ?? ''}`
        : input.method === 'BANK_TRANSFER'
          ? 'Bank transfer'
          : 'Cash',
  });
  await audit(tx, actor, {
    action: 'supplier_payment.create',
    entity: 'supplier_payment',
    entityId: payment.id,
    after: {
      no,
      supplier: supplier.name,
      amount: amount.toFixed(2),
      method: input.method,
      advance: advance.toFixed(2),
    },
  });
  return {
    id: payment.id,
    no,
    amount: amount.toFixed(2),
    advance: advance.toFixed(2),
    allocations: allocations.map((a) => ({ purchaseId: a.billId, amount: a.amount.toFixed(2) })),
    balance: (await supplierBalance(tx, supplier.id)).toFixed(2),
  };
}

/** A cleared cheque is just marked; a bounced one puts the amount back on the supplier balance. */
export async function setChequeStatus(
  tx: Tx,
  actor: ActorRef,
  id: string,
  status: 'CLEARED' | 'BOUNCED' | 'CANCELLED',
) {
  const cheque = await tx.cheque.findUnique({
    where: { id },
    include: { payment: { include: { allocations: true } } },
  });
  if (!cheque) throw new DomainError('NOT_FOUND', 'Cheque not found.');
  if (cheque.status !== 'PENDING')
    throw new DomainError('INVALID_STATE', 'This cheque is already settled.');
  await tx.cheque.update({
    where: { id },
    data: { status, clearedAt: status === 'CLEARED' ? new Date() : null },
  });
  if (status !== 'CLEARED') {
    for (const a of cheque.payment.allocations) {
      await tx.purchase.update({
        where: { id: a.purchaseId },
        data: { paidAmount: { decrement: a.amount } },
      });
    }
    await addLedgerEntry(tx, {
      supplierId: cheque.payment.supplierId,
      date: parseDateOnly(shopDate()),
      entryType: 'REVERSAL',
      docId: cheque.paymentId,
      docNo: cheque.payment.no,
      credit: D(cheque.amount),
      note: `Cheque ${cheque.number} ${status.toLowerCase()}`,
    });
  }
  await audit(tx, actor, {
    action: `cheque.${status.toLowerCase()}`,
    entity: 'cheque',
    entityId: id,
    after: { status },
  });
}
