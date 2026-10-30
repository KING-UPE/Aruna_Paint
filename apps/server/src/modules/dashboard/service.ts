import {
  D,
  dashboardRanges,
  money,
  shopDate,
  type DashboardRange,
  type DateRange,
} from '@aruna/shared';
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../../db';
import { supplierBalances } from '../suppliers/service';

/** Shop midnight of a calendar date, for database ranges. */
const at = (date: string) => new Date(`${date}T00:00:00+05:30`);
const LOCAL = Prisma.sql`(s.completed_at AT TIME ZONE 'Asia/Colombo')`;
/** Paid invoices only: quotations, held and voided bills are not sales. */
const PAID = Prisma.sql`s.kind = 'INVOICE' AND s.status = 'COMPLETED'`;

const inRange = (r: DateRange) =>
  Prisma.sql`s.completed_at >= ${at(r.start)} AND s.completed_at < ${at(r.nextStart)}`;

interface Totals {
  sales: string;
  bills: number;
  profit: string;
  discount: string;
  returns: string;
}

async function totals(tx: Tx | Db, r: DateRange): Promise<Totals> {
  const [row] = await tx.$queryRaw<
    { sales: string | null; bills: number; profit: string | null; discount: string | null }[]
  >`
    SELECT SUM(s.net_total)::text AS sales, COUNT(*)::int AS bills,
           SUM(s.net_total - s.cost_total)::text AS profit, SUM(s.discount)::text AS discount
      FROM sales s WHERE ${PAID} AND ${inRange(r)}`;
  const [ret] = await tx.$queryRaw<{ total: string | null }[]>`
    SELECT SUM(refund_total)::text AS total FROM sale_returns
     WHERE created_at >= ${at(r.start)} AND created_at < ${at(r.nextStart)}`;
  return {
    sales: money(row?.sales ?? 0).toFixed(2),
    bills: row?.bills ?? 0,
    profit: money(row?.profit ?? 0).toFixed(2),
    discount: money(row?.discount ?? 0).toFixed(2),
    returns: money(ret?.total ?? 0).toFixed(2),
  };
}

async function daily(tx: Tx | Db, r: DateRange) {
  const rows = await tx.$queryRaw<{ day: string; sales: string; bills: number; profit: string }[]>`
    SELECT to_char(${LOCAL}::date, 'YYYY-MM-DD') AS day, SUM(s.net_total)::text AS sales,
           COUNT(*)::int AS bills, SUM(s.net_total - s.cost_total)::text AS profit
      FROM sales s WHERE ${PAID} AND ${inRange(r)}
     GROUP BY 1`;
  const ret = await tx.$queryRaw<{ day: string; total: string }[]>`
    SELECT to_char((created_at AT TIME ZONE 'Asia/Colombo')::date, 'YYYY-MM-DD') AS day,
           SUM(refund_total)::text AS total
      FROM sale_returns
     WHERE created_at >= ${at(r.start)} AND created_at < ${at(r.nextStart)}
     GROUP BY 1`;
  const byDay = new Map(rows.map((x) => [x.day, x]));
  const retByDay = new Map(ret.map((x) => [x.day, x.total]));
  return r.days.map((day) => {
    const x = byDay.get(day);
    return {
      date: day,
      sales: money(x?.sales ?? 0).toFixed(2),
      bills: x?.bills ?? 0,
      profit: money(x?.profit ?? 0).toFixed(2),
      returns: money(retByDay.get(day) ?? 0).toFixed(2),
    };
  });
}

/**
 * Everything the dashboard charts: totals against the period before, sales per day, per hour
 * and per weekday, the best-selling products and categories, counters, cashiers, stock health
 * and supplier dues. Profit is only for those who may see cost totals.
 */
