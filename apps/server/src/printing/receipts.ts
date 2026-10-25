import {
  D,
  formatDate,
  formatDateTime,
  formatMoney,
  formatQty,
  type Settings,
} from '@aruna/shared';
import { EscPos } from './escpos';

export interface ReceiptLine {
  name: string;
  isLoose: boolean;
  qty: string;
  unitPrice: string;
  rPrice: string;
  discountPerUnit: string;
  amount: string;
}

export interface ReceiptSale {
  kind: 'INVOICE' | 'QUOTATION';
  no: string;
  status: string;
  wholesale: boolean;
  completedAt: Date;
  cashier: string;
  customerName: string;
  validUntil: string | null;
  lines: ReceiptLine[];
  itemCount: number;
  totalQty: string;
  gross: string;
  discount: string;
  roundingAdjustment: string;
  netTotal: string;
  cashGiven: string | null;
  change: string | null;
}

function header(p: EscPos, settings: Settings) {
  p.align('center').bold(true).line(settings.shop.shopName.toUpperCase()).bold(false);
  if (settings.shop.address) p.line(settings.shop.address);
  if (settings.shop.phone) p.line(settings.shop.phone);
  if (settings.receipt.headerEn) p.line(settings.receipt.headerEn);
  p.align('left').rule();
}

/** You saved Rs X: what the customer paid below the R-price. */
export function savedAmount(lines: ReceiptLine[]): string {
  const saved = lines.reduce(
    (s, l) => s.plus(D(l.rPrice).minus(D(l.unitPrice)).plus(D(l.discountPerUnit)).times(D(l.qty))),
    D(0),
  );
  return saved.toDecimalPlaces(2).toFixed(2);
}

/**
 * 80 mm receipt: shop name, address and phone, bill no, date and time, cashier, customer name if
 * entered, the lines, totals, cash given, change, "You saved Rs X" and the return policy footer.
 * Quotations use the same layout headed QUOTATION with the validity date.
 */
export function renderSaleReceipt(
  sale: ReceiptSale,
  settings: Settings,
  opts: {
    reprint?: { copyNo: number; at: Date; user: string };
    openDrawer: boolean;
    hour12?: boolean;
  },
): Buffer {
  const p = new EscPos(settings.receipt.lineWidth);
  const w = p.width;
  header(p, settings);
  const title =
    sale.kind === 'QUOTATION' ? 'QUOTATION' : sale.status === 'VOID' ? 'INVOICE (VOID)' : 'INVOICE';
  p.bold(true)
    .pair(`${title} ${sale.no}`, sale.wholesale ? 'WHOLESALE' : '')
    .bold(false);
  p.pair(formatDateTime(sale.completedAt, opts.hour12), `Cashier: ${sale.cashier}`);
  if (sale.customerName) p.line(`Customer: ${sale.customerName}`);
  if (sale.kind === 'QUOTATION' && sale.validUntil)
    p.line(`Valid until ${formatDate(sale.validUntil)}`);
  p.rule();
  const cols = (a: string, b: string, c: string, d: string) =>
    `${a.padStart(w - 30)}${b.padStart(9)}${c.padStart(8)}${d.padStart(13)}`.slice(-w);
  p.line(cols('Price', 'Disc', 'Qty', 'Amount'));
  for (const l of sale.lines) {
    p.line(l.name.slice(0, w));
    if (l.isLoose) {
      p.pair(`  ${formatQty(l.qty)} L x ${formatMoney(l.unitPrice)}`, formatMoney(l.amount));
    } else {
      p.line(
        cols(
          formatMoney(l.unitPrice),
          formatMoney(l.discountPerUnit),
          formatQty(l.qty),
          formatMoney(l.amount),
        ),
      );
    }
  }
  p.rule();
  p.pair(`Net items: ${sale.itemCount}`, `Net qty: ${formatQty(sale.totalQty)}`);
  p.pair('Gross', formatMoney(sale.gross));
  p.pair('Discount', formatMoney(sale.discount));
  if (!D(sale.roundingAdjustment).isZero())
    p.pair('Rounding', formatMoney(sale.roundingAdjustment));
  p.bold(true)
    .big(true)
    .pair('NET TOTAL', formatMoney(sale.netTotal), Math.floor(w / 2))
    .big(false)
    .bold(false);
  if (sale.kind === 'INVOICE' && sale.cashGiven !== null) {
    p.pair('Cash', formatMoney(sale.cashGiven));
    p.pair('Change', formatMoney(sale.change ?? '0'));
  }
  const saved = savedAmount(sale.lines);
  if (D(saved).greaterThan(0))
    p.align('center')
      .line(`You saved Rs ${formatMoney(saved)}`)
      .align('left');
  p.rule();
  if (settings.receipt.footerEn) p.align('center').line(settings.receipt.footerEn).align('left');
  if (opts.reprint) {
    p.align('center')
      .bold(true)
      .line(
        `REPRINT #${opts.reprint.copyNo} - ${formatDateTime(opts.reprint.at, opts.hour12)} - ${opts.reprint.user}`,
      )
      .bold(false)
      .align('left');
  }
  p.cut();
  if (opts.openDrawer) p.openDrawer();
  return p.build();
}

