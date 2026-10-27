import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Coins,
  DollarSign,
  HelpCircle,
  Lock,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Trash2,
  UserCheck,
  Users,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formatDate, formatMoney, formatQty } from '@aruna/shared';

interface SalaryItem {
  id: string;
  name: string;
  role: string;
  amount: number;
}

interface MemberItem {
  id: string;
  name: string;
  userId: string | null;
  role: string;
  ratePercent: number;
  shareOfPoolPercent?: number;
  commissionAmount?: string;
}

interface HrmSummaryResponse {
  canEdit: boolean;
  period: {
    year: number;
    month: number;
    key: string;
    startDate: string;
    endDate: string;
    isCurrentMonth: boolean;
    label: string;
    monthStartDay: number;
    firstDay: string;
    lastDay: string;
    current: { year: number; month: number };
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
    salaries: SalaryItem[];
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
  shares: {
    id: string;
    name: string;
    userId: string | null;
    role: string;
    ratePercent: number;
    shareOfPoolPercent: number;
    commissionAmount: string;
  }[];
  users: {
    id: string;
    username: string;
    fullName: string;
    roles: string[];
    commissionRate: string | null;
  }[];
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function HrmPage() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const today = new Date();

  // Period switch state. The month may start on any day (Settings: month start), so the
  // current period comes from the server on first load.
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth() + 1);
  const [periodPicked, setPeriodPicked] = useState(false);

  // Form states editable by Super Admin
  const [maxCommissionPercent, setMaxCommissionPercent] = useState<number>(10);
  const [shopRent, setShopRent] = useState<number>(45000);
  const [electricityBill, setElectricityBill] = useState<number>(18500);
  const [salaries, setSalaries] = useState<SalaryItem[]>([]);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [syncUserRates, setSyncUserRates] = useState(true);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Query summary
  const summaryQuery = useQuery({
    queryKey: ['hrm-summary', selectedYear, selectedMonth],
    queryFn: () =>
      api.get<HrmSummaryResponse>(`/api/hrm/summary?year=${selectedYear}&month=${selectedMonth}`),
  });

  // Sync server data into form when summary loads or period changes
  useEffect(() => {
    if (summaryQuery.data) {
      setMaxCommissionPercent(summaryQuery.data.commission.maxCommissionPercent);
      setShopRent(summaryQuery.data.expenses.shopRent);
      setElectricityBill(summaryQuery.data.expenses.electricityBill);
      setSalaries(summaryQuery.data.expenses.salaries);
      setMembers(
        summaryQuery.data.shares.map((s) => ({
          id: s.id,
          name: s.name,
          userId: s.userId,
          role: s.role,
          ratePercent: s.ratePercent,
        })),
      );
    }
  }, [summaryQuery.data]);

  const canEdit = summaryQuery.data?.canEdit ?? false;

  // Mutation to save monthly configuration
  const saveMutation = useMutation({
    mutationFn: async (asDefault: boolean) => {
      const periodKey = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
      return api.put(`/api/hrm/month/${periodKey}`, {
        maxCommissionPercent: Number(maxCommissionPercent) || 0,
        shopRent: Number(shopRent) || 0,
        electricityBill: Number(electricityBill) || 0,
        salaries: salaries.map((s) => ({
          ...s,
          amount: Number(s.amount) || 0,
        })),
        members: members.map((m) => ({
          ...m,
          ratePercent: Number(m.ratePercent) || 0,
        })),
        saveAsDefault: asDefault,
        syncUserRates,
      });
    },
    onSuccess: (_, asDefault) => {
      qc.invalidateQueries({ queryKey: ['hrm-summary'] });
      setSaveMessage(
        asDefault
          ? `HRM settings saved for ${MONTHS[selectedMonth - 1]} ${selectedYear} and set as default for future months.`
          : `HRM settings saved for ${MONTHS[selectedMonth - 1]} ${selectedYear} only.`,
      );
      setTimeout(() => setSaveMessage(null), 5000);
    },
  });

