import { formatDate, formatMoney } from '@aruna/shared';
import { Banknote, Pencil, Printer, Trash2 } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { useConfirm } from '@/components/AskDialog';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { EmptyState, Money, PageHeader, Spinner } from '@/components/ui/misc';
import { api, ApiError, errorMessage, qs } from '@/lib/api';
import type { Supplier } from '@/lib/types';
import { SupplierForm } from './SupplierForm';

interface Ledger {
  supplier: { id: string; code: string; name: string };
  openingBalance: string;
  entries: {
    id: string;
    date: string;
    type: string;
    docNo: string;
    debit: string;
    credit: string;
    balance: string;
    note: string;
  }[];
  closingBalance: string;
}

const TYPES = ['PURCHASE', 'PAYMENT', 'RETURN', 'ADJUSTMENT', 'REVERSAL'] as const;

/**
 * Supplier activity log: the opening balance on the start date, each entry with date, type,
 * document no, debit, credit and running balance, then the closing balance.
 */
export function SupplierLedgerPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [type, setType] = useState('');
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const supplier = useQuery({
    queryKey: ['suppliers', id],
    queryFn: () => api.get<Supplier>(`/api/suppliers/${id}`),
  });
  const ledger = useQuery({
    queryKey: ['suppliers', id, 'ledger', from, to, type],
    queryFn: () => api.get<Ledger>(`/api/suppliers/${id}/ledger${qs({ from, to, types: type })}`),
  });
  const confirm = useConfirm();
  if (!supplier.data) return <Spinner />;
  const s = supplier.data;

  const onDelete = async () => {
    const ok = await confirm({
      title: 'Delete supplier?',
      message: `${s.name} (${s.code}) will be removed. This can't be undone.`,
      confirmLabel: 'Delete supplier',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/suppliers/${s.id}`);
      toast.success(`Supplier "${s.name}" deleted.`);
      await qc.invalidateQueries({ queryKey: ['suppliers'] });
      nav('/stock/suppliers');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={`${s.code} · ${s.name}`}
        description={`${s.phones.join(', ')} · ${s.creditDays} credit days`}
      >
        <span className="mr-2 text-right">
          <span className="block text-xs text-muted">Balance</span>
          <span className="text-xl font-bold">
            Rs <Money value={s.balance} />
          </span>
        </span>
        <div className="flex items-center gap-0.5">
          <IconButton label="Print" icon={<Printer size={17} />} onClick={() => window.print()} />
          {can('suppliers.edit') ? (
            <IconButton
              label={`Edit ${s.name}`}
              icon={<Pencil size={17} />}
              onClick={() => setEditing(true)}
            />
          ) : null}
          {can('suppliers.edit') ? (
            <IconButton
              label={`Delete ${s.name}`}
              tone="danger"
              icon={<Trash2 size={17} />}
              onClick={onDelete}
            />
          ) : null}
        </div>
        {can('supplier_payments.create') ? (
          <Button variant="primary" icon={<Banknote size={16} />} onClick={() => setPaying(true)}>
            Pay supplier
          </Button>
        ) : null}
      </PageHeader>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t.toLowerCase()}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Card className="overflow-hidden">
        {!ledger.data ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Document</th>
                <th className="px-4 py-2 font-medium">Note</th>
                <th className="num px-4 py-2 font-medium">Debit</th>
                <th className="num px-4 py-2 font-medium">Credit</th>
                <th className="num px-4 py-2 font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border bg-surface-2/50">
                <td className="px-4 py-2" colSpan={6}>
                  Opening balance{from ? ` on ${formatDate(from)}` : ''}
                </td>
                <td className="num px-4 py-2 font-medium">
                  <Money value={ledger.data.openingBalance} />
                </td>
              </tr>
              {ledger.data.entries.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="px-4 py-2">{formatDate(e.date)}</td>
                  <td className="px-4 py-2">{e.type.toLowerCase()}</td>
                  <td className="px-4 py-2">{e.docNo}</td>
                  <td className="px-4 py-2 text-muted">{e.note}</td>
                  <td className="num px-4 py-2">{Number(e.debit) ? formatMoney(e.debit) : ''}</td>
                  <td className="num px-4 py-2">{Number(e.credit) ? formatMoney(e.credit) : ''}</td>
                  <td className="num px-4 py-2">
                    <Money value={e.balance} />
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-border font-semibold">
                <td className="px-4 py-2" colSpan={6}>
                  Closing balance
                </td>
                <td className="num px-4 py-2">
                  <Money value={ledger.data.closingBalance} />
                </td>
              </tr>
            </tbody>
          </table>
        )}
        {ledger.data && ledger.data.entries.length === 0 ? (
          <EmptyState title="No entries in this period." />
        ) : null}
      </Card>
      <SupplierForm open={editing} supplier={s} onClose={() => setEditing(false)} />
      <PaymentDialog
        open={paying}
        supplier={s}
        onClose={() => setPaying(false)}
        onDone={() => {
          setPaying(false);
          void qc.invalidateQueries({ queryKey: ['suppliers'] });
        }}
      />
    </div>
  );
}

/** Cash, cheque or bank transfer; oldest bills first; more than the balance becomes an advance. */
function PaymentDialog({
  open,
  supplier,
  onClose,
  onDone,
}: {
  open: boolean;
  supplier: Supplier;
  onClose: () => void;
  onDone: () => void;
}) {
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const [f, setF] = useState({
    method: 'CASH',
    amount: '',
    date: today,
    reference: '',
    note: '',
    number: '',
    bank: '',
    chequeDate: today,
  });
  const [warning, setWarning] = useState('');
  const [error, setError] = useState('');
  const pay = async (confirmAdvance = false) => {
    setError('');
    try {
      const r = await api.post<{ no: string; balance: string; advance: string }>(
        '/api/supplier-payments',
        {
          supplierId: supplier.id,
          date: f.date,
          method: f.method,
          amount: f.amount,
          reference: f.reference,
          note: f.note,
          cheque:
            f.method === 'CHEQUE'
              ? { number: f.number, bank: f.bank, chequeDate: f.chequeDate }
              : undefined,
          confirmAdvance,
        },
      );
      toast.success(`${r.no} recorded. Balance now Rs ${formatMoney(r.balance)}.`);
      setWarning('');
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.isWarning) setWarning(err.message);
      else setError(errorMessage(err));
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void pay();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={`Pay ${supplier.name}`}
      description={`Balance Rs ${formatMoney(supplier.balance)}. Payments settle the oldest bills first.`}
    >
      <form onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Method">
          <Select
            autoFocus
            value={f.method}
            onChange={(e) => setF({ ...f, method: e.target.value })}
          >
            <option value="CASH">Cash</option>
            <option value="CHEQUE">Cheque</option>
            <option value="BANK_TRANSFER">Bank transfer</option>
          </Select>
        </Field>
        <Field label="Amount (Rs)">
          <Input
            className="num"
            value={f.amount}
            onChange={(e) => setF({ ...f, amount: e.target.value })}
          />
        </Field>
        <Field label="Date">
          <Input
            type="date"
            value={f.date}
            onChange={(e) => setF({ ...f, date: e.target.value })}
          />
        </Field>
        <Field label="Reference">
          <Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </Field>
        {f.method === 'CHEQUE' ? (
          <>
            <Field label="Cheque no">
              <Input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
            </Field>
            <Field label="Bank">
              <Input value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })} />
            </Field>
            <Field label="Cheque date" hint="Post-dated cheques go to the cheque register.">
              <Input
                type="date"
                value={f.chequeDate}
                onChange={(e) => setF({ ...f, chequeDate: e.target.value })}
              />
            </Field>
          </>
        ) : null}
        <Field label="Note" className="col-span-2">
          <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
        {warning ? (
          <div className="col-span-2 rounded-[8px] bg-warn-soft p-3 text-sm text-warn">
            {warning}
            <div className="mt-2">
              <Button type="button" size="sm" variant="primary" onClick={() => void pay(true)}>
                Record with an advance
              </Button>
            </div>
          </div>
        ) : null}
        {error ? <p className="col-span-2 text-sm text-danger">{error}</p> : null}
        <div className="col-span-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!f.amount}>
            Record payment
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