/** Just the drawer kick, for "Print receipt? No". */
export function drawerOnly(): Buffer {
  return new EscPos().openDrawer().build();
}

export function renderReturnReceipt(
  ret: {
    no: string;
    saleNo: string | null;
    oldBillRef: string;
    at: Date;
    cashier: string;
    lines: { name: string; qty: string; amount: string; disposition: string; reason: string }[];
    refundTotal: string;
  },
  settings: Settings,
  hour12?: boolean,
): Buffer {
  const p = new EscPos(settings.receipt.lineWidth);
  header(p, settings);
  p.bold(true).line(`SALES RETURN ${ret.no}`).bold(false);
  p.line(ret.saleNo ? `For invoice ${ret.saleNo}` : `Old-system bill ${ret.oldBillRef}`);
  p.pair(formatDateTime(ret.at, hour12), `Cashier: ${ret.cashier}`);
  p.rule();
  for (const l of ret.lines) {
    p.line(l.name.slice(0, p.width));
    p.pair(
      `  ${formatQty(l.qty)} - ${l.reason}${l.disposition === 'DAMAGED' ? ' (damaged)' : ''}`,
      formatMoney(l.amount),
    );
  }
  p.rule();
  p.bold(true)
    .pair('REFUND', `Rs ${formatMoney(ret.refundTotal)}`)
    .bold(false);
  p.cut().openDrawer();
  return p.build();
}

export function renderDayEnd(
  s: {
    no: string;
    counter: string;
    businessDate: string;
    openedBy: string;
    closedBy: string;
    openingFloat: string;
    billCount: number;
    cashSales: string;
    cashRefunds: string;
    cashIn: string;
    cashOut: string;
    expectedCash: string;
    countedCash: string;
    difference: string;
    denominations: Record<string, number>;
    movements: { kind: string; amount: string; reason: string; note: string }[];
  },
  settings: Settings,
): Buffer {
  const p = new EscPos(settings.receipt.lineWidth);
  header(p, settings);
  p.bold(true).line(`DAY END ${s.no}`).bold(false);
  p.pair(`Counter ${s.counter}`, formatDate(s.businessDate));
  p.pair(`Opened: ${s.openedBy}`, `Closed: ${s.closedBy}`);
  p.rule();
  p.pair('Opening float', formatMoney(s.openingFloat));
  p.pair(`Cash sales (${s.billCount} bills)`, formatMoney(s.cashSales));
  p.pair('Refunds', `-${formatMoney(s.cashRefunds)}`);
  p.pair('Cash in', formatMoney(s.cashIn));
  p.pair('Cash out', `-${formatMoney(s.cashOut)}`);
  for (const m of s.movements)
    p.line(
      `  ${m.kind === 'IN' ? '+' : '-'}${formatMoney(m.amount)} ${m.reason} ${m.note}`.slice(
        0,
        p.width,
      ),
    );
  p.rule();
  p.bold(true).pair('Expected cash', formatMoney(s.expectedCash)).bold(false);
  for (const [note, count] of Object.entries(s.denominations)) {
    if (count) p.pair(`  ${note} x ${count}`, formatMoney(D(note).times(count)));
  }
  p.pair('Counted cash', formatMoney(s.countedCash));
  p.bold(true).pair('Difference', formatMoney(s.difference)).bold(false);
  p.cut();
  return p.build();
}
