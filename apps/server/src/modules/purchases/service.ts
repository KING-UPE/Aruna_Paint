import {
  D,
  DomainError,
  codeKey,
  computePurchaseLine,
  computePurchaseTotals,
  formatDate,
  money,
  purchaseInputSchema,
  purchasePostSchema,
  qty,
  shopDate,
  subProductCode,
  subProductMatches,
  supplierTotalMatches,
  validatePurchaseLine,
  type PurchaseLineResult,
} from '@aruna/shared';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Tx } from '../../db';
import { audit } from '../../core/audit';
import type { ActorRef } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { moveStock, totalQty } from '../../core/stock';
import { dateOnly, parseDateOnly } from '../../lib/json';
import { refreshSearchText } from '../products/service';
import { addLedgerEntry, createSupplierPayment } from '../suppliers/service';

type Actor = ActorRef & { userId: string };
type PurchaseInputParsed = z.output<typeof purchaseInputSchema>;

interface ComputedLine {
  input: PurchaseInputParsed['lines'][number];
  result: PurchaseLineResult;
  piecesPerBox: number;
}

/** Recomputes every line on the server; prices typed on the screen are never trusted as-is. */
async function computeLines(tx: Tx, input: PurchaseInputParsed): Promise<ComputedLine[]> {
  const products = await tx.product.findMany({
    where: { id: { in: input.lines.map((l) => l.productId) } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  return input.lines.map((l, i) => {
    const p = byId.get(l.productId);
    if (!p) throw new DomainError('VALIDATION', 'Unknown item.', `lines.${i}.productId`);
    if (p.type === 'MIX')
      throw new DomainError(
        'VALIDATION',
        'Mix paint is filled from cans, not bought.',
        `lines.${i}.productId`,
      );
    const result = computePurchaseLine({ ...l, piecesPerBox: p.piecesPerBox });
    return { input: l, result, piecesPerBox: p.piecesPerBox };
  });
}

function lineData(c: ComputedLine, lineNo: number) {
  const { input: l, result: r } = c;
  return {
    lineNo,
    productId: l.productId,
    value: money(l.value).toFixed(2),
    qty: qty(l.qty).toFixed(3),
    free: qty(l.free).toFixed(3),
    piecesPerBox: c.piecesPerBox,
    discountType: l.discount.type,
    discountValue: money(l.discount.value).toFixed(2),
    discountPerUnit: r.purchaseDiscount.toFixed(2),
    cost: r.cost.toFixed(2),
    amount: r.amount.toFixed(2),
    actualPrice: r.actualPrice.toFixed(2),
    rPrice: r.rPrice.toFixed(2),
    wPrice: r.wPrice.toFixed(2),
    salesDiscountType: l.salesDiscount.type,
    salesDiscountValue: money(l.salesDiscount.value).toFixed(2),
    salesDiscount: r.salesDiscount.toFixed(2),
    salesPrice: r.salesPrice.toFixed(2),
    margin: r.margin.toFixed(2),
    stockQty: r.stockQty.toFixed(3),
    expiryDate: l.expiryDate ? parseDateOnly(l.expiryDate) : null,
  };
}

async function headerData(
  tx: Tx,
  input: PurchaseInputParsed,
  lines: ComputedLine[],
  defaultLocationId: string,
) {
  const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) throw new DomainError('VALIDATION', 'Unknown supplier.', 'supplierId');
  if (!supplier.active)
    throw new DomainError('VALIDATION', 'This supplier is inactive.', 'supplierId');
  if (input.salesRepId) {
    const rep = await tx.supplierRep.findUnique({ where: { id: input.salesRepId } });
    // Only the chosen supplier's reps.
    if (!rep || rep.supplierId !== supplier.id)
      throw new DomainError('VALIDATION', "Pick one of this supplier's reps.", 'salesRepId');
  }
  const locationId = input.locationId ?? defaultLocationId;
  const location = await tx.location.findUnique({ where: { id: locationId } });
  if (!location || !location.active || location.kind === 'DAMAGED') {
    throw new DomainError('VALIDATION', 'Pick a shop or warehouse.', 'locationId');
  }
  if (input.date > shopDate())
    throw new DomainError('VALIDATION', 'The date cannot be in the future.', 'date');
  const totals = computePurchaseTotals({
    lineAmounts: lines.map((l) => l.result.amount),
    invoiceDiscount: input.invoiceDiscount,
    otherCharges: input.otherCharges,
  });
  return {
    supplierId: supplier.id,
    supplierInvoiceNo: input.supplierInvoiceNo,
    date: parseDateOnly(input.date),
    ref: input.ref,
    locationId,
    salesRepId: input.salesRepId ?? null,
    subtotal: totals.subtotal.toFixed(2),
    invoiceDiscount: totals.invoiceDiscount.toFixed(2),
    otherCharges: totals.otherCharges.toFixed(2),
    netTotal: totals.netTotal.toFixed(2),
    supplierInvoiceTotal: money(input.supplierInvoiceTotal).toFixed(2),
  };
}

/** Save as draft: no stock change. */
export async function createPurchase(
  tx: Tx,
  actor: Actor,
  defaultLocationId: string,
  raw: unknown,
) {
  const input = purchaseInputSchema.parse(raw);
  const lines = await computeLines(tx, input);
  const header = await headerData(tx, input, lines, defaultLocationId);
  const no = await nextNumber(tx, 'PURCHASE', { date: header.date });
  const purchase = await tx.purchase.create({
    data: {
      ...header,
      no,
      status: 'DRAFT',
      createdById: actor.userId,
      lines: { create: lines.map((l, i) => lineData(l, i + 1)) },
    },
  });
  await audit(tx, actor, {
    action: 'purchase.create',
    entity: 'purchase',
    entityId: purchase.id,
    after: { no, netTotal: header.netTotal },
  });
  return purchase.id;
}

export async function updatePurchase(
  tx: Tx,
  actor: Actor,
  id: string,
  defaultLocationId: string,
  raw: unknown,
) {
  const existing = await tx.purchase.findUnique({ where: { id } });
  if (!existing) throw new DomainError('NOT_FOUND', 'Purchase not found.');
  if (existing.status !== 'DRAFT')
    throw new DomainError('INVALID_STATE', 'Only a draft can be edited.');
  const input = purchaseInputSchema.parse(raw);
  const lines = await computeLines(tx, input);
  const header = await headerData(tx, input, lines, defaultLocationId);
  await tx.purchaseLine.deleteMany({ where: { purchaseId: id } });
  await tx.purchase.update({
    where: { id },
    data: { ...header, lines: { create: lines.map((l, i) => lineData(l, i + 1)) } },
  });
  await audit(tx, actor, {
    action: 'purchase.update',
    entity: 'purchase',
    entityId: id,
    after: { netTotal: header.netTotal },
  });
}

/** Discarding a draft deletes it; posted purchases are reversed, never deleted. */
export async function deleteDraft(tx: Tx, actor: Actor, id: string) {
  const p = await tx.purchase.findUnique({ where: { id } });
  if (!p) throw new DomainError('NOT_FOUND', 'Purchase not found.');
  if (p.status !== 'DRAFT' || p.postedAt)
    throw new DomainError('INVALID_STATE', 'Only a draft that was never posted can be discarded.');
  await tx.purchase.delete({ where: { id } });
  await audit(tx, actor, {
    action: 'purchase.discard',
    entity: 'purchase',
    entityId: id,
    before: { no: p.no },
  });
}

/** The same supplier with the same invoice no raises a warning. */
export async function duplicateInvoice(
  tx: Tx,
  supplierId: string,
  invoiceNo: string,
  exceptId?: string,
) {
  if (!invoiceNo.trim()) return null;
  return tx.purchase.findFirst({
    where: {
      supplierId,
      supplierInvoiceNo: { equals: invoiceNo.trim(), mode: 'insensitive' },
      status: { not: 'REVERSED' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true, no: true, date: true },
  });
}

/**
 * A posted line looks for a sub-product of its main product with the same supplier, cost,
 * R-price, W-price, sales price and expiry date. If one matches (even at zero stock) the stock
 * goes there; if anything differs the next code is created (10001-05).
 */
async function findOrCreateSubProduct(
  tx: Tx,
  actor: Actor,
  productId: string,
  supplierId: string,
  line: Prisma.PurchaseLineGetPayload<object>,
) {
  const product = await tx.product.findUniqueOrThrow({ where: { id: productId } });
  const expiry = dateOnly(line.expiryDate);
  const candidates = await tx.subProduct.findMany({
    where: { productId },
    orderBy: { seq: 'asc' },
  });
  const key = {
    supplierId,
    cost: line.cost,
    rPrice: line.rPrice,
    wPrice: line.wPrice,
    salesPrice: line.salesPrice,
    expiryDate: expiry,
  };
  const match = candidates.find((sp) =>
    subProductMatches(key, {
      supplierId: sp.supplierId,
      cost: sp.costPrice,
      rPrice: sp.rPrice,
      wPrice: sp.wPrice,
      salesPrice: sp.salesPrice,
      expiryDate: dateOnly(sp.expiryDate),
    }),
  );
  if (match) {
    // Free items can change what each unit really cost; keep the weighted average.
    const onHand = D(await totalQty(tx, match.id));
    const add = D(line.stockQty);
    const actual = onHand.greaterThan(0)
      ? money(
          onHand
            .times(D(match.actualPrice))
            .plus(add.times(D(line.actualPrice)))
            .dividedBy(onHand.plus(add)),
        )
      : D(line.actualPrice);
    await tx.subProduct.update({
      where: { id: match.id },
      data: {
        active: true,
        actualPrice: actual.toFixed(2),
        marketValue: money(D(line.value).dividedBy(line.piecesPerBox)).toFixed(2),
        purchaseDiscount: line.discountPerUnit,
        salesDiscount: line.salesDiscount,
        firstReceivedAt: onHand.isZero() ? new Date() : (match.firstReceivedAt ?? new Date()),
      },
    });
    return { subProduct: match, created: false };
  }
  const seq = (candidates.at(-1)?.seq ?? 0) + 1;
  const code = subProductCode(product.code, seq);
  const created = await tx.subProduct.create({
    data: {
      productId,
      seq,
      code,
      codeKey: codeKey(code),
      name: product.name,
      description: product.description,
      supplierId,
      marketValue: money(D(line.value).dividedBy(line.piecesPerBox)).toFixed(2),
      purchaseDiscount: line.discountPerUnit,
      costPrice: line.cost,
      actualPrice: line.actualPrice,
      rPrice: line.rPrice,
      wPrice: line.wPrice,
      salesDiscount: line.salesDiscount,
      salesPrice: line.salesPrice,
      expiryDate: line.expiryDate,
      firstReceivedAt: new Date(),
    },
  });
  const previous = candidates.at(-1);
  await tx.priceHistory.create({
    data: {
      subProductId: created.id,
      changedById: actor.userId,
      source: 'PURCHASE',
      oldRPrice: previous?.rPrice ?? null,
      newRPrice: line.rPrice,
      oldWPrice: previous?.wPrice ?? null,
      newWPrice: line.wPrice,
      oldSalesDiscount: previous?.salesDiscount ?? null,
      newSalesDiscount: line.salesDiscount,
      oldSalesPrice: previous?.salesPrice ?? null,
      newSalesPrice: line.salesPrice,
      note: `New sub-product from purchase`,
    },
  });
  return { subProduct: created, created: true };
}

/** Post: stock and supplier balance update. */
export async function postPurchase(tx: Tx, actor: Actor, id: string, raw: unknown) {
  const opts = purchasePostSchema.parse(raw ?? {});
  const purchase = await tx.purchase.findUnique({
    where: { id },
    include: { lines: { orderBy: { lineNo: 'asc' } }, supplier: true },
  });
  if (!purchase) throw new DomainError('NOT_FOUND', 'Purchase not found.');
  if (purchase.status !== 'DRAFT')
    throw new DomainError('INVALID_STATE', 'This purchase is already posted.');
  if (!purchase.lines.length)
    throw new DomainError('VALIDATION', 'Add at least one line.', 'lines');

  // The supplier's invoice total must match the net total within Rs 1; this catches typing mistakes.
  if (!supplierTotalMatches(purchase.netTotal, purchase.supplierInvoiceTotal)) {
    throw new DomainError(
      'VALIDATION',
      `The net total Rs ${purchase.netTotal.toFixed(2)} does not match the supplier's invoice total Rs ${purchase.supplierInvoiceTotal.toFixed(2)}.`,
      'supplierInvoiceTotal',
    );
  }
  const dup = await duplicateInvoice(tx, purchase.supplierId, purchase.supplierInvoiceNo, id);
  if (dup && !opts.confirmDuplicateInvoice) {
    throw new DomainError(
      'CONFLICT',
      `Invoice ${purchase.supplierInvoiceNo} from this supplier is already on ${dup.no}.`,
      'supplierInvoiceNo',
      {
        warning: true,
        confirm: 'confirmDuplicateInvoice',
        existing: dup.no,
      },
    );
  }

  const warnings: string[] = [];
  const products = await tx.product.findMany({
    where: { id: { in: purchase.lines.map((l) => l.productId) } },
  });
  const productById = new Map(products.map((p) => [p.id, p]));
  for (const [i, line] of purchase.lines.entries()) {
    const product = productById.get(line.productId)!;
    if (!product.active)
      throw new DomainError('VALIDATION', `${product.name} is inactive.`, `lines.${i}.productId`);
    const issues = validatePurchaseLine({
      value: line.value,
      qty: line.qty,
      free: line.free,
      piecesPerBox: line.piecesPerBox,
      discount: { type: line.discountType, value: line.discountValue.toString() },
      rPrice: line.rPrice,
      wPrice: line.wPrice,
      salesPrice: line.salesPrice,
    });
    if (issues.length)
      throw new DomainError(issues[0]!.code, issues[0]!.message, `lines.${i}.${issues[0]!.field}`);
    if (product.trackExpiry && !line.expiryDate) {
      throw new DomainError(
        'VALIDATION',
        'This item tracks expiry; enter the expiry date.',
        `lines.${i}.expiryDate`,
      );
    }
    if (line.expiryDate) {
      if (line.expiryDate <= purchase.date) {
        throw new DomainError(
          'VALIDATION',
          'The expiry date must be after the purchase date.',
          `lines.${i}.expiryDate`,
        );
      }
      if (line.expiryDate.getTime() - Date.now() < 90 * 86_400_000) {
        warnings.push(`${product.name} expires on ${formatDate(line.expiryDate)}, within 90 days.`);
      }
    }
  }

  const touched = new Set<string>();
  for (const line of purchase.lines) {
    const { subProduct } = await findOrCreateSubProduct(
      tx,
      actor,
      line.productId,
      purchase.supplierId,
      line,
    );
    await tx.purchaseLine.update({ where: { id: line.id }, data: { subProductId: subProduct.id } });
    await moveStock(tx, {
      subProductId: subProduct.id,
      locationId: purchase.locationId,
      qty: line.stockQty,
      type: 'PURCHASE',
      unitCost: line.actualPrice,
      docId: purchase.id,
      docNo: purchase.no,
      lineId: line.id,
      userId: actor.userId,
    });
    touched.add(line.productId);
  }
  for (const productId of touched) await refreshSearchText(tx, productId);

  await tx.purchase.update({
    where: { id },
    data: { status: 'POSTED', postedById: actor.userId, postedAt: new Date() },
  });
  await addLedgerEntry(tx, {
    supplierId: purchase.supplierId,
    date: purchase.date,
    entryType: 'PURCHASE',
    docId: purchase.id,
    docNo: purchase.no,
    credit: purchase.netTotal.toFixed(2),
    note: purchase.supplierInvoiceNo ? `Invoice ${purchase.supplierInvoiceNo}` : '',
  });

  let payment = null;
  if (D(opts.paidNow).greaterThan(0)) {
    payment = await createSupplierPayment(
      tx,
      actor,
      purchase.locationId,
      {
        supplierId: purchase.supplierId,
        date: dateOnly(purchase.date)!,
        method: opts.paymentMethod,
        amount: opts.paidNow,
        reference: purchase.no,
        note: 'Paid with the GRN',
        cheque: opts.cheque,
        confirmAdvance: true,
      },
      { purchaseId: purchase.id },
    );
  }
  await audit(tx, actor, {
    action: 'purchase.post',
    entity: 'purchase',
    entityId: purchase.id,
    after: { no: purchase.no, netTotal: purchase.netTotal, paidNow: opts.paidNow },
  });
  return {
    id: purchase.id,
    no: purchase.no,
    warnings,
    payment,
    subProductIds: await postedSubIds(tx, id),
  };
}

async function postedSubIds(tx: Tx, purchaseId: string): Promise<string[]> {
  const lines = await tx.purchaseLine.findMany({
    where: { purchaseId },
    select: { subProductId: true },
  });
  return [...new Set(lines.map((l) => l.subProductId).filter((x): x is string => Boolean(x)))];
}

/** Whether any stock from this purchase has moved since it was posted. */
async function stockMovedSincePosting(
  tx: Tx,
  purchaseId: string,
  postedAt: Date,
  subIds: string[],
): Promise<boolean> {
  if (!subIds.length) return false;
  const rows = await tx.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM stock_movements
     WHERE sub_product_id = ANY(${subIds}::uuid[]) AND at >= ${postedAt} AND doc_id <> ${purchaseId}::uuid`;
  return (rows[0]?.n ?? 0) > 0;
}

async function takeStockBack(
  tx: Tx,
  actor: Actor,
  purchase: Prisma.PurchaseGetPayload<{ include: { lines: true } }>,
  note: string,
) {
  for (const line of purchase.lines) {
    if (!line.subProductId) continue;
    await moveStock(tx, {
      subProductId: line.subProductId,
      locationId: purchase.locationId,
      qty: D(line.stockQty).negated(),
      type: 'PURCHASE_REVERSAL',
      unitCost: line.actualPrice,
      docId: purchase.id,
      docNo: purchase.no,
      lineId: line.id,
      userId: actor.userId,
      note,
    });
  }
  await addLedgerEntry(tx, {
    supplierId: purchase.supplierId,
    date: parseDateOnly(shopDate()),
    entryType: 'REVERSAL',
    docId: purchase.id,
    docNo: purchase.no,
    debit: purchase.netTotal.toFixed(2),
    note,
  });
}

/**
 * A posted purchase can be edited only while none of its stock has moved: it goes back to a
 * draft (stock and supplier balance taken back) and keeps its GRN number.
 */
export async function reopenPurchase(tx: Tx, actor: Actor, id: string) {
  const purchase = await tx.purchase.findUnique({ where: { id }, include: { lines: true } });
  if (!purchase) throw new DomainError('NOT_FOUND', 'Purchase not found.');
  if (purchase.status !== 'POSTED' || !purchase.postedAt)
    throw new DomainError('INVALID_STATE', 'Only a posted purchase can be reopened.');
  const subIds = purchase.lines.map((l) => l.subProductId).filter((x): x is string => Boolean(x));
  if (await stockMovedSincePosting(tx, id, purchase.postedAt, subIds)) {
    throw new DomainError(
      'INVALID_STATE',
      'Stock from this purchase has moved. An Admin must reverse it and re-enter it.',
    );
  }
  if (D(purchase.returnedAmount).greaterThan(0))
    throw new DomainError('INVALID_STATE', 'This purchase has returns. An Admin must reverse it.');
  await takeStockBack(tx, actor, purchase, 'Reopened for editing');
  await tx.purchaseLine.updateMany({ where: { purchaseId: id }, data: { subProductId: null } });
  await tx.purchase.update({ where: { id }, data: { status: 'DRAFT', postedById: null } });
  await audit(tx, actor, {
    action: 'purchase.reopen',
    entity: 'purchase',
    entityId: id,
    before: { status: 'POSTED' },
    after: { status: 'DRAFT' },
  });
}

/** Admin reversal: the stock still on hand comes out and the supplier balance goes back. */
export async function reversePurchase(
  tx: Tx,
  actor: Actor,
  id: string,
  reason: string,
  approverId: string,
) {
  const purchase = await tx.purchase.findUnique({ where: { id }, include: { lines: true } });
  if (!purchase) throw new DomainError('NOT_FOUND', 'Purchase not found.');
  if (purchase.status !== 'POSTED')
    throw new DomainError('INVALID_STATE', 'Only a posted purchase can be reversed.');
  if (D(purchase.returnedAmount).greaterThan(0))
    throw new DomainError('INVALID_STATE', 'This purchase has returns and cannot be reversed.');
  await takeStockBack(tx, actor, purchase, `Reversed: ${reason}`);
  await tx.purchase.update({
    where: { id },
    data: {
      status: 'REVERSED',
      reversedById: approverId,
      reversedAt: new Date(),
      reverseReason: reason,
    },
  });
  await audit(tx, actor, {
    action: 'purchase.reverse',
    entity: 'purchase',
    entityId: id,
    approverId,
    note: reason,
    before: { status: 'POSTED' },
    after: { status: 'REVERSED' },
  });
  return postedSubIds(tx, id);
}

const COST_FIELDS = [
  'value',
  'discountValue',
  'discountPerUnit',
  'cost',
  'amount',
  'actualPrice',
  'margin',
] as const;

export async function getPurchase(tx: Tx, id: string, canSeeCost: boolean) {
  const p = await tx.purchase.findUnique({
    where: { id },
    include: {
      supplier: { select: { id: true, code: true, name: true } },
      location: { select: { id: true, name: true } },
      salesRep: { select: { id: true, name: true } },
      createdBy: { select: { fullName: true } },
      postedBy: { select: { fullName: true } },
      reversedBy: { select: { fullName: true } },
      lines: {
        orderBy: { lineNo: 'asc' },
        include: {
          product: {
            select: {
              id: true,
              code: true,
              name: true,
              piecesPerBox: true,
              unit: { select: { name: true } },
            },
          },
          subProduct: { select: { id: true, code: true } },
        },
      },
    },
  });
  if (!p) throw new DomainError('NOT_FOUND', 'Purchase not found.');
  const lines = p.lines.map((l) => {
    const out: Record<string, unknown> = {
      id: l.id,
      lineNo: l.lineNo,
      product: l.product,
      subProduct: l.subProduct,
      qty: l.qty.toFixed(3),
      free: l.free.toFixed(3),
      piecesPerBox: l.piecesPerBox,
      stockQty: l.stockQty.toFixed(3),
      discountType: l.discountType,
      rPrice: l.rPrice.toFixed(2),
      wPrice: l.wPrice.toFixed(2),
      salesDiscountType: l.salesDiscountType,
      salesDiscountValue: l.salesDiscountValue.toFixed(2),
      salesDiscount: l.salesDiscount.toFixed(2),
      salesPrice: l.salesPrice.toFixed(2),
      expiryDate: dateOnly(l.expiryDate),
    };
    if (canSeeCost)
      for (const f of COST_FIELDS) out[f] = (l[f] as { toFixed(n: number): string }).toFixed(2);
    return out;
  });
  return {
    id: p.id,
    no: p.no,
    status: p.status,
    supplier: p.supplier,
    supplierInvoiceNo: p.supplierInvoiceNo,
    date: dateOnly(p.date),
    ref: p.ref,
    location: p.location,
    salesRep: p.salesRep,
    netTotal: p.netTotal.toFixed(2),
    supplierInvoiceTotal: p.supplierInvoiceTotal.toFixed(2),
    paidAmount: p.paidAmount.toFixed(2),
    returnedAmount: p.returnedAmount.toFixed(2),
    due: D(p.netTotal).minus(D(p.paidAmount)).minus(D(p.returnedAmount)).toFixed(2),
    ...(canSeeCost
      ? {
          subtotal: p.subtotal.toFixed(2),
          invoiceDiscount: p.invoiceDiscount.toFixed(2),
          otherCharges: p.otherCharges.toFixed(2),
        }
      : {}),
    createdBy: p.createdBy.fullName,
    postedBy: p.postedBy?.fullName ?? null,
    postedAt: p.postedAt,
    reversedBy: p.reversedBy?.fullName ?? null,
    reversedAt: p.reversedAt,
    reverseReason: p.reverseReason,
    lines,
  };
}

export async function listPurchases(
  tx: Tx,
  f: {
    supplierId?: string;
    status?: 'DRAFT' | 'POSTED' | 'REVERSED';
    from?: string;
    to?: string;
    q?: string;
    page: number;
    pageSize: number;
  },
) {
  const where: Prisma.PurchaseWhereInput = {
    ...(f.supplierId ? { supplierId: f.supplierId } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.from || f.to
      ? {
          date: {
            ...(f.from ? { gte: parseDateOnly(f.from) } : {}),
            ...(f.to ? { lte: parseDateOnly(f.to) } : {}),
          },
        }
      : {}),
    ...(f.q
      ? {
          OR: [
            { no: { contains: f.q, mode: 'insensitive' } },
            { supplierInvoiceNo: { contains: f.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    tx.purchase.findMany({
      where,
      include: {
        supplier: { select: { code: true, name: true } },
        _count: { select: { lines: true } },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      skip: (f.page - 1) * f.pageSize,
      take: f.pageSize,
    }),
    tx.purchase.count({ where }),
  ]);
  return {
    items: items.map((p) => ({
      id: p.id,
      no: p.no,
      status: p.status,
      date: dateOnly(p.date),
      supplier: p.supplier,
      supplierInvoiceNo: p.supplierInvoiceNo,
      lines: p._count.lines,
      netTotal: p.netTotal.toFixed(2),
      due: D(p.netTotal).minus(D(p.paidAmount)).minus(D(p.returnedAmount)).toFixed(2),
    })),
    total,
    page: f.page,
    pageSize: f.pageSize,
  };
}
