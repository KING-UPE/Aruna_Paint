import {
  D,
  Decimal,
  DomainError,
  allocateFifo,
  computeChange,
  holdInputSchema,
  money,
  saleInputSchema,
  saleTotals,
  shopDate,
  voidSaleSchema,
  type SaleLineInput,
  type Settings,
} from '@aruna/shared';
import type { Prisma, Sale } from '@prisma/client';

import type { Tx } from '../../db';
import { audit } from '../../core/audit';
import type { RequestContext } from '../../core/context';
import { actorOf } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { moveStock } from '../../core/stock';
import { requireApproval } from '../../auth/approvals';
import { dateOnly, parseDateOnly } from '../../lib/json';
import { priceLines, type PricedLine, type QuotedPrice } from './pricing';

export function requireCounter(ctx: RequestContext) {
  if (!ctx.counter) {
    throw new DomainError(
      'INVALID_STATE',
      'Billing runs on a counter PC. Log in at a counter.',
      undefined,
      { needCounter: true },
    );
  }
  return ctx.counter;
}

/** Bills attach to today's open day for the counter (opening float first). */
export async function openShiftFor(tx: Tx, counterId: string, required: boolean) {
  const shift = await tx.shift.findFirst({
    where: { counterId, status: 'OPEN' },
    orderBy: { openedAt: 'desc' },
  });
  if (!shift) {
    if (!required) return null;
    throw new DomainError(
      'INVALID_STATE',
      'Start the day first: enter the opening cash float.',
      undefined,
      { needShift: true },
    );
  }
  if (dateOnly(shift.businessDate) !== shopDate()) {
    throw new DomainError(
      'INVALID_STATE',
      'Finish the last day end before billing today.',
      undefined,
      {
        needDayEnd: true,
        shiftId: shift.id,
      },
    );
  }
  return shift;
}

function roundNet(net: Decimal, step: string): Decimal {
  if (step === '0.01') return net;
  const s = D(step);
  return net.dividedBy(s).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(s);
}

export interface SaleBuild {
  priced: PricedLine[];
  totals: ReturnType<typeof saleTotals>;
  roundingAdjustment: Decimal;
  netTotal: Decimal;
  costTotal: Decimal;
}

export function buildTotals(priced: PricedLine[], settings: Settings): SaleBuild {
  const totals = saleTotals(
    priced.map((p) => ({ qty: p.qty, unitPrice: p.unitPrice, discountPerUnit: p.discountPerUnit })),
  );
  const netTotal = roundNet(totals.netTotal, settings.billing.netTotalRounding);
  const costTotal = money(
    priced.reduce((s, p) => s.plus(money(D(p.unitCost).times(D(p.qty)))), D(0)),
  );
  return {
    priced,
    totals,
    roundingAdjustment: money(netTotal.minus(totals.netTotal)),
    netTotal,
    costTotal,
  };
}

function lineCreate(
  p: PricedLine,
  lineNo: number,
  priceApproverId: string | null,
): Prisma.SaleLineCreateWithoutSaleInput {
  const { priceChanged, productId, subProductId, ...rest } = p;
  return {
    ...rest,
    lineNo,
    product: { connect: { id: productId } },
    subProduct: { connect: { id: subProductId } },
    ...(priceChanged && priceApproverId
      ? { priceApprover: { connect: { id: priceApproverId } } }
      : {}),
  };
}

async function takeStock(
  tx: Tx,
  ctx: RequestContext,
  sale: Sale & {
    lines: {
      id: string;
      lineNo: number;
      subProductId: string;
      qty: Prisma.Decimal;
      unitCost: Prisma.Decimal;
      code: string;
      isLoose: boolean;
    }[];
  },
) {
  for (const line of sale.lines) {
    try {
      await moveStock(tx, {
        subProductId: line.subProductId,
        locationId: sale.locationId,
        qty: D(line.qty).negated(),
        type: 'SALE',
        unitCost: line.unitCost,
        docId: sale.id,
        docNo: sale.no ?? '',
        lineId: line.id,
        userId: ctx.user.id,
        label: line.isLoose ? `${line.code} (liters)` : line.code,
      });
    } catch (err) {
      if (err instanceof DomainError) {
        throw new DomainError(err.code, err.message, `lines.${line.lineNo - 1}.qty`, err.details);
      }
      throw err;
    }
  }
}

/**
 * F10: pay in cash and finish the bill, or issue a quotation (F4). Stock is checked again here,
 * inside one transaction with row locks, so two counters can't sell the last can twice.
 */
