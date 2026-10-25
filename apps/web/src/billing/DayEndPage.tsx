import { DENOMINATIONS, D, formatDate, formatMoney, formatTime } from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { EmptyState, Money, PageHeader } from '@/components/ui/misc';
import { useReasons } from '@/components/values';
import { api, errorMessage } from '@/lib/api';
import type { ShiftSummary } from '@/lib/types';
import { StartDayDialog } from './StartDayDialog';

/**
 * Day end: cash in and out during the day with a reason, the expected cash, then the cashier
 * counts notes and coins and any difference is recorded. The report prints, then a backup runs.
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
    queryKey: ['shifts-today'],
    queryFn: () => api.get<{ items: ShiftSummary[] }>('/api/shifts'),
    enabled: can('day_end.view'),
  });
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [startOpen, setStartOpen] = useState(false);
  const shift = current.data?.shift ?? null;
  const counted = DENOMINATIONS.reduce((s, d) => s.plus(D(d).times(Number(counts[d] || 0))), D(0));
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['shift-current'] });
    void qc.invalidateQueries({ queryKey: ['shifts-today'] });
    void qc.invalidateQueries({ queryKey: ['billing-status'] });
  };

  const close = async () => {
    try {
      const denominations = Object.fromEntries(
        DENOMINATIONS.map((d) => [d, Number(counts[d] || 0)]).filter(([, n]) => Number(n) > 0),
      );
      const r = await api.post<{
        summary: ShiftSummary;
        heldBills: number;
        print: { printed: boolean };
      }>('/api/shifts/current/close', { denominations, note });
      toast.success(
        `Day end ${r.summary.no} done. Difference Rs ${formatMoney(r.summary.difference)}.`,
      );
      if (r.heldBills)
        toast.warning(`${r.heldBills} held bills are still waiting on this counter.`);
      setCounts({});
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <PageHeader
        title="Day end"
        description={
          me.counter
            ? `${me.counter.name} · ${formatDate(new Date())}`
            : 'Open this page on a counter PC to close its day.'
        }
      />
      {me.counter && !current.isLoading && !shift ? (
        <Card>
          <CardBody className="flex items-center justify-between gap-4">
            <span>The day is not open on this counter.</span>
            <Button variant="primary" onClick={() => setStartOpen(true)}>
              Start the day
            </Button>
          </CardBody>
        </Card>
      ) : null}
      {shift ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{shift.no}</CardTitle>
              <Badge tone="ok">Open since {formatTime(shift.openedAt)}</Badge>
            </CardHeader>
            <CardBody>
              <dl className="grid grid-cols-2 gap-y-2">
                <dt className="text-muted">Opening float</dt>
                <dd className="num">
                  <Money value={shift.openingFloat} />
                </dd>
                <dt className="text-muted">Cash sales ({shift.billCount} bills)</dt>
                <dd className="num">
                  <Money value={shift.cashSales} />
                </dd>
                <dt className="text-muted">Refunds ({shift.returnCount})</dt>
                <dd className="num">
                  <Money value={-Number(shift.cashRefunds)} />
                </dd>
                <dt className="text-muted">Cash in</dt>
                <dd className="num">
                  <Money value={shift.cashIn} />
                </dd>
                <dt className="text-muted">Cash out</dt>
                <dd className="num">
                  <Money value={-Number(shift.cashOut)} />
                </dd>
                <dt className="border-t border-border pt-2 font-semibold">Expected cash</dt>
                <dd className="num border-t border-border pt-2 text-lg font-bold">
                  <Money value={shift.expectedCash} />
                </dd>
              </dl>
              {shift.movements.length ? (
                <ul className="mt-4 divide-y divide-border text-sm">
                  {shift.movements.map((m) => (
                    <li key={m.id} className="flex justify-between py-1.5">
                      <span>
                        {formatTime(m.at)} · {m.reason}
                        {m.note ? ` · ${m.note}` : ''} · {m.by}
                      </span>
                      <Money value={m.kind === 'IN' ? m.amount : -Number(m.amount)} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {can('day_end.create') ? <CashMovementForm onDone={refresh} /> : null}
            </CardBody>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Count the drawer</CardTitle>
            </CardHeader>
            <CardBody>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {DENOMINATIONS.map((d, i) => (
                  <label key={d} className="flex items-center gap-2 text-sm">
                    <span className="w-14 text-right font-medium">
                      {Number(d).toLocaleString()}
                    </span>
                    ×
                    <Input
                      autoFocus={i === 0}
                      inputMode="numeric"
                      className="num h-9"
                      value={counts[d] ?? ''}
                      onChange={(e) =>
                        setCounts({ ...counts, [d]: e.target.value.replace(/\D/g, '') })
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="mt-4 flex items-baseline justify-between">
                <span className="text-muted">Counted</span>
                <span className="num text-2xl font-bold">Rs {formatMoney(counted)}</span>
              </div>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="text-muted">Difference</span>
                <span
                  className={`num text-lg font-semibold ${counted.minus(D(shift.expectedCash)).isZero() ? 'text-ok' : 'text-warn'}`}
                >
                  Rs {formatMoney(counted.minus(D(shift.expectedCash)))}
                </span>
              </div>
              <Field label="Note" className="mt-3">
                <Input value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <Button
                variant="primary"
                className="mt-4 w-full"
                onClick={() => void close()}
                disabled={!can('day_end.create')}
              >
                Finish the day and print the report
              </Button>
            </CardBody>
          </Card>
        </div>
      ) : null}

      {can('day_end.view') ? (
        <Card>
          <CardHeader>
            <CardTitle>Today's day ends</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {(today.data?.items ?? []).length === 0 ? (
              <EmptyState title="No days opened today." />
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-left text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">Counter</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="num px-4 py-2 font-medium">Bills</th>
                    <th className="num px-4 py-2 font-medium">Cash sales</th>
                    <th className="num px-4 py-2 font-medium">Expected</th>
                    <th className="num px-4 py-2 font-medium">Counted</th>
                    <th className="num px-4 py-2 font-medium">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {today.data!.items.map((s) => (
                    <tr key={s.id} className="border-t border-border">
                      <td className="px-4 py-2">{s.counter.name}</td>
                      <td className="px-4 py-2">
                        {s.status === 'OPEN' ? (
                          <Badge tone="ok">Open</Badge>
                        ) : (
                          <Badge>Closed by {s.closedBy}</Badge>
                        )}
                      </td>
                      <td className="num px-4 py-2">{s.billCount}</td>
                      <td className="num px-4 py-2">
                        <Money value={s.cashSales} />
                      </td>
                      <td className="num px-4 py-2">
                        <Money value={s.expectedCash} />
                      </td>
                      <td className="num px-4 py-2">
                        {s.countedCash ? <Money value={s.countedCash} /> : '—'}
                      </td>
                      <td className="num px-4 py-2">
                        {s.difference ? <Money value={s.difference} /> : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      ) : null}
      <StartDayDialog
        open={startOpen}
        onClose={() => setStartOpen(false)}
        onDone={() => (setStartOpen(false), refresh())}
      />
    </div>
  );
}

function CashMovementForm({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState<'IN' | 'OUT'>('OUT');
  const reasons = useReasons(kind === 'IN' ? 'CASH_IN' : 'CASH_OUT');
  const [reasonId, setReasonId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/api/shifts/current/cash', {
        kind,
        amount,
        reasonId: reasonId || reasons[0]?.id,
        note,
      });
      setAmount('');
      setNote('');
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
      <div className="text-sm font-semibold">Cash in or out</div>
      <div className="grid grid-cols-[100px_1fr_120px] gap-2">
        <Select
          aria-label="In or out"
          value={kind}
          onChange={(e) => setKind(e.target.value as 'IN' | 'OUT')}
        >
          <option value="OUT">Out</option>
          <option value="IN">In</option>
        </Select>
        <Select aria-label="Reason" value={reasonId} onChange={(e) => setReasonId(e.target.value)}>
          {reasons.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
        <Input
          aria-label="Amount"
          placeholder="Rs"
          inputMode="decimal"
          className="num"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <Input
        aria-label="Note"
        placeholder="Note, e.g. tea for staff"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button type="submit" size="sm" disabled={!amount}>
        Record
      </Button>
    </form>
  );
}
