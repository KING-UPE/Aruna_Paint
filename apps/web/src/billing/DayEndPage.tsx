import { D, formatDate, formatMoney, formatTime } from '@aruna/shared';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Printer } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { IconButton } from '@/components/ui/icon-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, Money, PageHeader } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import type { ShiftSummary } from '@/lib/types';

/**
 * Day End: the shop's sales today, with each user's bills and refunds (every PC is the same, so
 * sales are told apart by who made them). Days need no finishing (the shop asked for no Finish
 * day button) and there is no cash drawer: a day opens with its first bill and closes by itself
 * when the next day starts. The report prints when asked, today's or any recent day's.
 */
export function DayEndPage() {
  const { can } = useAuth();
  const current = useQuery({
    queryKey: ['shift-current'],
    queryFn: () => api.get<{ shift: ShiftSummary | null }>('/api/shifts/current'),
  });
  const today = useQuery({
    queryKey: ['shifts-today', 'recent'],
    queryFn: () => api.get<{ items: ShiftSummary[] }>('/api/shifts?recent=1'),
    enabled: can('day_end.view'),
  });
  const printReport = async (s: ShiftSummary) => {
    try {
      const r = await api.post<{ print: { printed: boolean; error?: string } }>(
        `/api/shifts/${s.id}/print`,
      );
      if (r.print.printed) toast.success(`Day end ${s.no} sent to the printer.`);
      else
        toast.warning(`Not printed: ${r.print.error ?? 'no receipt printer is set in Settings'}.`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const shift = current.data?.shift ?? null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader
        title="Day End"
        description={`${formatDate(new Date())} · the day opens with the first bill and closes by itself when the next day starts`}
      />

      {!current.isLoading && !shift ? (
        <Card>
          <CardBody className="text-muted">No bills yet today.</CardBody>
        </Card>
      ) : null}

      {shift ? (
        <Card className="w-full">
          <CardHeader className="flex flex-row items-center justify-between border-b border-border/80 pb-3">
            <div>
              <CardTitle>Today's Sales Summary</CardTitle>
              <div className="text-xs text-muted mt-0.5">Ref: {shift.no}</div>
            </div>
            <Badge tone="ok">Open since {formatTime(shift.openedAt)}</Badge>
          </CardHeader>
          <CardBody className="flex flex-col gap-5 pt-5">
            {/* Main Total Sales Banner */}
            <div className="rounded-xl border border-accent/30 bg-accent-soft/30 p-5">
              <div className="text-sm font-semibold uppercase tracking-wider text-accent-strong">
                Total Day Sales
              </div>
              <div className="num text-4xl font-extrabold text-text mt-1.5">
                Rs {formatMoney(shift.cashSales)}
              </div>
              <div className="text-xs text-muted mt-1.5">
                Calculated from {shift.billCount} completed{' '}
                {shift.billCount === 1 ? 'bill' : 'bills'}
              </div>
            </div>

            {/* Breakdown List */}
            <dl className="grid grid-cols-2 gap-y-3 text-sm">
              <dt className="text-muted">Completed Bills / Invoices</dt>
              <dd className="num font-semibold text-right text-text">{shift.billCount}</dd>

              <dt className="text-muted">Refunds & Returns</dt>
              <dd className="num font-semibold text-right text-text">
                {Number(shift.cashRefunds) > 0 ? (
                  <span className="text-danger">
                    -Rs {formatMoney(shift.cashRefunds)} ({shift.returnCount})
                  </span>
                ) : (
                  'Rs 0.00'
                )}
              </dd>

              <dt className="border-t border-border pt-3 font-bold text-text">Net Sales</dt>
              <dd className="num border-t border-border pt-3 text-right text-xl font-bold text-accent-strong">
                Rs {formatMoney(D(shift.cashSales).minus(D(shift.cashRefunds)))}
              </dd>
            </dl>

            {shift.byUser.length ? (
              <table className="w-full text-sm">
                <thead className="text-left text-muted">
                  <tr className="border-b border-border">
                    <th className="py-2 font-medium">User</th>
                    <th className="num py-2 font-medium">Bills</th>
                    <th className="num py-2 font-medium">Sales</th>
                    <th className="num py-2 font-medium">Refunds</th>
                    <th className="num py-2 font-medium">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {shift.byUser.map((u) => (
                    <tr key={u.userId} className="border-b border-border/60">
                      <td className="py-2 font-medium">{u.name}</td>
                      <td className="num py-2">{u.bills}</td>
                      <td className="num py-2">
                        <Money value={u.sales} />
                      </td>
                      <td className="num py-2">
                        {Number(u.refunds) > 0 ? (
                          <span className="text-danger">-Rs {formatMoney(u.refunds)}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="num py-2 font-semibold">
                        <Money value={u.net} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}

            <Button
              size="lg"
              icon={<Printer size={18} />}
              className="self-start"
              onClick={() => void printReport(shift)}
            >
              Print today&apos;s report
            </Button>
          </CardBody>
        </Card>
      ) : null}

      {can('day_end.view') ? (
        <Card>
          <CardHeader>
            <CardTitle>Recent day ends</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {(today.data?.items ?? []).length === 0 ? (
              <EmptyState title="No day ends yet." />
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-left text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">Ref No</th>
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="num px-4 py-2 font-medium">Bills</th>
                    <th className="num px-4 py-2 font-medium">Total Sales</th>
                    <th className="px-4 py-2 font-medium">Closed By</th>
                    <th className="px-2 py-2">
                      <span className="sr-only">Print</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {today.data!.items.map((s) => (
                    <tr key={s.id} className="border-t border-border">
                      <td className="px-4 py-2 font-mono font-medium">{s.no}</td>
                      <td className="px-4 py-2 text-muted">{formatDate(s.businessDate)}</td>
                      <td className="px-4 py-2">
                        {s.status === 'OPEN' ? (
                          <Badge tone="ok">Open</Badge>
                        ) : (
                          <Badge tone="neutral">Closed</Badge>
                        )}
                      </td>
                      <td className="num px-4 py-2">{s.billCount}</td>
                      <td className="num px-4 py-2 font-semibold text-text">
                        <Money value={s.cashSales} />
                      </td>
                      <td className="px-4 py-2 text-muted">{s.closedBy || '—'}</td>
                      <td className="px-2 py-1 text-right">
                        <IconButton
                          label={`Print day end ${s.no}`}
                          icon={<Printer size={16} />}
                          onClick={() => void printReport(s)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
