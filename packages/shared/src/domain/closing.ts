import { D, Decimal, money, type DecimalLike } from '../decimal';

export type CutoffKind = 'FIXED' | 'VARIABLE' | 'PERCENT';
/** What a percentage is taken from; by default what remains after the fixed cutoffs. */
export type CutoffBase = 'REMAINING_AFTER_FIXED' | 'NET_SALES' | 'GROSS_PROFIT';

export interface CutoffRuleInput {
  id: string;
  name: string;
  kind: CutoffKind;
  /** Rs for FIXED and VARIABLE (last month's figure until the actual is typed), % for PERCENT. */
  value: DecimalLike;
  base?: CutoffBase;
  sortOrder: number;
}

export interface ClosingLine {
  ruleId: string | null;
  label: string;
  kind: CutoffKind | 'SUMMARY';
  /** Negative for cutoffs. */
  amount: Decimal;
  base?: CutoffBase;
  percent?: Decimal;
}

export interface MonthlyClosingResult {
  netSales: Decimal;
  costOfGoodsSold: Decimal;
  grossProfit: Decimal;
  dailyExpenses: Decimal;
  remainingAfterFixed: Decimal;
  balance: Decimal;
  lines: ClosingLine[];
}

/**
 * Applies the Super Admin's cutoffs in order: fixed and variable bills come off the gross profit
 * (after daily expenses from the day ends), then each percentage is taken from its base.
 */
export function computeMonthlyClosing(input: {
  netSales: DecimalLike;
  costOfGoodsSold: DecimalLike;
  dailyExpenses: DecimalLike;
  rules: CutoffRuleInput[];
  /** Actual amounts typed for VARIABLE rules this month, by rule id. */
  actuals?: Record<string, DecimalLike>;
}): MonthlyClosingResult {
  const netSales = money(input.netSales);
  const cogs = money(input.costOfGoodsSold);
  const grossProfit = money(netSales.minus(cogs));
  const dailyExpenses = money(input.dailyExpenses);
  const rules = [...input.rules].sort((a, b) => a.sortOrder - b.sortOrder);

  const fixedLines: ClosingLine[] = [];
  let remaining = grossProfit.minus(dailyExpenses);
  for (const r of rules) {
    if (r.kind === 'PERCENT') continue;
    const amt = money(
      r.kind === 'VARIABLE' && input.actuals?.[r.id] !== undefined ? input.actuals[r.id]! : r.value,
    );
    remaining = remaining.minus(amt);
    fixedLines.push({ ruleId: r.id, label: r.name, kind: r.kind, amount: amt.negated() });
  }
  const remainingAfterFixed = money(remaining);

  const percentLines: ClosingLine[] = [];
  let balance = remainingAfterFixed;
  for (const r of rules) {
    if (r.kind !== 'PERCENT') continue;
    const base = r.base ?? 'REMAINING_AFTER_FIXED';
    const baseAmount =
      base === 'NET_SALES' ? netSales : base === 'GROSS_PROFIT' ? grossProfit : remainingAfterFixed;
    const pct = D(r.value);
    const amt = money(Decimal.max(baseAmount, 0).times(pct).dividedBy(100));
    balance = balance.minus(amt);
    percentLines.push({
      ruleId: r.id,
      label: r.name,
      kind: 'PERCENT',
      amount: amt.negated(),
      base,
      percent: pct,
    });
  }

  const lines: ClosingLine[] = [
    { ruleId: null, label: 'Net sales', kind: 'SUMMARY', amount: netSales },
    { ruleId: null, label: 'Cost of goods sold', kind: 'SUMMARY', amount: cogs.negated() },
    { ruleId: null, label: 'Gross profit', kind: 'SUMMARY', amount: grossProfit },
    {
      ruleId: null,
      label: 'Daily expenses from day ends',
      kind: 'SUMMARY',
      amount: dailyExpenses.negated(),
    },
    ...fixedLines,
    {
      ruleId: null,
      label: 'Remaining after fixed cutoffs',
      kind: 'SUMMARY',
      amount: remainingAfterFixed,
    },
    ...percentLines,
    { ruleId: null, label: 'Balance', kind: 'SUMMARY', amount: money(balance) },
  ];

  return {
    netSales,
    costOfGoodsSold: cogs,
    grossProfit,
    dailyExpenses,
    remainingAfterFixed,
    balance: money(balance),
    lines,
  };
}