export async function dashboard(
  tx: Tx | Db,
  opts: {
    range: DashboardRange;
    monthStartDay: number;
    canSeeProfit: boolean;
    canSeeSuppliers: boolean;
    now?: Date;
  },
) {
  const today = shopDate(opts.now ?? new Date());
  const { current, previous } = dashboardRanges(opts.range, today, opts.monthStartDay);
  const cur = inRange(current);

  const [now, before, days, prevDays, hours, weekdays, products, categories, counters, cashiers] =
    await Promise.all([
      totals(tx, current),
      totals(tx, previous),
      daily(tx, current),
      daily(tx, previous),
      tx.$queryRaw<{ hour: number; sales: string; bills: number }[]>`
        SELECT EXTRACT(HOUR FROM ${LOCAL})::int AS hour, SUM(s.net_total)::text AS sales,
               COUNT(*)::int AS bills
          FROM sales s WHERE ${PAID} AND ${cur} GROUP BY 1`,
      tx.$queryRaw<{ dow: number; sales: string }[]>`
        SELECT EXTRACT(ISODOW FROM ${LOCAL})::int AS dow, SUM(s.net_total)::text AS sales
          FROM sales s WHERE ${PAID} AND ${cur} GROUP BY 1`,
      tx.$queryRaw<
        { id: string; code: string; name: string; sales: string; qty: string; unit: string }[]
      >`
        SELECT p.id, p.code, p.name, SUM(l.amount)::text AS sales, SUM(l.qty)::text AS qty,
               MIN(l.unit_name) AS unit
          FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN products p ON p.id = l.product_id
         WHERE ${PAID} AND ${cur}
         GROUP BY p.id ORDER BY SUM(l.amount) DESC LIMIT 8`,
      tx.$queryRaw<{ name: string; sales: string }[]>`
        SELECT COALESCE(c.name, 'No category') AS name, SUM(l.amount)::text AS sales
          FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN products p ON p.id = l.product_id
          LEFT JOIN categories c ON c.id = p.category_id
         WHERE ${PAID} AND ${cur}
         GROUP BY 1 ORDER BY SUM(l.amount) DESC`,
      tx.$queryRaw<{ code: string; name: string; sales: string; bills: number }[]>`
        SELECT c.code, c.name, SUM(s.net_total)::text AS sales, COUNT(*)::int AS bills
          FROM sales s JOIN counters c ON c.id = s.counter_id
         WHERE ${PAID} AND ${cur} GROUP BY c.id ORDER BY c.code`,
      tx.$queryRaw<{ name: string; sales: string; bills: number }[]>`
        SELECT u.full_name AS name, SUM(s.net_total)::text AS sales, COUNT(*)::int AS bills
          FROM sales s JOIN users u ON u.id = s.cashier_id
         WHERE ${PAID} AND ${cur} GROUP BY u.id ORDER BY SUM(s.net_total) DESC`,
    ]);

  // Sales per hour of the day: every hour that had a sale, padded to the usual shop hours.
  const hourMap = new Map(hours.map((h) => [h.hour, h]));
  const first = Math.min(8, ...hours.map((h) => h.hour));
  const last = Math.max(19, ...hours.map((h) => h.hour));
  const hourly = [];
  for (let h = first; h <= last; h++)
    hourly.push({
      hour: h,
      sales: money(hourMap.get(h)?.sales ?? 0).toFixed(2),
      bills: hourMap.get(h)?.bills ?? 0,
    });

  // Average sales per weekday, over the days of the range that have already happened.
  const pastDays = current.days.filter((d) => d <= today);
  const dowCount = new Map<number, number>();
  for (const d of pastDays) {
    const dow = ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    dowCount.set(dow, (dowCount.get(dow) ?? 0) + 1);
  }
  const dowSales = new Map(weekdays.map((w) => [w.dow, D(w.sales)]));
  const weekdayAverage = [1, 2, 3, 4, 5, 6, 7].map((dow) => ({
    day: dow,
    days: dowCount.get(dow) ?? 0,
    average: money(
      dowCount.get(dow) ? (dowSales.get(dow) ?? D(0)).dividedBy(dowCount.get(dow)!) : 0,
    ).toFixed(2),
  }));

  // Categories: the top six, then the rest together as "Other".
  const topCats = categories
    .slice(0, 6)
    .map((c) => ({ name: c.name, sales: money(c.sales).toFixed(2) }));
  const otherCats = categories.slice(6).reduce((s, c) => s.plus(D(c.sales)), D(0));
  if (otherCats.greaterThan(0)) topCats.push({ name: 'Other', sales: money(otherCats).toFixed(2) });

  // Things an owner checks for mistakes or cheating: voids, held bills and quotations taken
  // away, returns, reprints and mix paint prices changed at the counter.
  const from = at(current.start);
  const to = at(current.nextStart);
  const [voids, deletedHeld, deletedQuotations, returnsCount, reprints, priceOverrides] =
    await Promise.all([
      tx.sale.aggregate({
        where: { status: 'VOID', voidedAt: { gte: from, lt: to } },
        _count: true,
        _sum: { netTotal: true },
      }),
      tx.sale.aggregate({
        where: { status: 'DELETED', no: null, deletedAt: { gte: from, lt: to } },
        _count: true,
        _sum: { netTotal: true },
      }),
      tx.sale.aggregate({
        where: {
          status: 'DELETED',
          kind: 'QUOTATION',
          no: { not: null },
          deletedAt: { gte: from, lt: to },
        },
        _count: true,
        _sum: { netTotal: true },
      }),
      tx.saleReturn.aggregate({
        where: { createdAt: { gte: from, lt: to } },
        _count: true,
        _sum: { refundTotal: true },
      }),
      tx.reprint.count({ where: { at: { gte: from, lt: to } } }),
      tx.saleLine.count({
        where: {
          priceApproverId: { not: null },
          sale: { completedAt: { gte: from, lt: to }, status: 'COMPLETED' },
        },
      }),
    ]);
  const sum = (v: { toString(): string } | null | undefined) =>
    money(v?.toString() ?? 0).toFixed(2);
  const autoClosed = await tx.auditLog.count({
    where: { action: 'shift.auto_close', at: { gte: from, lt: to } },
  });
  const testModeOn = await tx.auditLog.count({
    where: { action: 'testmode.user_on', at: { gte: from, lt: to } },
  });
  // Lines taken off bills before payment, as the screens reported them.
  const removed = await tx.auditLog.findMany({
    where: { action: 'bill.lines_removed', at: { gte: from, lt: to } },
    select: { before: true },
  });
  const removedLines = removed.flatMap(
    (r) => (r.before as { lines?: { amount: string }[] } | null)?.lines ?? [],
  );
  const watch = {
    voids: { count: voids._count, total: sum(voids._sum.netTotal) },
    deletedHeld: { count: deletedHeld._count, total: sum(deletedHeld._sum.netTotal) },
    deletedQuotations: {
      count: deletedQuotations._count,
      total: sum(deletedQuotations._sum.netTotal),
    },
    returns: { count: returnsCount._count, total: sum(returnsCount._sum.refundTotal) },
    reprints,
    priceOverrides,
    autoClosed,
    testModeOn,
    removedLines: {
      count: removedLines.length,
      total: money(removedLines.reduce((t, l) => t.plus(D(l.amount || 0)), D(0))).toFixed(2),
    },
  };

  const [stock] = await tx.$queryRaw<{ out: number; low: number; ok: number }[]>`
    WITH st AS (
      SELECT p.id, p.reorder_level,
             COALESCE(SUM(b.qty) FILTER (WHERE l.kind <> 'DAMAGED'), 0) AS qty
        FROM products p
        LEFT JOIN sub_products sp ON sp.product_id = p.id
        LEFT JOIN stock_balances b ON b.sub_product_id = sp.id
        LEFT JOIN locations l ON l.id = b.location_id
       WHERE p.active AND p.type = 'STANDARD'
       GROUP BY p.id)
    SELECT COUNT(*) FILTER (WHERE qty = 0)::int AS out,
           COUNT(*) FILTER (WHERE qty > 0 AND reorder_level > 0 AND qty <= reorder_level)::int AS low,
           COUNT(*) FILTER (WHERE qty > 0 AND NOT (reorder_level > 0 AND qty <= reorder_level))::int AS ok
      FROM st`;

  let supplierDues: { total: string; top: { id: string; name: string; balance: string }[] } | null =
    null;
  if (opts.canSeeSuppliers) {
    const balances = await supplierBalances(tx as Tx);
    const owed = [...balances]
      .filter(([, b]) => b.greaterThan(0))
      .sort((a, b) => b[1].comparedTo(a[1]));
    const names = await tx.supplier.findMany({
      where: { id: { in: owed.slice(0, 6).map(([id]) => id) } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    supplierDues = {
      total: money(owed.reduce((s, [, b]) => s.plus(b), D(0))).toFixed(2),
      top: owed
        .slice(0, 6)
        .map(([id, b]) => ({ id, name: nameOf.get(id) ?? '', balance: money(b).toFixed(2) })),
    };
  }

  const avg = (t: Totals) => money(t.bills ? D(t.sales).dividedBy(t.bills) : 0).toFixed(2);
  const pick = (t: Totals) => ({
    sales: t.sales,
    bills: t.bills,
    averageBill: avg(t),
    returns: t.returns,
    discount: t.discount,
    ...(opts.canSeeProfit ? { profit: t.profit } : {}),
  });

  return {
    range: opts.range,
    today,
    /** Months on the chart follow the business month. */
    monthStartDay: opts.monthStartDay,
    current: { start: current.start, end: current.days.at(-1)! },
    previous: { start: previous.start, end: previous.days.at(-1)! },
    totals: { current: pick(now), previous: pick(before) },
    daily: days.map((d, i) => ({
      date: d.date,
      future: d.date > today,
      sales: d.sales,
      bills: d.bills,
      returns: d.returns,
      previousSales: prevDays[i]?.sales ?? null,
      ...(opts.canSeeProfit ? { profit: d.profit } : {}),
    })),
    hourly,
    weekdays: weekdayAverage,
    topProducts: products.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      sales: money(p.sales).toFixed(2),
      qty: D(p.qty).toFixed(3),
      unit: p.unit,
    })),
    categories: topCats,
    counters: counters.map((c) => ({ ...c, sales: money(c.sales).toFixed(2) })),
    cashiers: cashiers.map((c) => ({ ...c, sales: money(c.sales).toFixed(2) })),
    stock: stock ?? { out: 0, low: 0, ok: 0 },
    watch,
    supplierDues,
  };
}

export type Dashboard = Awaited<ReturnType<typeof dashboard>>;