  // Period navigation helpers
  const currentPeriod = summaryQuery.data?.period.current;
  const monthStartDay = summaryQuery.data?.period.monthStartDay ?? 1;
  useEffect(() => {
    if (!periodPicked && currentPeriod) {
      setPeriodPicked(true);
      setSelectedYear(currentPeriod.year);
      setSelectedMonth(currentPeriod.month);
    }
  }, [currentPeriod, periodPicked]);

  const goToCurrentMonth = () => {
    if (!currentPeriod) return;
    setSelectedYear(currentPeriod.year);
    setSelectedMonth(currentPeriod.month);
  };

  const saveMonthStart = async (day: number) => {
    await api.put('/api/hrm/month-start', { day });
    setPeriodPicked(false);
    await qc.invalidateQueries({ queryKey: ['hrm-summary'] });
  };

  const goToPrevMonth = () => {
    if (selectedMonth === 1) {
      setSelectedYear(selectedYear - 1);
      setSelectedMonth(12);
    } else {
      setSelectedMonth(selectedMonth - 1);
    }
  };

  const goToNextMonth = () => {
    if (selectedMonth === 12) {
      setSelectedYear(selectedYear + 1);
      setSelectedMonth(1);
    } else {
      setSelectedMonth(selectedMonth + 1);
    }
  };

  // Live calculation of pool and shares
  const netSales = Number(summaryQuery.data?.sales.netSales || 0);
  const grossCommissionPool = (netSales * (Number(maxCommissionPercent) || 0)) / 100;
  const totalSalaries = salaries.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  const totalFixedExpenses =
    (Number(shopRent) || 0) + (Number(electricityBill) || 0) + totalSalaries;
  const netCommissionPool = Math.max(0, grossCommissionPool - totalFixedExpenses);
  const shortfall = Math.max(0, totalFixedExpenses - grossCommissionPool);
  const totalMemberRatePercent = members.reduce((sum, m) => sum + (Number(m.ratePercent) || 0), 0);

  // Handlers for dynamic salaries
  const handleAddSalary = () => {
    const newId = `sal-${Date.now()}`;
    setSalaries([...salaries, { id: newId, name: 'New Employee', role: 'Staff', amount: 30000 }]);
  };

  const handleRemoveSalary = (id: string) => {
    setSalaries(salaries.filter((s) => s.id !== id));
  };

  const handleSalaryChange = (id: string, field: keyof SalaryItem, val: string | number) => {
    setSalaries(salaries.map((s) => (s.id === id ? { ...s, [field]: val } : s)));
  };

  // Handlers for dynamic members
  const handleAddMember = () => {
    const newId = `mem-${Date.now()}`;
    setMembers([
      ...members,
      {
        id: newId,
        name: 'New Beneficiary',
        userId: null,
        role: 'Staff / Partner',
        ratePercent: 1,
      },
    ]);
  };

  const handleRemoveMember = (id: string) => {
    setMembers(members.filter((m) => m.id !== id));
  };

  const handleMemberChange = (id: string, field: keyof MemberItem, val: unknown) => {
    setMembers(
      members.map((m) => {
        if (m.id !== id) return m;
        if (field === 'userId') {
          const userObj = summaryQuery.data?.users.find((u) => u.id === val);
          return {
            ...m,
            userId: (val as string) || null,
            name: userObj ? userObj.fullName : m.name,
            role: userObj ? userObj.roles.join(', ') : m.role,
            ratePercent: userObj?.commissionRate ? Number(userObj.commissionRate) : m.ratePercent,
          };
        }
        return { ...m, [field]: val };
      }),
    );
  };

  const isCurrentMonth =
    selectedYear === currentPeriod?.year && selectedMonth === currentPeriod?.month;

