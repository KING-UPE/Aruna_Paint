import {
  D,
  hrmMonthConfigSchema,
  type HrmMonthConfig,
  type HrmSettings,
} from '@aruna/shared';
import { z } from 'zod';
import type { Tx } from '../../db';
import { audit } from '../../core/audit';
import type { ActorRef } from '../../core/context';
import type { SettingsService } from '../../core/settings';

export const updateHrmMonthSchema = hrmMonthConfigSchema.extend({
  saveAsDefault: z.boolean().default(false),
  syncUserRates: z.boolean().default(true),
});
export type UpdateHrmMonthInput = z.infer<typeof updateHrmMonthSchema>;

export interface HrmMemberShare {
  id: string;
  name: string;
  userId: string | null;
  role: string;
  ratePercent: number;
  shareOfPoolPercent: number;
  commissionAmount: string;
}

export interface HrmMonthlySummary {
  period: {
    year: number;
    month: number;
    key: string; // YYYY-MM
    startDate: string;
    endDate: string;
    isCurrentMonth: boolean;
    label: string;
  };
  sales: {
    grossSales: string;
    discounts: string;
    refunds: string;
    netSales: string;
    invoiceCount: number;
  };
  expenses: {
    shopRent: number;
    electricityBill: number;
    salaries: { id: string; name: string; role: string; amount: number }[];
    totalSalaries: number;
    totalFixedExpenses: number;
  };
  commission: {
    maxCommissionPercent: number;
    grossCommissionPool: string;
    totalFixedExpenses: string;
    netCommissionPool: string;
    totalMemberRatePercent: number;
    shortfall: string;
  };
  shares: HrmMemberShare[];
  users: {
    id: string;
    username: string;
    fullName: string;
    roles: string[];
    commissionRate: string | null;
  }[];
}

