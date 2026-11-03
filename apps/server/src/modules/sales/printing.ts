import type { FastifyInstance } from 'fastify';
import type { PrintResult } from '../../printing/service';
import { renderReturnReceipt, renderSaleReceipt } from '../../printing/receipts';
import { dateOnly } from '../../lib/json';

/**
 * Prints after the bill is saved when the cashier answers Yes to "Print receipt?". The shop uses
 * no cash drawer, so nothing opens one. A printer problem never undoes the sale; the cashier can
 * reprint from history.
 */
export async function printSale(
  app: FastifyInstance,
  saleId: string,
  opts: {
    print: boolean;
    counterId: string | null;
    reprint?: { copyNo: number; at: Date; user: string };
  },
): Promise<PrintResult> {
  const { db, settings, printer } = app.deps;
  const sale = await db.sale.findUniqueOrThrow({
    where: { id: saleId },
    include: { lines: { orderBy: { lineNo: 'asc' } }, cashier: { select: { fullName: true } } },
  });
  const counterId = opts.counterId ?? sale.counterId;
  if (!opts.print) return { printed: false };
  const all = await settings.getAll();
  const buf = renderSaleReceipt(
    {
      kind: sale.kind,
      no: sale.no ?? '',
      status: sale.status,
      wholesale: sale.wholesale,
      completedAt: sale.completedAt ?? sale.createdAt,
      cashier: sale.cashier.fullName,
      customerName: sale.customerName,
      validUntil: dateOnly(sale.validUntil),
      lines: sale.lines.map((l) => ({
        name: l.printName || l.name,
        isLoose: l.isLoose,
        qty: l.qty.toFixed(3),
        unitPrice: l.unitPrice.toFixed(2),
        rPrice: l.rPrice.toFixed(2),
        discountPerUnit: l.discountPerUnit.toFixed(2),
        amount: l.amount.toFixed(2),
      })),
      itemCount: sale.itemCount,
      totalQty: sale.totalQty.toFixed(3),
      gross: sale.gross.toFixed(2),
      discount: sale.discount.toFixed(2),
      roundingAdjustment: sale.roundingAdjustment.toFixed(2),
      netTotal: sale.netTotal.toFixed(2),
      cashGiven: sale.cashGiven?.toFixed(2) ?? null,
      change: sale.change?.toFixed(2) ?? null,
    },
    all,
    {
      reprint: opts.reprint,
      hour12: all.billing.timeFormat === '12h',
    },
  );
  const result = await printer.print(
    counterId,
    buf,
    `${sale.no}${opts.reprint ? `-copy${opts.reprint.copyNo}` : ''}`,
  );
  if (result.printed)
    await db.sale.update({ where: { id: saleId }, data: { printCount: { increment: 1 } } });
  return result;
}

export async function printReturn(
  app: FastifyInstance,
  counterId: string | null,
  receipt: Parameters<typeof renderReturnReceipt>[0],
): Promise<PrintResult> {
  const all = await app.deps.settings.getAll();
  return app.deps.printer.print(
    counterId,
    renderReturnReceipt(receipt, all, all.billing.timeFormat === '12h'),
    receipt.no,
  );
}