export async function completeSale(
  tx: Tx,
  ctx: RequestContext,
  settings: Settings,
  pinSecret: string,
  raw: unknown,
  extra: { convertedFromId?: string; quoted?: (QuotedPrice | null)[] } = {},
) {
  const input = saleInputSchema.parse(raw);
  const counter = requireCounter(ctx);
  const isInvoice = input.kind === 'INVOICE';
  const shift = await openShiftFor(tx, counter.id, isInvoice);
  const priced = await priceLines(
    tx,
    input.lines as SaleLineInput[],
    input.wholesale,
    extra.quoted,
  );
  let priceApproverId: string | null = null;
  if (priced.some((p) => p.priceChanged)) {
    // Changing a mix paint price at the counter needs an Admin PIN.
    priceApproverId = (
      await requireApproval(tx, ctx, 'MIX_PRICE_CHANGE', input.approval, pinSecret)
    ).approverId;
  }
  const build = buildTotals(priced, settings);
  const cash = isInvoice ? computeChange(build.netTotal, input.cashGiven ?? null) : null;

  const location = await tx.location.findUniqueOrThrow({ where: { id: counter.locationId } });
  const docType = isInvoice ? 'INVOICE' : 'QUOTATION';
  const no = await nextNumber(
    tx,
    docType,
    { counterCode: counter.code, locationCode: location.code },
    async (n) =>
      Boolean(
        await tx.sale.findFirst({ where: { kind: input.kind, no: n }, select: { id: true } }),
      ),
  );
  const now = new Date();
  const validUntil = isInvoice
    ? null
    : parseDateOnly(
        shopDate(new Date(now.getTime() + settings.billing.quotationValidityDays * 86_400_000)),
      );

  const sale = await tx.sale.create({
    data: {
      no,
      kind: input.kind,
      status: 'COMPLETED',
      location: { connect: { id: counter.locationId } },
      counter: { connect: { id: counter.id } },
      ...(shift ? { shift: { connect: { id: shift.id } } } : {}),
      cashier: { connect: { id: ctx.user.id } },
      wholesale: input.wholesale,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      validUntil,
      itemCount: build.totals.netItems,
      totalQty: build.totals.netQty.toFixed(3),
      gross: build.totals.gross.toFixed(2),
      discount: build.totals.discount.toFixed(2),
      roundingAdjustment: build.roundingAdjustment.toFixed(2),
      netTotal: build.netTotal.toFixed(2),
      cashGiven: cash?.cashGiven.toFixed(2) ?? null,
      change: cash?.change.toFixed(2) ?? null,
      costTotal: build.costTotal.toFixed(2),
      completedAt: now,
      ...(extra.convertedFromId
        ? { convertedFrom: { connect: { id: extra.convertedFromId } } }
        : {}),
      lines: { create: priced.map((p, i) => lineCreate(p, i + 1, priceApproverId)) },
    },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });
  if (isInvoice) await takeStock(tx, ctx, sale);

  if (input.heldSaleId) {
    await tx.sale.deleteMany({ where: { id: input.heldSaleId, status: 'HELD' } });
  }
  await audit(tx, actorOf(ctx), {
    action: isInvoice ? 'sale.complete' : 'quotation.create',
    entity: 'sale',
    entityId: sale.id,
    approverId: priceApproverId && priceApproverId !== ctx.user.id ? priceApproverId : null,
    after: {
      no,
      netTotal: sale.netTotal,
      lines: sale.lines.length,
      wholesale: input.wholesale,
      ...(priceApproverId
        ? {
            mixPriceChanged: priced.filter((p) => p.priceChanged).map((p) => [p.code, p.unitPrice]),
          }
        : {}),
    },
  });
  return {
    id: sale.id,
    no,
    kind: sale.kind,
    netTotal: sale.netTotal.toFixed(2),
    cashGiven: sale.cashGiven?.toFixed(2) ?? null,
    change: sale.change?.toFixed(2) ?? null,
    validUntil: dateOnly(sale.validUntil),
    subProductIds: [...new Set(sale.lines.map((l) => l.subProductId))],
  };
}

