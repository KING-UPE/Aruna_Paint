import { D, formatDate, formatMoney, formatTime } from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Printer } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { IconButton } from '@/components/ui/icon-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { EmptyState, Money, PageHeader } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { arrowNav } from '@/lib/arrowNav';
import type { ShiftSummary } from '@/lib/types';

/**
 * Day End: the day's sales, completed bills and net totals. Finishing is optional: a day left
 * open closes by itself when the counter starts the next day. The report prints only when asked,
 * and any recent day end can be printed again.
 */
export function DayEndPage() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const current = useQuery({
    queryKey: ['shift-current'],
    queryFn: () => api.get<{ shift: ShiftSummary | null }>('/api/shifts/current'),
    enabled: Boolean(me.counter),
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
      else toast.warning(`Not printed: ${r.print.error ?? 'no printer is set for this counter'}.`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const shift = current.data?.shift ?? null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['shift-current'] });
    void qc.invalidateQueries({ queryKey: ['shifts-today'] });
    void qc.invalidateQueries({ queryKey: ['billing-status'] });
  };

  const close = async (print: boolean) => {
    setBusy(true);
    try {
      const r = await api.post<{
        summary: ShiftSummary;
        heldBills: number;
        print: { printed: boolean; error?: string; skipped?: boolean };
      }>('/api/shifts/current/close', { note, print });
      if (print && !r.print.printed)
        toast.warning(`Not printed: ${r.print.error ?? 'no printer is set for this counter'}.`);
      toast.success(
        `Day end ${r.summary.no} finished. Total sales: Rs ${formatMoney(r.summary.cashSales)}.`,
      );
      if (r.heldBills) toast.warning(`${r.heldBills} held bills are still waiting.`);
      setNote('');
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader
        title="Day End Sales Calculation"
        description={`${formatDate(new Date())} · a day not finished here closes by itself when the counter starts the next day`}
      />

      {!current.isLoading && !shift ? (
        <Card>
          <CardBody className="flex items-center justify-between gap-4">
            <span className="text-muted">The day is not started yet.</span>
            <Button
              variant="primary"
              onClick={async () => {
                await api.post('/api/shifts/open', { openingFloat: '0' });
                refresh();
              }}
            >
              Start the day
            </Button>
          </CardBody>
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

            <Field label="Closing Note (optional)">
              <Input
                placeholder="Optional notes or remarks for today..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>

            <div className="flex flex-col gap-2 sm:flex-row" onKeyDown={arrowNav}>
              <Button
                variant="primary"
                size="lg"
                className="flex-1 text-base font-semibold"
                onClick={() => void close(false)}
                disabled={busy || !can('day_end.create')}
              >
                {busy ? 'Finishing…' : 'Finish day'}
              </Button>
              <Button
                size="lg"
                icon={<Printer size={18} />}
                onClick={() => void close(true)}
                disabled={busy || !can('day_end.create')}
              >
                Finish &amp; print report
              </Button>
            </div>
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
