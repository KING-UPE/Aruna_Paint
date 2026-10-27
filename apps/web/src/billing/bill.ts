import {
  D,
  DomainError,
  allocateFifo,
  lineAmounts,
  money,
  parseDiscountText,
  priceLine,
  saleTotals,
  type SaleLineInput,
} from '@aruna/shared';
import type { Batch, BillingItem } from '@/lib/types';

export type BillMode = 'INVOICE' | 'QUOTATION';

export interface BillLine {
  key: string;
  kind: 'BATCH' | 'LOOSE';
  item: BillingItem;
  batch: Batch | null;
  /** Units, or liters for loose paint. */
  qty: string;
  /** What the cashier typed in the discount box; empty keeps the batch default. */
  discountText: string;
  /** Loose paint: a price per liter changed at the counter (needs an Admin PIN). */
  pricePerLiter: string | null;
}

export interface PricedBillLine extends BillLine {
  description: string;
  unitPrice: string;
  discountPerUnit: string;
  amount: string;
  error: string | null;
}

let seq = 0;
export const newKey = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * The same rules the server applies, so the screen shows exactly what will be charged.
 * The cost floor is not sent to the screen; `maxDiscount` already keeps lines above it.
 */
export function batchPricing(b: Batch) {
  const max = D(b.maxDiscount);
  return {
    rPrice: b.rPrice,
    wPrice: b.wPrice,
    cost: money(D(b.rPrice).minus(max)),
    purchaseDiscount: max,
    salesDiscount: Decimal_min(D(b.salesDiscount), max),
  };
}

function Decimal_min(a: ReturnType<typeof D>, b: ReturnType<typeof D>) {
  return a.lessThan(b) ? a : b;
}

/** "No discount" on the bill: every line at its full price, whatever each line had. */
const NO_DISCOUNT = parseDiscountText('0%');

export function priceBillLine(
  line: BillLine,
  wholesale: boolean,
  noDiscount = false,
): PricedBillLine {
  try {
    if (line.kind === 'LOOSE') {
      const mix = line.item.mix!;
      const base = wholesale ? mix.wPricePerLiter : mix.pricePerLiter;
      const price = line.pricePerLiter ?? base;
      const a = lineAmounts(price, 0, line.qty);
      return {
        ...line,
        description: `${mix.name}, loose`,
        unitPrice: money(price).toFixed(2),
        discountPerUnit: '0.00',
        amount: a.amount.toFixed(2),
        error: null,
      };
    }
    const batch = line.batch!;
    const typed = noDiscount
      ? NO_DISCOUNT
      : line.discountText.trim()
        ? parseDiscountText(line.discountText)
        : null;
    if (!noDiscount && line.discountText.trim() && !typed)
      throw new DomainError('VALIDATION', 'Type 50 for rupees or 5% for percent.');
    const p = priceLine(batchPricing(batch), { wholesale, discount: typed });
    const a = lineAmounts(p.unitPrice, p.discountPerUnit, line.qty);
    return {
      ...line,
      description: line.item.name,
      unitPrice: p.unitPrice.toFixed(2),
      discountPerUnit: p.discountPerUnit.toFixed(2),
      amount: a.amount.toFixed(2),
      error: null,
    };
  } catch (err) {
    return {
      ...line,
      description:
        line.kind === 'LOOSE' ? `${line.item.mix?.name ?? line.item.name}, loose` : line.item.name,
      unitPrice: '0.00',
      discountPerUnit: '0.00',
      amount: '0.00',
      error: err instanceof Error ? err.message : 'Check this line.',
    };
  }
}

export function billTotals(lines: PricedBillLine[]) {
  return saleTotals(
    lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, discountPerUnit: l.discountPerUnit })),
  );
}

/**
 * Asking for more than a batch holds fills the rest from the next batch, each line at its own
 * price: "2 from 10001-01 at Rs 2,300 and 3 from 10001-02 at Rs 2,450". Qty already on the bill
 * is taken off what each batch has.
 */
export function splitIntoBatchLines(
  item: BillingItem,
  qty: string,
  startBatchId: string | null,
  discountText: string,
  existing: BillLine[],
): BillLine[] {
  const used = new Map<string, ReturnType<typeof D>>();
  for (const l of existing)
    if (l.kind === 'BATCH' && l.batch)
      used.set(l.batch.id, (used.get(l.batch.id) ?? D(0)).plus(D(l.qty)));
  const batches = item.batches.map((b) => ({
    ...b,
    available: D(b.available)
      .minus(used.get(b.id) ?? D(0))
      .toFixed(3),
  }));
  const alloc = allocateFifo(batches, qty, startBatchId ?? undefined);
  return alloc.map((a) => ({
    key: newKey(),
    kind: 'BATCH' as const,
    item,
    batch: item.batches.find((b) => b.id === a.batchId)!,
    qty: a.qty.toFixed(3),
    discountText,
    pricePerLiter: null,
  }));
}

/** Liters of mix paint already on this bill for the same item. */
export function litersOnBill(lines: BillLine[], mixSubProductId: string): ReturnType<typeof D> {
  return lines
    .filter((l) => l.kind === 'LOOSE' && l.item.mix?.subProductId === mixSubProductId)
    .reduce((s, l) => s.plus(D(l.qty)), D(0));
}

export function toSaleInput(lines: BillLine[], noDiscount = false): SaleLineInput[] {
  return lines.map((l) =>
    l.kind === 'LOOSE'
      ? {
          kind: 'LOOSE',
          productId: l.item.productId,
          liters: l.qty,
          pricePerLiter: l.pricePerLiter,
        }
      : {
          kind: 'BATCH',
          subProductId: l.batch!.id,
          qty: l.qty,
          discount: noDiscount
            ? NO_DISCOUNT
            : l.discountText.trim()
              ? parseDiscountText(l.discountText)
              : null,
        },
  );
}
