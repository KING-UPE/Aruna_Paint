import { D, formatDate, formatDateTime, formatMoney, formatQty, formatRs } from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Receipt, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { useAsk } from '@/components/AskDialog';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { EmptyState, Money, Spinner } from '@/components/ui/misc';
import { useHotkeys, useKeyLabel } from '@/keyboard/keymap';
import { api, errorMessage, qs } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import type { Page, SaleDetail, SaleListItem } from '@/lib/types';
import { cn } from '@/lib/utils';
import { PayDialog } from './PayDialog';
import { ReturnDialog } from './ReturnDialog';
import { VoidDialog } from './VoidDialog';

/**
 * Bill history: search by invoice or quotation no (letters or digits, any part), date range,
 * customer name or amount. Keys on a selected bill: P reprint, R return, C convert, V void,
 * D delete a quotation. Deleted held bills and quotations are kept and listed under Deleted.
 */
export function HistoryPanel({
  inDialog = false,
  initialOpenId,
}: {
  inDialog?: boolean;
  initialOpenId?: string | null;
}) {
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const ask = useAsk();
  const [type, setType] = useState<'INVOICE' | 'QUOTATION' | 'ALL' | 'DELETED'>('INVOICE');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [hi, setHi] = useState(0);
  const [returnFor, setReturnFor] = useState<string | null>(null);
  const [voidFor, setVoidFor] = useState<{ id: string; no: string } | null>(null);
  const [convertFor, setConvertFor] = useState<SaleListItem | null>(null);
  const [convertError, setConvertError] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const term = useDebounced(q.trim(), 200);
  const isAmount = /^\d+(\.\d{1,2})?$/.test(term) && term.includes('.');
  const list = useQuery({
    queryKey: ['bill-history', type, term, from, to],
    queryFn: () =>
      api.get<Page<SaleListItem>>(
        `/api/sales${qs({
          kind: type === 'ALL' || type === 'DELETED' ? undefined : type,
          status: type === 'DELETED' ? 'DELETED' : undefined,
          q: isAmount ? undefined : /\d/.test(term) ? term : undefined,
          customer: /\d/.test(term) ? undefined : term,
          amount: isAmount ? term : undefined,
          from,
          to,
          pageSize: 50,
        })}`,
      ),
  });
  const items = list.data?.items ?? [];
  const billCount = list.data?.total ?? items.length;
  const totalSum =
    list.data?.totalAmount !== undefined
      ? list.data.totalAmount
      : items
          .reduce((sum, item) => (item.status === 'VOID' ? sum : sum.plus(D(item.netTotal))), D(0))
          .toFixed(2);
  const selected = items[Math.min(hi, items.length - 1)];
  const [detailId, setDetailId] = useState<string | null>(initialOpenId ?? null);
  useEffect(() => {
    if (selected && !initialOpenId) setDetailId(selected.id);
  }, [selected?.id, initialOpenId]);
  const detail = useQuery({
    queryKey: ['sale', detailId],
    queryFn: () => api.get<SaleDetail>(`/api/sales/${detailId}`),
    enabled: Boolean(detailId),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bill-history'] });
    void qc.invalidateQueries({ queryKey: ['sale'] });
    void qc.invalidateQueries({ queryKey: ['billing-status'] });
  };

  const actOn = () => (detail.data && detail.data.id === detailId ? detail.data : null);
  const reprint = async () => {
    const s = actOn();
    // A deleted quotation is kept for the record, not handed out again.
    if (!s || !s.no || s.status === 'DELETED') return;
    try {
      const r = await api.post<{ copyNo: number; print: { printed: boolean; error?: string } }>(
        `/api/sales/${s.id}/reprint`,
      );
      if (r.print.printed) toast.success(`Reprint #${r.copyNo} of ${s.no} sent to the printer.`);
      else
        toast.warning(
          `Reprint #${r.copyNo} logged. ${r.print.error ?? 'No printer is set for this counter.'}`,
        );
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const ret = () => {
    const s = actOn();
    if (s?.kind === 'INVOICE' && s.status === 'COMPLETED' && can('returns.create'))
      setReturnFor(s.id);
  };
  const conv = () => {
    const s = items.find((i) => i.id === detailId);
    if (s?.kind === 'QUOTATION' && !s.convertedTo && can('billing.create') && me.counter)
      setConvertFor(s);
  };
  const voidIt = () => {
    const s = actOn();
    if (s?.kind === 'INVOICE' && s.status === 'COMPLETED' && s.no)
      setVoidFor({ id: s.id, no: s.no });
  };
  const canDeleteQuotation = (s: SaleDetail | null) =>
    s?.kind === 'QUOTATION' &&
    s.status === 'COMPLETED' &&
    !s.convertedTo &&
    can('quotations.create');
  // A quotation is never erased: it keeps its number and moves to Deleted with the reason.
  const deleteQuotation = async () => {
    const s = actOn();
    if (!s || !canDeleteQuotation(s)) return;
    const reason = await ask({
      title: `Delete quotation ${s.no}?`,
      message: 'It stays in bill history under Deleted, with your name and the reason.',
      label: 'Why is it being deleted?',
      confirmLabel: 'Delete quotation',
      check: (v) => (v.length < 3 ? 'Say why, in a few words.' : null),
      danger: true,
      returnFocus: () => listRef.current,
    });
    if (!reason) return;
    try {
      await api.post(`/api/sales/${s.id}/delete-quotation`, { reason });
      toast.success(`Quotation ${s.no} deleted. It is listed under Deleted.`);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  useHotkeys(
    'bill_history',
    {
      reprint: () => void reprint(),
      return: ret,
      convert: conv,
      void: voidIt,
      deleteQuotation: () => void deleteQuotation(),
    },
    { inDialog },
  );
  const keys = {
    reprint: useKeyLabel('bill_history', 'reprint'),
    ret: useKeyLabel('bill_history', 'return'),
    convert: useKeyLabel('bill_history', 'convert'),
    void: useKeyLabel('bill_history', 'void'),
    del: useKeyLabel('bill_history', 'deleteQuotation'),
  };

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col gap-2.5">
        {/* Type Selector: 1 Sales Bills, 2 Quotation Bills, 3 All Bills */}
        <div className="flex items-center gap-1 rounded-xl border border-border bg-surface-2/60 p-1">
          <button
            type="button"
            onClick={() => {
              setType('INVOICE');
              setHi(0);
            }}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-center text-xs font-semibold transition',
              type === 'INVOICE'
                ? 'bg-surface text-accent-strong shadow-sm'
                : 'text-muted hover:text-text',
            )}
          >
            <Receipt size={14} />
            <span>Sales Bills</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setType('QUOTATION');
              setHi(0);
            }}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-center text-xs font-semibold transition',
              type === 'QUOTATION'
                ? 'bg-surface text-warn shadow-sm'
                : 'text-muted hover:text-text',
            )}
          >
            <FileText size={14} />
            <span>Quotation Bills</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setType('ALL');
              setHi(0);
            }}
            className={cn(
              'flex-1 rounded-lg py-1.5 text-center text-xs font-semibold transition',
              type === 'ALL' ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text',
            )}
          >
            All Bills
          </button>
          <button
            type="button"
            onClick={() => {
              setType('DELETED');
              setHi(0);
            }}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-center text-xs font-semibold transition',
              type === 'DELETED'
                ? 'bg-surface text-danger shadow-sm'
                : 'text-muted hover:text-text',
            )}
          >
            <Trash2 size={14} />
            <span>Deleted</span>
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <Input
            autoFocus
            aria-label="Search bills"
            placeholder={
              type === 'QUOTATION'
                ? 'Quotation no, customer, or amount...'
                : type === 'INVOICE'
                  ? 'Invoice no, customer, or amount...'
                  : 'Bill no, customer, or amount like 6325.00 · Enter goes to list'
            }
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setHi(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHi((h) => Math.min(items.length - 1, h + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHi((h) => Math.max(0, h - 1));
              } else if (e.key === 'Enter') {
                // Enter moves to the list, where P, R, C and V act on the selected bill.
                e.preventDefault();
                listRef.current?.focus();
              }
            }}
            className="min-w-48 flex-1"
          />
          <Input
            type="date"
            aria-label="From"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-40"
          />
          <Input
            type="date"
            aria-label="To"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-40"
          />
        </div>
        <div
          ref={listRef}
          tabIndex={0}
          aria-label="Bills"
          className="min-h-0 flex-1 overflow-y-auto rounded-[var(--radius-card)] border border-border outline-none focus-visible:outline-2"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHi((h) => Math.min(items.length - 1, h + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHi((h) => Math.max(0, h - 1));
            }
          }}
        >
          {list.isLoading ? (
            <div className="p-6">
              <Spinner />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              title={
                type === 'QUOTATION'
                  ? 'No quotation bills found.'
                  : type === 'INVOICE'
                    ? 'No sales bills found.'
                    : type === 'DELETED'
                      ? 'Nothing has been deleted.'
                      : 'No bills found.'
              }
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface-2 text-left text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">
                    {type === 'QUOTATION'
                      ? 'Quotation No'
                      : type === 'INVOICE'
                        ? 'Invoice No'
                        : 'Bill No'}
                  </th>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="num px-3 py-2 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {items.map((s, i) => (
                  <tr
                    key={s.id}
                    onClick={() => {
                      setHi(i);
                      setDetailId(s.id);
                    }}
                    className={cn(
                      'cursor-pointer border-t border-border',
                      i === hi && 'bg-selected',
                    )}
                  >
                    <td className="px-3 py-2 font-medium">
                      <span className="font-mono">{s.no ?? 'Held bill'}</span>{' '}
                      {s.status === 'VOID' ? <Badge tone="danger">VOID</Badge> : null}
                      {s.status === 'DELETED' ? <Badge tone="danger">Deleted</Badge> : null}
                      {s.kind === 'QUOTATION' ? (
                        <Badge tone="accent">
                          {s.convertedTo ? `Converted → ${s.convertedTo}` : 'Quotation'}
                        </Badge>
                      ) : type === 'ALL' ? (
                        <Badge tone="neutral">Sale</Badge>
                      ) : null}
                      {Number(s.refundedTotal) > 0 ? <Badge tone="warn">Returned</Badge> : null}
                      {s.wholesale ? <Badge>Wholesale</Badge> : null}
                    </td>
                    <td className="px-3 py-2 text-muted">
                      {formatDateTime(s.deleted?.at ?? s.completedAt ?? s.createdAt)}
                      {s.deleted ? <div className="text-xs">by {s.deleted.by}</div> : null}
                    </td>
                    <td className="px-3 py-2">{s.customerName}</td>
                    <td className="num px-3 py-2">
                      <Money value={s.netTotal} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-col gap-2.5">
        <div className="min-h-0 flex-1 overflow-y-auto rounded-[var(--radius-card)] border border-border bg-surface p-4">
          {!detail.data ? (
            <EmptyState title="Pick a bill to see it." />
          ) : (
            <BillDetail
              sale={detail.data}
              actions={
                <div className="flex flex-wrap gap-2 text-sm">
                  {detail.data.no && detail.data.status !== 'DELETED' ? (
                    <ActionHint k={keys.reprint} label="Reprint" onClick={() => void reprint()} />
                  ) : null}
                  {detail.data.kind === 'INVOICE' && detail.data.status === 'COMPLETED' ? (
                    <>
                      <ActionHint k={keys.ret} label="Return" onClick={ret} />
                      <ActionHint k={keys.void} label="Void" onClick={voidIt} />
                    </>
                  ) : null}
                  {detail.data.kind === 'QUOTATION' &&
                  detail.data.status === 'COMPLETED' &&
                  !detail.data.convertedTo ? (
                    <ActionHint k={keys.convert} label="Convert to invoice" onClick={conv} />
                  ) : null}
                  {canDeleteQuotation(detail.data) ? (
                    <ActionHint
                      k={keys.del}
                      label="Delete quotation"
                      danger
                      icon={<Trash2 size={14} />}
                      onClick={() => void deleteQuotation()}
                    />
                  ) : null}
                </div>
              }
            />
          )}
        </div>

        {/* Right bottom corner: Total summary card */}
        <div
          className={cn(
            'flex shrink-0 items-center justify-between rounded-xl border px-4 py-3 shadow-sm transition',
            type === 'INVOICE'
              ? 'border-accent/40 bg-accent/5'
              : type === 'QUOTATION'
                ? 'border-warn/40 bg-warn-soft/40'
                : type === 'DELETED'
                  ? 'border-danger/30 bg-danger-soft/40'
                  : 'border-border bg-surface-2/70',
          )}
        >
          <div className="flex items-center gap-2.5">
            <div
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-lg',
                type === 'INVOICE'
                  ? 'bg-accent/15 text-accent-strong'
                  : type === 'QUOTATION'
                    ? 'bg-warn-soft text-warn'
                    : type === 'DELETED'
                      ? 'bg-danger-soft text-danger'
                      : 'bg-muted/15 text-text',
              )}
            >
              {type === 'INVOICE' ? (
                <Receipt size={18} />
              ) : type === 'QUOTATION' ? (
                <FileText size={18} />
              ) : type === 'DELETED' ? (
                <Trash2 size={18} />
              ) : (
                <Receipt size={18} />
              )}
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted">
                {type === 'INVOICE'
                  ? 'Sales Bills Total'
                  : type === 'QUOTATION'
                    ? 'Quotation Bills Total'
                    : type === 'DELETED'
                      ? 'Deleted (not counted as sales)'
                      : 'All Bills Total'}
              </div>
              <div className="text-xs text-muted">
                {billCount}{' '}
                {billCount === 1
                  ? type === 'QUOTATION'
                    ? 'quotation'
                    : 'bill'
                  : type === 'QUOTATION'
                    ? 'quotations'
                    : 'bills'}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div
              className={cn(
                'num text-xl font-bold tracking-tight',
                type === 'INVOICE'
                  ? 'text-accent-strong'
                  : type === 'QUOTATION'
                    ? 'text-warn'
                    : type === 'DELETED'
                      ? 'text-danger'
                      : 'text-text',
              )}
            >
              {formatRs(totalSum)}
            </div>
          </div>
        </div>
      </div>

      <ReturnDialog
        saleId={returnFor}
        onClose={() => setReturnFor(null)}
        onDone={() => {
          setReturnFor(null);
          refresh();
        }}
      />
      <VoidDialog
        sale={voidFor}
        onClose={() => setVoidFor(null)}
        onDone={() => {
          setVoidFor(null);
          refresh();
        }}
      />
      <PayDialog
        open={Boolean(convertFor)}
        kind="INVOICE"
        netTotal={convertFor?.netTotal ?? '0'}
        busy={busy}
        error={convertError}
        onClose={() => {
          setConvertFor(null);
          setConvertError('');
        }}
        onConfirm={async (cashGiven, print) => {
          setBusy(true);
          try {
            const r = await api.post<{ no: string; change: string }>(
              `/api/sales/${convertFor!.id}/convert`,
              { cashGiven, print },
            );
            toast.success(`${r.no} · change Rs ${formatMoney(r.change)}`);
            setConvertFor(null);
            refresh();
          } catch (err) {
            setConvertError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

/** An action on the selected bill: its key, and a button for the mouse. */
function ActionHint({
  k,
  label,
  onClick,
  danger,
  icon,
}: {
  k: string;
  label: string;
  onClick?: () => void;
  danger?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-[8px] border px-2 py-1 transition-colors',
        danger
          ? 'border-danger/40 text-danger hover:bg-danger-soft'
          : 'border-border hover:bg-surface-2',
      )}
    >
      {icon}
      <Kbd>{k}</Kbd> {label}
    </button>
  );
}

export function BillDetail({ sale, actions }: { sale: SaleDetail; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-lg font-semibold">
            {sale.no
              ? `${sale.kind === 'QUOTATION' ? 'Quotation' : 'Invoice'} ${sale.no}`
              : `Held ${sale.kind === 'QUOTATION' ? 'quotation' : 'bill'}`}{' '}
            {sale.status === 'VOID' ? <Badge tone="danger">VOID</Badge> : null}
            {sale.status === 'DELETED' ? <Badge tone="danger">Deleted</Badge> : null}
            {sale.wholesale ? <Badge>Wholesale</Badge> : null}
          </div>
          <div className="text-sm text-muted">
            {sale.completedAt
              ? formatDateTime(sale.completedAt)
              : `Held ${formatDateTime(sale.createdAt)}`}{' '}
            · {sale.cashier}
            {sale.customerName ? ` · ${sale.customerName}` : ''}
            {sale.validUntil ? ` · valid until ${formatDate(sale.validUntil)}` : ''}
          </div>
        </div>
        <div className="text-right">
          <div className="num text-2xl font-bold">Rs {formatMoney(sale.netTotal)}</div>
          {sale.cashGiven ? (
            <div className="text-sm text-muted">
              Cash {formatMoney(sale.cashGiven)} · change {formatMoney(sale.change)}
            </div>
          ) : null}
        </div>
      </div>
      {actions}
      {sale.deleted ? (
        <p className="rounded-[8px] bg-danger-soft px-3 py-2 text-sm text-danger">
          Deleted by {sale.deleted.by} · {formatDateTime(sale.deleted.at)} · {sale.deleted.reason}
        </p>
      ) : null}
      {sale.void ? (
        <p className="rounded-[8px] bg-danger-soft px-3 py-2 text-sm text-danger">
          Voided by {sale.void.by}
          {sale.void.approver && sale.void.approver !== sale.void.by
            ? `, approved by ${sale.void.approver}`
            : ''}{' '}
          · {sale.void.reason}
          {sale.void.note ? ` · ${sale.void.note}` : ''}
        </p>
      ) : null}
      <table className="w-full text-sm">
        <thead className="text-left text-muted">
          <tr>
            <th className="py-1 font-medium">Item</th>
            <th className="num font-medium">Price</th>
            <th className="num font-medium">Disc</th>
            <th className="num font-medium">Qty</th>
            <th className="num font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {sale.lines.map((l) => (
            <tr key={l.id} className="border-t border-border">
              <td className="py-1.5">
                {l.name}
                {Number(l.returnedQty) > 0 ? (
                  <span className="ml-1 text-xs text-warn">
                    ({formatQty(l.returnedQty)} returned)
                  </span>
                ) : null}
              </td>
              <td className="num">{formatMoney(l.unitPrice)}</td>
              <td className="num">{formatMoney(l.discountPerUnit)}</td>
              <td className="num">
                {formatQty(l.qty)}
                {l.isLoose ? ' L' : ''}
              </td>
              <td className="num">{formatMoney(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sale.returns.length ? (
        <div className="text-sm">
          <div className="font-medium">Returns</div>
          {sale.returns.map((r) => (
            <div key={r.id} className="text-muted">
              {r.no} · {formatDateTime(r.at)} · {r.by} · refund Rs {formatMoney(r.refundTotal)}
            </div>
          ))}
        </div>
      ) : null}
      {sale.reprints.length ? (
        <div className="text-sm text-muted">
          Reprints:{' '}
          {sale.reprints.map((r) => `#${r.copyNo} ${formatDateTime(r.at)} ${r.by}`).join(' · ')}
        </div>
      ) : null}
    </div>
  );
}