  return (
    <div className="flex flex-col gap-6 py-2">
      {/* Header & Month/Year Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-accent-text">
            <Coins size={24} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold">HRM & Commission Distribution</h1>
              {canEdit ? (
                <Badge tone="ok" className="gap-1">
                  <UserCheck size={12} /> Super Admin (Editable)
                </Badge>
              ) : (
                <Badge tone="warn" className="gap-1">
                  <Lock size={12} /> Admin (View Only)
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted">
              Monthly sales commission share after deducting fixed expenses (Shop rent, electricity,
              salaries)
            </p>
          </div>
        </div>

        {/* Date / Month Switcher */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-xl border border-border bg-surface-2 p-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={goToPrevMonth}
              title="Previous Month"
              className="h-8 w-8 p-0"
            >
              <ChevronLeft size={16} />
            </Button>

            <Select
              aria-label="Month"
              value={String(selectedMonth)}
              onChange={(e) => setSelectedMonth(Number(e.target.value))}
              className="h-8 w-36 rounded-lg border-0 text-sm font-semibold"
            >
              {MONTHS.map((m, idx) => (
                <option key={m} value={idx + 1}>
                  {m}
                </option>
              ))}
            </Select>

            <Select
              aria-label="Year"
              value={String(selectedYear)}
              onChange={(e) => setSelectedYear(Number(e.target.value))}
              className="h-8 w-24 rounded-lg border-0 text-sm font-semibold"
            >
              {[2024, 2025, 2026, 2027, 2028].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>

            <Button
              variant="ghost"
              size="sm"
              onClick={goToNextMonth}
              title="Next Month"
              className="h-8 w-8 p-0"
            >
              <ChevronRight size={16} />
            </Button>
          </div>

          <label className="flex items-center gap-2 text-xs font-medium text-muted">
            Month starts on day
            <Select
              aria-label="Month starts on day"
              value={String(monthStartDay)}
              disabled={!canEdit}
              onChange={(e) => void saveMonthStart(Number(e.target.value))}
              className="h-9 w-20 rounded-lg text-sm font-semibold"
            >
              {Array.from({ length: 28 }, (_, i) => (
                <option key={i + 1} value={String(i + 1)}>
                  {i + 1}
                </option>
              ))}
            </Select>
          </label>

          <Button
            variant={isCurrentMonth ? 'primary' : 'secondary'}
            size="sm"
            onClick={goToCurrentMonth}
            className="h-9 gap-1 text-xs font-semibold"
          >
            <Calendar size={14} /> Current Month
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => void summaryQuery.refetch()}
            title="Refresh calculation"
            className="h-9 w-9 p-0"
          >
            <RefreshCw size={14} className={summaryQuery.isFetching ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {/* Date Range Badge */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/80 bg-surface-2/60 px-4 py-2.5 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-foreground">Active Period:</span>
          <span className="rounded-md bg-accent-soft px-2 py-0.5 font-bold text-accent-strong">
            {MONTHS[selectedMonth - 1]} {selectedYear}
          </span>
          <span className="text-muted">
            {summaryQuery.data
              ? `${formatDate(summaryQuery.data.period.firstDay)} to ${
                  isCurrentMonth ? 'today, up to now' : formatDate(summaryQuery.data.period.lastDay)
                }`
              : ''}
          </span>
        </div>
        {!canEdit && (
          <div className="flex items-center gap-1.5 text-amber-500 font-medium">
            <Lock size={13} /> Only Super Admin can edit rates, salaries, and expenses.
          </div>
        )}
      </div>

      {saveMessage && (
        <div className="flex items-center gap-2 rounded-xl border border-ok/40 bg-ok-soft/30 p-3 text-sm text-ok">
          <CheckCircle2 size={16} /> {saveMessage}
        </div>
      )}

      {/* 4 Top Metric Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Month Sales */}
        <Card className="border-border">
          <CardBody className="p-4">
            <div className="text-xs font-medium uppercase text-muted">1. Month Net Sales</div>
            <div className="mt-1 text-2xl font-extrabold text-foreground">
              Rs {formatMoney(summaryQuery.data?.sales.netSales ?? '0.00')}
            </div>
            <div className="mt-1.5 text-xs text-muted flex items-center justify-between">
              <span>{summaryQuery.data?.sales.invoiceCount ?? 0} invoices</span>
              <span>Discounts: Rs {formatMoney(summaryQuery.data?.sales.discounts ?? '0.00')}</span>
            </div>
          </CardBody>
        </Card>

        {/* Gross Commission Pool (e.g. 10%) */}
        <Card className="border-border">
          <CardBody className="p-4">
            <div className="flex items-center justify-between text-xs font-medium uppercase text-muted">
              <span>2. Max Commission Pool</span>
              <span className="font-bold text-accent-strong">{maxCommissionPercent}%</span>
            </div>
            <div className="mt-1 text-2xl font-extrabold text-accent-strong">
              Rs {formatMoney(grossCommissionPool.toFixed(2))}
            </div>
            <div className="mt-1.5 text-xs text-muted">
              {maxCommissionPercent}% of Net Sales (before fixed deductions)
            </div>
          </CardBody>
        </Card>

        {/* Total Fixed Expenses */}
        <Card className="border-border">
          <CardBody className="p-4">
            <div className="flex items-center justify-between text-xs font-medium uppercase text-muted">
              <span>3. Fixed Expenses</span>
              <span className="font-bold text-danger">Deduction</span>
            </div>
            <div className="mt-1 text-2xl font-extrabold text-danger">
              - Rs {formatMoney(totalFixedExpenses.toFixed(2))}
            </div>
            <div className="mt-1.5 text-xs text-muted">
              Rent + Electricity + {salaries.length} Staff Salaries
            </div>
          </CardBody>
        </Card>

        {/* Net Commission Pool for Members */}
        <Card className={netCommissionPool > 0 ? 'border-ok/40 bg-ok-soft/10' : 'border-border'}>
          <CardBody className="p-4">
            <div className="flex items-center justify-between text-xs font-medium uppercase text-muted">
              <span>4. Net Pool to Share</span>
              <span className="font-bold text-ok">Available</span>
            </div>
            <div className="mt-1 text-2xl font-extrabold text-ok">
              Rs {formatMoney(netCommissionPool.toFixed(2))}
            </div>
            <div className="mt-1.5 text-xs text-muted">
              {shortfall > 0 ? (
                <span className="text-danger font-medium">
                  Shortfall: Rs {formatMoney(shortfall.toFixed(2))}
                </span>
              ) : (
                <span>Distributed to table members based on %</span>
              )}
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Main Grid: Expenses Card & Commission Distribution Table */}
      <div className="grid gap-6 lg:grid-cols-12">
        {/* Left Column: Fixed Expenses & Salaries (5 cols) */}
        <div className="flex flex-col gap-6 lg:col-span-5">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between border-b border-border pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <DollarSign size={18} className="text-accent-strong" /> Fixed Monthly Expenses
              </CardTitle>
              {canEdit ? (
                <Badge tone="neutral" className="text-xs">
                  Editable by Super Admin
                </Badge>
              ) : (
                <Badge tone="warn" className="text-xs">
                  Read Only
                </Badge>
              )}
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                {/* Shop Rent */}
                <div>
                  <label className="text-xs font-semibold text-muted">Shop Rent (Rs)</label>
                  <Input
                    type="number"
                    min="0"
                    step="100"
                    disabled={!canEdit}
                    value={shopRent}
                    onChange={(e) => setShopRent(Number(e.target.value) || 0)}
                    className="mt-1 font-mono font-bold"
                  />
                </div>

                {/* Electricity Bill */}
                <div>
                  <label className="text-xs font-semibold text-muted">Electricity Bill (Rs)</label>
                  <Input
                    type="number"
                    min="0"
                    step="50"
                    disabled={!canEdit}
                    value={electricityBill}
                    onChange={(e) => setElectricityBill(Number(e.target.value) || 0)}
                    className="mt-1 font-mono font-bold"
                  />
                </div>
              </div>

              {/* Salaries List */}
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex items-center justify-between border-t border-border pt-3">
                  <div>
                    <div className="text-sm font-bold">Staff Salaries</div>
                    <div className="text-xs text-muted">Add/remove employee salaries</div>
                  </div>
                  {canEdit && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleAddSalary}
                      className="h-8 gap-1 text-xs font-semibold"
                    >
                      <Plus size={14} /> Add Salary
                    </Button>
                  )}
                </div>

                <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto pr-1">
                  {salaries.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center gap-2 rounded-xl border border-border bg-surface-2 p-2.5"
                    >
                      <div className="flex-1">
                        <Input
                          type="text"
                          placeholder="Employee name"
                          disabled={!canEdit}
                          value={s.name}
                          onChange={(e) => handleSalaryChange(s.id, 'name', e.target.value)}
                          className="h-7 text-xs font-medium"
                        />
                      </div>
                      <div className="w-24">
                        <Input
                          type="text"
                          placeholder="Role"
                          disabled={!canEdit}
                          value={s.role}
                          onChange={(e) => handleSalaryChange(s.id, 'role', e.target.value)}
                          className="h-7 text-xs text-muted"
                        />
                      </div>
                      <div className="w-28">
                        <Input
                          type="number"
                          placeholder="Amount"
                          disabled={!canEdit}
                          value={s.amount}
                          onChange={(e) =>
                            handleSalaryChange(s.id, 'amount', Number(e.target.value) || 0)
                          }
                          className="h-7 text-xs font-mono font-bold text-right"
                        />
                      </div>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveSalary(s.id)}
                          className="h-7 w-7 p-0 text-muted hover:text-danger"
                          title="Remove salary"
                        >
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </div>
                  ))}

                  {salaries.length === 0 && (
                    <div className="py-4 text-center text-xs text-muted">
                      No salaries added yet. Click &quot;Add Salary&quot; above.
                    </div>
                  )}
                </div>

                {/* Fixed Expenses Summary */}
                <div className="mt-2 rounded-xl border border-border/80 bg-surface-2/60 p-3 text-xs flex flex-col gap-1.5">
                  <div className="flex justify-between text-muted">
                    <span>Rent + Electricity:</span>
                    <span>Rs {formatMoney((shopRent + electricityBill).toFixed(2))}</span>
                  </div>
                  <div className="flex justify-between text-muted">
                    <span>Total Salaries ({salaries.length} staff):</span>
                    <span>Rs {formatMoney(totalSalaries.toFixed(2))}</span>
                  </div>
                  <div className="flex justify-between font-bold text-foreground border-t border-border pt-1.5 text-sm">
                    <span>Total Fixed Deductions:</span>
                    <span className="text-danger">
                      Rs {formatMoney(totalFixedExpenses.toFixed(2))}
                    </span>
                  </div>
                </div>
              </div>
            </CardBody>
          </Card>
        </div>

        {/* Right Column: Commission Sharing Table (7 cols) */}
        <div className="flex flex-col gap-6 lg:col-span-7">
          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Users size={18} className="text-accent-strong" /> Commission Share Members
                </CardTitle>
                <p className="text-xs text-muted">
                  Default: Aruna 3%, Owner 3%, Savings 4% (Total {maxCommissionPercent}% pool)
                </p>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-muted font-medium">Max Pool %:</span>
                  <Input
                    type="number"
                    min="1"
                    max="100"
                    step="0.5"
                    disabled={!canEdit}
                    value={maxCommissionPercent}
                    onChange={(e) => setMaxCommissionPercent(Number(e.target.value) || 0)}
                    className="h-8 w-16 text-center font-bold"
                  />
                  <span className="text-muted">%</span>
                </div>

                {canEdit && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleAddMember}
                    className="h-8 gap-1 text-xs font-semibold"
                  >
                    <Plus size={14} /> Add Member
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardBody className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted bg-surface-2/40">
                      <th className="px-4 py-2.5">Beneficiary / Member</th>
                      <th className="px-3 py-2.5">Link User</th>
                      <th className="num px-3 py-2.5">Rate (%)</th>
                      <th className="num px-3 py-2.5">Share Ratio</th>
                      <th className="num px-4 py-2.5">Monthly Share (Rs)</th>
                      {canEdit && <th className="px-2 py-2.5 text-center">Action</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => {
                      const rate = Number(m.ratePercent) || 0;
                      const shareRatio =
                        totalMemberRatePercent > 0
                          ? ((rate / totalMemberRatePercent) * 100).toFixed(1)
                          : '0.0';
                      const amount =
                        maxCommissionPercent > 0
                          ? (netCommissionPool * rate) / maxCommissionPercent
                          : 0;

                      return (
                        <tr
                          key={m.id}
                          className="border-t border-border hover:bg-surface-2/60 transition"
                        >
                          {/* Member name & role */}
                          <td className="px-4 py-3">
                            {canEdit ? (
                              <div className="flex flex-col gap-1">
                                <Input
                                  type="text"
                                  value={m.name}
                                  onChange={(e) => handleMemberChange(m.id, 'name', e.target.value)}
                                  className="h-7 text-xs font-semibold"
                                  placeholder="Name (e.g. Aruna, Owner, Savings)"
                                />
                                <Input
                                  type="text"
                                  value={m.role}
                                  onChange={(e) => handleMemberChange(m.id, 'role', e.target.value)}
                                  className="h-6 text-[11px] text-muted"
                                  placeholder="Role / Details"
                                />
                              </div>
                            ) : (
                              <div>
                                <div className="font-semibold text-foreground">{m.name}</div>
                                <div className="text-xs text-muted">{m.role || '—'}</div>
                              </div>
                            )}
                          </td>

                          {/* Link to system user */}
                          <td className="px-3 py-3">
                            {canEdit ? (
                              <Select
                                aria-label="Link user"
                                value={m.userId ?? ''}
                                onChange={(e) => handleMemberChange(m.id, 'userId', e.target.value)}
                                className="h-8 w-48 rounded-lg text-xs font-medium"
                              >
                                <option value="">(Custom / Fund)</option>
                                {(summaryQuery.data?.users ?? []).map((u) => (
                                  <option key={u.id} value={u.id}>
                                    {u.fullName} ({u.username})
                                  </option>
                                ))}
                              </Select>
                            ) : (
                              <span className="text-xs text-muted">
                                {m.userId
                                  ? (summaryQuery.data?.users.find((u) => u.id === m.userId)
                                      ?.username ?? 'Linked User')
                                  : 'Custom'}
                              </span>
                            )}
                          </td>

                          {/* Rate % */}
                          <td className="num px-3 py-3">
                            {canEdit ? (
                              <div className="flex items-center justify-end gap-1">
                                <Input
                                  type="number"
                                  min="0"
                                  max="100"
                                  step="0.5"
                                  value={m.ratePercent}
                                  onChange={(e) =>
                                    handleMemberChange(
                                      m.id,
                                      'ratePercent',
                                      Number(e.target.value) || 0,
                                    )
                                  }
                                  className="h-7 w-16 text-right font-mono font-bold text-xs"
                                />
                                <span className="text-xs text-muted">%</span>
                              </div>
                            ) : (
                              <span className="font-mono font-bold text-accent-strong">
                                {rate.toFixed(2)}%
                              </span>
                            )}
                          </td>

                          {/* Share ratio of pool */}
                          <td className="num px-3 py-3 text-xs text-muted">{shareRatio}%</td>

                          {/* Net commission amount */}
                          <td className="num px-4 py-3 font-bold text-ok text-base">
                            Rs {formatMoney(amount.toFixed(2))}
                          </td>

                          {/* Action */}
                          {canEdit && (
                            <td className="px-2 py-3 text-center">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleRemoveMember(m.id)}
                                className="h-7 w-7 p-0 text-muted hover:text-danger"
                                title="Remove member"
                              >
                                <Trash2 size={14} />
                              </Button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-border bg-surface-2/40 font-bold text-xs">
                      <td className="px-4 py-3" colSpan={2}>
                        Total Allocation ({members.length} members)
                      </td>
                      <td className="num px-3 py-3 text-accent-strong">
                        {totalMemberRatePercent.toFixed(2)}%
                      </td>
                      <td className="num px-3 py-3 text-muted">100.0%</td>
                      <td className="num px-4 py-3 text-ok font-extrabold text-base">
                        Rs {formatMoney(netCommissionPool.toFixed(2))}
                      </td>
                      {canEdit && <td></td>}
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Rate Check Alert */}
              <div className="border-t border-border p-4 flex flex-wrap items-center justify-between gap-3 text-xs bg-surface-2/20">
                <div className="flex items-center gap-2">
                  {totalMemberRatePercent === maxCommissionPercent ? (
                    <Badge tone="ok" className="gap-1">
                      <CheckCircle2 size={12} /> Rates match 100% of max pool (
                      {maxCommissionPercent}%)
                    </Badge>
                  ) : totalMemberRatePercent > maxCommissionPercent ? (
                    <Badge tone="danger" className="gap-1">
                      <AlertCircle size={12} /> Rates ({totalMemberRatePercent}%) exceed max pool (
                      {maxCommissionPercent}%)
                    </Badge>
                  ) : (
                    <Badge tone="warn" className="gap-1">
                      <HelpCircle size={12} /> Rates ({totalMemberRatePercent}%) are under max pool
                      ({maxCommissionPercent}%)
                    </Badge>
                  )}
                </div>

                <div className="text-muted text-[11px]">
                  Formula: Max Commission Pool ({maxCommissionPercent}%) − Fixed Expenses = Net Pool
                  → Distributed by Member %
                </div>
              </div>
            </CardBody>
          </Card>

          {/* Super Admin Save Controls */}
          {canEdit && (
            <Card className="border-accent/40 bg-accent-soft/20">
              <CardBody className="p-4 flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-col gap-1.5 text-xs">
                  <label className="flex items-center gap-2 cursor-pointer font-medium text-muted">
                    <input
                      type="checkbox"
                      checked={syncUserRates}
                      onChange={(e) => setSyncUserRates(e.target.checked)}
                      className="rounded text-accent"
                    />
                    Synchronize commission rates with user accounts in Users &amp; Roles
                  </label>
                </div>

                <Button
                  variant="primary"
                  onClick={() => setSaveDialogOpen(true)}
                  disabled={saveMutation.isPending}
                  className="font-bold gap-2 px-6"
                >
                  <Save size={16} />
                  {saveMutation.isPending ? 'Saving...' : 'Save'}
                </Button>
              </CardBody>
            </Card>
          )}

          {/* Dialog to choose save scope */}
          <Dialog
            open={saveDialogOpen}
            onOpenChange={setSaveDialogOpen}
            title="Save HRM &amp; Commission Settings"
            className="max-w-md"
          >
            <div className="flex flex-col gap-4 py-2">
              <p className="text-sm text-muted">
                Choose how you want to apply these rates and fixed expenses:
              </p>

              <div className="flex flex-col gap-3">
                {/* Option 1: Just for this month */}
                <button
                  type="button"
                  disabled={saveMutation.isPending}
                  onClick={() => {
                    setSaveDialogOpen(false);
                    saveMutation.mutate(false);
                  }}
                  className="flex flex-col gap-1 rounded-xl border border-border p-3.5 text-left transition hover:border-accent hover:bg-accent/5 focus:border-accent focus:outline-none cursor-pointer"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-text text-sm">
                      Save just for this month
                    </span>
                    <span className="rounded bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
                      {MONTHS[selectedMonth - 1]} {selectedYear} only
                    </span>
                  </div>
                  <p className="text-xs text-muted">
                    Applies rates and expenses only to {MONTHS[selectedMonth - 1]} {selectedYear}.
                    Upcoming months remain unchanged.
                  </p>
                </button>

                {/* Option 2: Save for until edit */}
                <button
                  type="button"
                  disabled={saveMutation.isPending}
                  onClick={() => {
                    setSaveDialogOpen(false);
                    saveMutation.mutate(true);
                  }}
                  className="flex flex-col gap-1 rounded-xl border border-accent/60 bg-accent/10 p-3.5 text-left transition hover:border-accent hover:bg-accent/15 focus:border-accent focus:outline-none cursor-pointer"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-accent-strong text-sm">
                      Save until edited
                    </span>
                    <span className="rounded bg-accent/20 px-2 py-0.5 text-[11px] font-semibold text-accent-strong">
                      Future default
                    </span>
                  </div>
                  <p className="text-xs text-muted">
                    Applies to {MONTHS[selectedMonth - 1]} {selectedYear} and becomes the default
                    for future months until edited.
                  </p>
                </button>
              </div>

              <label className="flex items-center gap-2 pt-1 text-xs text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={syncUserRates}
                  onChange={(e) => setSyncUserRates(e.target.checked)}
                  className="rounded text-accent"
                />
                <span>Synchronize commission rates with user accounts in Users &amp; Roles</span>
              </label>

              <div className="flex justify-end pt-2 border-t border-border">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSaveDialogOpen(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