/** F7 parks the current bill. Held bills don't reserve stock; it's checked again at payment. */
export async function holdSale(tx: Tx, ctx: RequestContext, settings: Settings, raw: unknown) {
  const input = holdInputSchema.parse(raw);
  const counter = requireCounter(ctx);
  const priced = await priceLines(tx, input.lines as SaleLineInput[], input.wholesale);
  const build = buildTotals(priced, settings);
  if (input.heldSaleId)
    await tx.sale.deleteMany({ where: { id: input.heldSaleId, status: 'HELD' } });
  const sale = await tx.sale.create({
    data: {
      kind: input.kind,
      status: 'HELD',
      location: { connect: { id: counter.locationId } },
      counter: { connect: { id: counter.id } },
      cashier: { connect: { id: ctx.user.id } },
      wholesale: input.wholesale,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      itemCount: build.totals.netItems,
      totalQty: build.totals.netQty.toFixed(3),
      gross: build.totals.gross.toFixed(2),
      discount: build.totals.discount.toFixed(2),
      netTotal: build.netTotal.toFixed(2),
      costTotal: build.costTotal.toFixed(2),
      lines: {
        create: priced.map((p, i) => lineCreate({ ...p, priceChanged: false }, i + 1, null)),
      },
    },
  });
  return { id: sale.id };
}