export async function getHrmMonthlySummary(
  tx: Tx,
  settings: SettingsService,
  year: number,
  month: number,
): Promise<HrmMonthlySummary> {
  const periodKey = `${year}-${String(month).padStart(2, '0')}`;
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const isCurrentMonth = year === currentYear && month === currentMonth;

  // Month starts on the 1st
  const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  // If current month, end is now ("start: month 1 end: for now"); otherwise end of month
  const endDate = isCurrentMonth
    ? now
    : new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  // Query completed sales in date range
  const salesAgg = await tx.$queryRaw<
    {
      total_net: string | null;
      total_gross: string | null;
      total_discounts: string | null;
      count: bigint;
    }[]
  >`
    SELECT COALESCE(SUM(net_total), 0)::text AS total_net,
           COALESCE(SUM(gross), 0)::text AS total_gross,
           COALESCE(SUM(discount), 0)::text AS total_discounts,
           COUNT(*) AS count
      FROM sales
     WHERE kind = 'INVOICE'
       AND status = 'COMPLETED'
       AND completed_at >= ${startDate}
       AND completed_at <= ${endDate}`;

  // Query refunds in date range
  const returnsAgg = await tx.$queryRaw<{ total_refunds: string | null }[]>`
    SELECT COALESCE(SUM(refund_total), 0)::text AS total_refunds
      FROM sale_returns
     WHERE created_at >= ${startDate}
       AND created_at <= ${endDate}`;

  const grossSalesD = D(salesAgg[0]?.total_gross ?? '0');
  const discountsD = D(salesAgg[0]?.total_discounts ?? '0');
  const refundsD = D(returnsAgg[0]?.total_refunds ?? '0');
  const rawNetSalesD = D(salesAgg[0]?.total_net ?? '0').minus(refundsD);
  const netSalesD = rawNetSalesD.isNegative() ? D(0) : rawNetSalesD;
  const invoiceCount = Number(salesAgg[0]?.count ?? 0);

  // Load HRM settings
  const hrmSettings = (await settings.get('hrm')) as HrmSettings;
  const override = hrmSettings.monthlyOverrides?.[periodKey];

  const maxCommissionPercent = override?.maxCommissionPercent ?? hrmSettings.maxCommissionPercent ?? 10;
  const shopRent = override?.shopRent ?? hrmSettings.shopRent ?? 45000;
  const electricityBill = override?.electricityBill ?? hrmSettings.electricityBill ?? 18500;
  const salaries = override?.salaries ?? hrmSettings.salaries ?? [];
  const members = override?.members ?? hrmSettings.members ?? [];

  const totalSalaries = salaries.reduce((sum, s) => sum + Number(s.amount || 0), 0);
  const totalFixedExpenses = shopRent + electricityBill + totalSalaries;

  // Max Commission Pool (e.g. 10% of Net Sales)
  const grossCommissionPoolD = netSalesD.times(maxCommissionPercent).dividedBy(100);
  const fixedExpensesD = D(totalFixedExpenses);

  // Net Commission Pool after deducting fixed expenses
  const netPoolCalcD = grossCommissionPoolD.minus(fixedExpensesD);
  const netCommissionPoolD = netPoolCalcD.isNegative() ? D(0) : netPoolCalcD;
  const shortfallD = netPoolCalcD.isNegative() ? netPoolCalcD.abs() : D(0);

  const totalMemberRatePercent = members.reduce((sum, m) => sum + Number(m.ratePercent || 0), 0);

  // Share to table members
  const shares: HrmMemberShare[] = members.map((m) => {
    const rate = Number(m.ratePercent || 0);
    const shareOfPoolPercent =
      totalMemberRatePercent > 0 ? (rate / totalMemberRatePercent) * 100 : 0;

    // Commission amount = Net Pool * (Member Rate / Max Commission Percent)
    const amountD =
      maxCommissionPercent > 0
        ? netCommissionPoolD.times(rate).dividedBy(maxCommissionPercent)
        : D(0);

    return {
      id: m.id,
      name: m.name,
      userId: m.userId ?? null,
      role: m.role || '',
      ratePercent: rate,
      shareOfPoolPercent: Number(shareOfPoolPercent.toFixed(2)),
      commissionAmount: amountD.toFixed(2),
    };
  });

  // Query active users for linking & role info
  const usersRaw = await tx.user.findMany({
    where: { active: true },
    select: {
      id: true,
      username: true,
      fullName: true,
      commissionRate: true,
      roles: { select: { role: { select: { name: true } } } },
    },
    orderBy: { fullName: 'asc' },
  });

  const users = usersRaw.map((u) => ({
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    roles: u.roles.map((r) => r.role.name),
    commissionRate: u.commissionRate ? u.commissionRate.toString() : null,
  }));

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const label = `${monthNames[month - 1]} ${year}${isCurrentMonth ? ' (Current - Up to Now)' : ''}`;

  return {
    period: {
      year,
      month,
      key: periodKey,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      isCurrentMonth,
      label,
    },
    sales: {
      grossSales: grossSalesD.toFixed(2),
      discounts: discountsD.toFixed(2),
      refunds: refundsD.toFixed(2),
      netSales: netSalesD.toFixed(2),
      invoiceCount,
    },
    expenses: {
      shopRent,
      electricityBill,
      salaries,
      totalSalaries,
      totalFixedExpenses,
    },
    commission: {
      maxCommissionPercent,
      grossCommissionPool: grossCommissionPoolD.toFixed(2),
      totalFixedExpenses: fixedExpensesD.toFixed(2),
      netCommissionPool: netCommissionPoolD.toFixed(2),
      totalMemberRatePercent,
      shortfall: shortfallD.toFixed(2),
    },
    shares,
    users,
  };
}

export async function updateHrmMonth(
  tx: Tx,
  settings: SettingsService,
  actor: ActorRef,
  periodKey: string,
  input: UpdateHrmMonthInput,
): Promise<HrmSettings> {
  const current = (await settings.get('hrm')) as HrmSettings;
  const before = structuredClone(current);

  const monthConfig: HrmMonthConfig = {
    maxCommissionPercent: input.maxCommissionPercent,
    shopRent: input.shopRent,
    electricityBill: input.electricityBill,
    salaries: input.salaries,
    members: input.members,
  };

  const updated: HrmSettings = {
    ...current,
    monthlyOverrides: {
      ...(current.monthlyOverrides ?? {}),
      [periodKey]: monthConfig,
    },
  };

  if (input.saveAsDefault) {
    updated.maxCommissionPercent = input.maxCommissionPercent;
    updated.shopRent = input.shopRent;
    updated.electricityBill = input.electricityBill;
    updated.salaries = input.salaries;
    updated.members = input.members;
  }

  // Update user commission rates in database if requested and linked
  if (input.syncUserRates) {
    for (const m of input.members) {
      if (m.userId) {
        await tx.user.updateMany({
          where: { id: m.userId },
          data: { commissionRate: m.ratePercent },
        });
      }
    }
  }

  const saved = (await settings.set(tx, 'hrm', updated)) as HrmSettings;

  await audit(tx, actor, {
    action: 'hrm.update',
    entity: 'hrm',
    entityId: periodKey,
    before,
    after: saved,
  });

  return saved;
}