/** F8 lists held bills to resume, newest first. */
export async function listHeld(tx: Tx, locationId: string) {
  const held = await tx.sale.findMany({
    where: { status: 'HELD', locationId },
    include: {
      cashier: { select: { fullName: true } },
      counter: { select: { code: true } },
      lines: { orderBy: { lineNo: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return held.map((s) => ({
    id: s.id,
    kind: s.kind,
    heldAt: s.createdAt,
    cashier: s.cashier.fullName,
    counter: s.counter.code,
    wholesale: s.wholesale,
    customerName: s.customerName,
    customerPhone: s.customerPhone,
    itemCount: s.itemCount,
    netTotal: s.netTotal.toFixed(2),
    /** Ready to load back into the billing screen. */
    lines: s.lines.map((l) =>
      l.isLoose
        ? {
            kind: 'LOOSE' as const,
            productId: l.productId,
            liters: l.qty.toFixed(3),
            pricePerLiter: null,
          }
        : {
            kind: 'BATCH' as const,
            productId: l.productId,
            subProductId: l.subProductId,
            qty: l.qty.toFixed(3),
            discount: s.wholesale
              ? null
              : { type: 'AMOUNT' as const, value: l.discountPerUnit.toFixed(2) },
          },
    ),
  }));
}

export async function discardHeld(tx: Tx, ctx: RequestContext, id: string) {
  const held = await tx.sale.findUnique({ where: { id } });
  if (!held || held.status !== 'HELD') throw new DomainError('NOT_FOUND', 'Held bill not found.');
  await tx.sale.delete({ where: { id } });
  await audit(tx, actorOf(ctx), {
    action: 'sale.discard_held',
    entity: 'sale',
    entityId: id,
    before: { netTotal: held.netTotal },
  });
}

/**
 * Void: same day only, with a reason and an Admin PIN. The bill stays visible stamped VOID and
 * its stock comes back.
 */
export async function voidSale(
  tx: Tx,
  ctx: RequestContext,
  pinSecret: string,
  id: string,
  raw: unknown,
) {
  const input = voidSaleSchema.parse(raw);
  const sale = await tx.sale.findUnique({
    where: { id },
    include: { lines: true, returns: { select: { id: true } } },
  });
  if (!sale || sale.status === 'HELD') throw new DomainError('NOT_FOUND', 'Bill not found.');
  if (sale.kind !== 'INVOICE')
    throw new DomainError('INVALID_STATE', 'Only invoices can be voided.');
  if (sale.status === 'VOID') throw new DomainError('INVALID_STATE', 'This bill is already void.');
  if (!sale.completedAt || shopDate(sale.completedAt) !== shopDate()) {
    throw new DomainError(
      'INVALID_STATE',
      'Bills can be voided on the same day only. Use a return instead.',
    );
  }
  if (sale.returns.length)
    throw new DomainError('INVALID_STATE', 'This bill has returns and cannot be voided.');
  const reason = await tx.reason.findUnique({ where: { id: input.reasonId } });
  if (!reason || !reason.active || !reason.appliesTo.includes('VOID')) {
    throw new DomainError('VALIDATION', 'Pick a void reason.', 'reasonId');
  }
  const { approverId } = await requireApproval(tx, ctx, 'VOID_BILL', input.approval, pinSecret);
  for (const line of sale.lines) {
    await moveStock(tx, {
      subProductId: line.subProductId,
      locationId: sale.locationId,
      qty: line.qty,
      type: 'SALE_VOID',
      unitCost: line.unitCost,
      docId: sale.id,
      docNo: sale.no ?? '',
      lineId: line.id,
      userId: ctx.user.id,
      note: reason.name,
    });
  }
  await tx.sale.update({
    where: { id },
    data: {
      status: 'VOID',
      voidedAt: new Date(),
      voidedById: ctx.user.id,
      voidApproverId: approverId,
      voidReasonId: reason.id,
      voidNote: input.note,
    },
  });
  await audit(tx, actorOf(ctx), {
    action: 'sale.void',
    entity: 'sale',
    entityId: id,
    approverId: approverId !== ctx.user.id ? approverId : null,
    note: `${reason.name}${input.note ? `: ${input.note}` : ''}`,
    before: { status: 'COMPLETED', netTotal: sale.netTotal },
    after: { status: 'VOID' },
  });
  return { subProductIds: [...new Set(sale.lines.map((l) => l.subProductId))] };
}

/** Every later copy prints "REPRINT #2 · date and time · user" and is logged. */
export async function recordReprint(tx: Tx, ctx: RequestContext, id: string) {
  const sale = await tx.sale.findUnique({ where: { id } });
  if (!sale || sale.status === 'HELD') throw new DomainError('NOT_FOUND', 'Bill not found.');
  const copies = await tx.reprint.count({ where: { saleId: id } });
  const reprint = await tx.reprint.create({
    data: { saleId: id, copyNo: copies + 2, userId: ctx.user.id },
  });
  await audit(tx, actorOf(ctx), {
    action: 'sale.reprint',
    entity: 'sale',
    entityId: id,
    after: { copyNo: reprint.copyNo },
  });
  return reprint;
}

/**
 * From bill history, C converts a quotation to an invoice. Stock and prices are checked again;
 * quoted prices hold until the validity date (a lower current price wins).
 */
export async function convertQuotation(
  tx: Tx,
  ctx: RequestContext,
  settings: Settings,
  pinSecret: string,
  id: string,
  raw: { cashGiven?: string | null; print?: boolean },
) {
  const counter = requireCounter(ctx);
  const q = await tx.sale.findUnique({
    where: { id },
    include: { lines: { orderBy: { lineNo: 'asc' } }, convertedTo: true },
  });
  if (!q || q.kind !== 'QUOTATION' || q.status !== 'COMPLETED')
    throw new DomainError('NOT_FOUND', 'Quotation not found.');
  if (q.convertedTo)
    throw new DomainError('INVALID_STATE', `Already converted to ${q.convertedTo.no}.`);
  const valid = q.validUntil !== null && dateOnly(q.validUntil)! >= shopDate();
  const lines: SaleLineInput[] = [];
  const quoted: (QuotedPrice | null)[] = [];
  for (const [i, l] of q.lines.entries()) {
    if (l.isLoose) {
      lines.push({
        kind: 'LOOSE',
        productId: l.productId,
        liters: l.qty.toFixed(3),
        pricePerLiter: null,
      });
      quoted.push(null);
      continue;
    }
    const batches = await tx.$queryRaw<
      {
        id: string;
        code: string;
        available: string;
        first_received_at: Date | null;
        r_price: string;
        w_price: string;
        sales_price: string;
        sales_discount: string;
      }[]
    >`
      SELECT sp.id, sp.code, b.qty::text AS available, sp.first_received_at,
             sp.r_price::text, sp.w_price::text, sp.sales_price::text, sp.sales_discount::text
        FROM sub_products sp JOIN stock_balances b ON b.sub_product_id = sp.id
       WHERE sp.product_id = ${l.productId}::uuid AND b.location_id = ${counter.locationId}::uuid AND b.qty > 0 AND sp.active`;
    const allocation = (() => {
      try {
        return allocateFifo(
          batches.map((b) => ({
            id: b.id,
            code: b.code,
            available: b.available,
            firstReceivedAt: b.first_received_at ?? new Date(0),
            rPrice: b.r_price,
            wPrice: b.w_price,
            salesPrice: b.sales_price,
          })),
          l.qty,
          l.subProductId,
        );
      } catch (err) {
        if (err instanceof DomainError)
          throw new DomainError(
            err.code,
            `${l.name}: ${err.message}`,
            `lines.${i}.qty`,
            err.details,
          );
        throw err;
      }
    })();
    for (const a of allocation) {
      lines.push({ kind: 'BATCH', subProductId: a.batchId, qty: a.qty.toFixed(3), discount: null });
      quoted.push(
        valid && !q.wholesale
          ? { unitPrice: l.unitPrice.toFixed(2), discountPerUnit: l.discountPerUnit.toFixed(2) }
          : null,
      );
    }
  }
  return completeSale(
    tx,
    ctx,
    settings,
    pinSecret,
    {
      kind: 'INVOICE',
      wholesale: q.wholesale,
      customerName: q.customerName,
      customerPhone: q.customerPhone,
      lines,
      cashGiven: raw.cashGiven ?? null,
      print: raw.print ?? true,
    },
    { convertedFromId: q.id, quoted },
  );
}
