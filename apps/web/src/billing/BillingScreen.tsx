import { D, discountPerUnit, formatMoney, formatQty, parseDiscountText } from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Menu, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { usePinPrompt } from '@/components/PinPrompt';
import { Button } from '@/components/ui/button';
import { Checkbox, Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { useHotkeys, useKeyLabel, useKeymap } from '@/keyboard/keymap';
import { StatusBar } from '@/layout/StatusBar';
import { api, ApiError, errorMessage, qs } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import type { BillingItem, BillingStatus } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  batchPricing,
  billTotals,
  newKey,
  priceBillLine,
  toSaleInput,
  type BillLine,
  type BillMode,
  type PricedBillLine,
} from './bill';
import { HeldBillsDialog, type HeldBill } from './HeldBillsDialog';
import { HistoryPanel } from './HistoryPanel';
import { ItemEntry, type EmptyKey, type ItemEntryHandle } from './ItemEntry';
import { OpenCanDialog, type OpenCanRequest } from './OpenCanDialog';
import { PayDialog } from './PayDialog';
import { MenuDialog } from './MenuDialog';

/**
 * The billing screen, built for one hand on the keyboard: type, Enter, repeat, then F10 to pay.
 * The newest line is highlighted, and the net total and Pay key sit in the same place on every
 * bill.
 */
export function BillingScreen() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const askPin = usePinPrompt();
  const entry = useRef<ItemEntryHandle>(null);
  const customerRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<BillMode>(can('billing.create') ? 'INVOICE' : 'QUOTATION');
  const [wholesale, setWholesale] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [lines, setLines] = useState<BillLine[]>([]);
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState(-1);
  const [heldSaleId, setHeldSaleId] = useState<string | undefined>();
  const [approvalPin, setApprovalPin] = useState<string | undefined>();
  const [dialog, setDialog] = useState<null | 'pay' | 'held' | 'history' | 'menu'>(null);
  const [payError, setPayError] = useState('');
  const [busy, setBusy] = useState(false);
  const [openCan, setOpenCan] = useState<OpenCanRequest | null>(null);

  const status = useQuery({
    queryKey: ['billing-status'],
    queryFn: () => api.get<BillingStatus>('/api/billing/status', { passive: true }),
    refetchInterval: 30_000,
    enabled: Boolean(me.counter),
  });

  const priced = useMemo(
    () =>
      lines.map((l) => ({
        ...priceBillLine(l, wholesale),
        serverError: lineErrors[l.key] ?? null,
      })),
    [lines, wholesale, lineErrors],
  );
  const totals = billTotals(priced);
  const hasErrors = priced.some((l) => l.error || l.serverError);


  const focusEntry = () => window.requestAnimationFrame(() => entry.current?.focus());

  const resetBill = () => {
    setLines([]);
    setLineErrors({});
    setSelected(-1);
    setHeldSaleId(undefined);
    setApprovalPin(undefined);
    setCustomerName('');
    setWholesale(false);
    setPayError('');
    focusEntry();
  };

  const onAdd = (added: BillLine[]) => {
    setLines((ls) => {
      const next = [...ls, ...added];
      setSelected(next.length - 1);
      return next;
    });
  };

  const onEmptyKey = (key: EmptyKey) => {
    if (!lines.length) return;
    if (key === 'ArrowUp') setSelected((s) => Math.max(0, (s < 0 ? lines.length : s) - 1));
    else if (key === 'ArrowDown') setSelected((s) => Math.min(lines.length - 1, s + 1));
    else if (key === 'Delete') removeLine();
    else bumpQty(key === '+' ? 1 : -1);
  };

  const removeLine = () => {
    if (selected < 0 || !lines[selected]) return;
    removeLineAtIndex(selected);
  };

  const removeLineAtIndex = (idx: number) => {
    setLines((ls) => ls.filter((_, i) => i !== idx));
    setSelected((s) => Math.min(s, lines.length - 2));
    focusEntry();
  };

  const bumpQty = (dir: 1 | -1) => {
    if (selected >= 0) bumpLineQty(selected, dir);
  };

  const bumpLineQty = (index: number, dir: 1 | -1) => {
    const line = lines[index];
    if (!line) return;
    const step = line.kind === 'LOOSE' ? D('0.5') : D(1);
    const next = D(line.qty).plus(step.times(dir));
    if (!next.greaterThan(0)) return;
    if (line.kind === 'BATCH' && line.batch) {
      const onOther = lines
        .filter((l, i) => i !== index && l.batch?.id === line.batch!.id)
        .reduce((s, l) => s.plus(D(l.qty)), D(0));
      if (next.plus(onOther).greaterThan(D(line.batch.available))) {
        toast.error(`Only ${formatQty(line.batch.available)} in ${line.batch.code} here.`);
        return;
      }
    }
    setLines((ls) =>
      ls.map((l, i) =>
        i === index
          ? {
              ...l,
              qty: next.toFixed(line.kind === 'LOOSE' || line.item.unit.allowsDecimal ? 3 : 0),
            }
          : l,
      ),
    );
  };

  const updateLineQty = (index: number, rawQty: string): boolean => {
    const line = lines[index];
    if (!line) return false;
    const trimmed = rawQty.trim();
    if (!trimmed || isNaN(Number(trimmed))) {
      toast.error('Enter a valid quantity.');
      return false;
    }
    const val = D(trimmed);
    if (!val.greaterThan(0)) {
      toast.error('Quantity must be greater than 0.');
      return false;
    }
    if (line.kind === 'BATCH' && !line.item.unit.allowsDecimal && !val.isInteger()) {
      toast.error('This item only allows whole unit quantities.');
      return false;
    }
    if (line.kind === 'BATCH' && line.batch) {
      const onOther = lines
        .filter((l, i) => i !== index && l.batch?.id === line.batch!.id)
        .reduce((s, l) => s.plus(D(l.qty)), D(0));
      if (val.plus(onOther).greaterThan(D(line.batch.available))) {
        toast.error(`Only ${formatQty(line.batch.available)} in ${line.batch.code} here.`);
        return false;
      }
    }
    setLines((ls) =>
      ls.map((l, i) =>
        i === index
          ? {
              ...l,
              qty: val.toFixed(line.kind === 'LOOSE' || line.item.unit.allowsDecimal ? 3 : 0),
            }
          : l,
      ),
    );
    return true;
  };

  const updateLineDiscount = (index: number, rawDiscount: string): boolean => {
    const line = lines[index];
    if (!line) return false;
    if (wholesale || line.kind === 'LOOSE') return false;

    const trimmed = rawDiscount.trim().replace('%', '').trim();
    if (trimmed === '' || trimmed === '0' || trimmed === '0.00') {
      setLines((ls) => ls.map((l, i) => (i === index ? { ...l, discountText: '0%' } : l)));
      return true;
    }

    const val = Number(trimmed);
    if (isNaN(val) || val < 0 || val > 100) {
      toast.error('Enter a valid percentage between 0% and 100%.');
      return false;
    }

    const pctText = `${D(trimmed).toString()}%`;
    const parsed = parseDiscountText(pctText);
    if (!parsed) {
      toast.error('Enter a valid discount percentage.');
      return false;
    }

    if (line.batch) {
      const pricing = batchPricing(line.batch);
      const max = D(pricing.purchaseDiscount);
      const unitDisc = discountPerUnit(pricing.rPrice, parsed);
      if (unitDisc.greaterThan(max)) {
        const maxPct = D(pricing.rPrice).greaterThan(0)
          ? max.dividedBy(D(pricing.rPrice)).times(100).toDecimalPlaces(1).toString()
          : '0';
        toast.error(`Max allowed discount is ${maxPct}% (Rs ${formatMoney(max)}).`);
        return false;
      }
    }

    setLines((ls) => ls.map((l, i) => (i === index ? { ...l, discountText: pctText } : l)));
    return true;
  };

  const pay = async (cashGiven: string | null, print: boolean, pin = approvalPin) => {
    setBusy(true);
    setPayError('');
    try {
      const r = await api.post<{
        no: string;
        change: string | null;
        print: { printed: boolean; error?: string };
      }>('/api/sales', {
        kind: mode,
        wholesale,
        customerName,
        lines: toSaleInput(lines),
        cashGiven,
        print,
        heldSaleId,
        approval: pin ? { pin } : undefined,
      });
      toast.success(
        mode === 'INVOICE' ? `${r.no} · change Rs ${formatMoney(r.change)}` : `${r.no} issued`,
      );
      if (print && !r.print.printed)
        toast.warning(
          `Not printed: ${r.print.error ?? 'no printer is set for this counter'}. Reprint from history (F9).`,
        );
      setDialog(null);
      resetBill();
      void qc.invalidateQueries({ queryKey: ['billing-status'] });
      void qc.invalidateQueries({ queryKey: ['billing-items'] });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'APPROVAL_REQUIRED') {
        const p = await askPin(err.details?.kind as 'MIX_PRICE_CHANGE', err.message);
        if (p) {
          setApprovalPin(p);
          setBusy(false);
          return pay(cashGiven, print, p);
        }
        setPayError(err.message);
      } else if (err instanceof ApiError && err.details?.needShift) {
        await api.post('/api/shifts/open', { openingFloat: '0' });
        return pay(cashGiven, print, approvalPin);
      } else if (err instanceof ApiError && err.field?.startsWith('lines.')) {
        const idx = Number(err.field.split('.')[1]);
        const key = lines[idx]?.key;
        if (key) setLineErrors((e) => ({ ...e, [key]: err.message }));
        setSelected(idx);
        setDialog(null);
        toast.error(err.message);
        void qc.invalidateQueries({ queryKey: ['billing-items'] });
        focusEntry();
      } else {
        setPayError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const hold = async () => {
    if (!lines.length) return;
    try {
      await api.post('/api/sales/hold', {
        kind: mode,
        wholesale,
        customerName,
        lines: toSaleInput(lines),
        heldSaleId,
      });
      toast.success('Bill held. F8 brings it back.');
      resetBill();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const recall = async (bill: HeldBill) => {
    if (lines.length) {
      toast.error('Finish or hold the current bill first.');
      return;
    }
    try {
      const ids = [...new Set(bill.lines.map((l) => l.productId))];
      const r = await api.get<{ items: BillingItem[] }>(
        `/api/billing/items/by-products${qs({ ids: ids.join(',') })}`,
      );
      const byId = new Map(r.items.map((i) => [i.productId, i]));
      const rebuilt: BillLine[] = [];
      const missing: string[] = [];
      for (const l of bill.lines) {
        const item = byId.get(l.productId);
        if (!item) continue;
        if (l.kind === 'LOOSE') {
          rebuilt.push({
            key: newKey(),
            kind: 'LOOSE',
            item,
            batch: null,
            qty: l.liters,
            discountText: '',
            pricePerLiter: null,
          });
          continue;
        }
        const batch = item.batches.find((b) => b.id === l.subProductId);
        if (!batch) {
          missing.push(item.name);
          continue;
        }
        const disc =
          l.discount && !D(l.discount.value).equals(D(batch.salesDiscount)) ? l.discount.value : '';
        rebuilt.push({
          key: newKey(),
          kind: 'BATCH',
          item,
          batch,
          qty: l.qty,
          discountText: disc,
          pricePerLiter: null,
        });
      }
      setLines(rebuilt);
      setSelected(rebuilt.length - 1);
      setMode(bill.kind);
      setWholesale(bill.wholesale);
      setCustomerName(bill.customerName);
      setHeldSaleId(bill.id);
      setDialog(null);
      if (missing.length) toast.warning(`No longer in stock here: ${missing.join(', ')}.`);
      focusEntry();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const moveFromStore = async (item: BillingItem) => {
    const from = item.elsewhere[0];
    if (!from || !me.counter) return;
    try {
      await api.post('/api/transfers', {
        fromLocationId: from.locationId,
        toLocationId: me.counter.locationId,
        note: 'Moved at the counter',
        lines: [{ subProductId: from.subProductId, qty: '1' }],
      });
      toast.success(`Moved 1 ${item.unit.name} of ${item.name} from ${from.location}.`);
      void qc.invalidateQueries({ queryKey: ['billing-items'] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const openPay = () => {
    if (!lines.length) return;
    if (hasErrors) {
      toast.error('Fix the highlighted lines first.');
      return;
    }
    setPayError('');
    setDialog('pay');
  };

  useHotkeys(
    'billing',
    {
      itemCode: () => focusEntry(),
      customer: () => customerRef.current?.focus(),
      toggleMode: () => {
        if (can('billing.create') && can('quotations.create'))
          setMode((m) => (m === 'INVOICE' ? 'QUOTATION' : 'INVOICE'));
      },
      wholesale: () => setWholesale((w) => !w),
      hold: () => void hold(),
      recall: () => setDialog('held'),
      history: () => setDialog('history'),
      pay: openPay,
      removeLine,
      qtyUp: () => bumpQty(1),
      qtyDown: () => bumpQty(-1),
    },
    { enabled: dialog === null && !openCan },
  );
  const { keyFor } = useKeymap();
  const k = (a: string) => keyFor('billing', a);
  const keys = {
    mode: k('toggleMode'),
    wholesale: k('wholesale'),
    customer: k('customer'),
    hold: k('hold'),
    recall: k('recall'),
    history: k('history'),
    pay: k('pay'),
    remove: k('removeLine'),
  };
  const helpKey = useKeyLabel('global', 'help');

  const nextNo = status.data?.nextNumbers[mode] ?? '';
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border bg-surface px-4 py-2.5">
        <button
          onClick={() =>
            can('quotations.create') &&
            can('billing.create') &&
            setMode((m) => (m === 'INVOICE' ? 'QUOTATION' : 'INVOICE'))
          }
          className={cn(
            'rounded-full border-2 px-4 py-1 text-sm font-bold',
            mode === 'INVOICE'
              ? 'border-accent bg-accent-soft text-accent-strong'
              : 'border-warn bg-warn-soft text-warn',
          )}
        >
          {mode} · {keys.mode}
        </button>
        <span className="num text-[15px] font-semibold">{nextNo}</span>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={wholesale} onChange={(e) => setWholesale(e.target.checked)} />{' '}
          Wholesale ({keys.wholesale})
        </label>
        <CustomerInput
          ref={customerRef}
          value={customerName}
          onChange={setCustomerName}
          keyLabel={keys.customer}
          onDone={focusEntry}
        />
        <span className="ml-auto text-sm text-muted">
          {me.user.fullName}
        </span>
        <button
          type="button"
          onClick={() => setDialog('menu')}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-1 text-sm font-semibold text-text hover:bg-surface-2/80 hover:text-accent-strong"
          title="Open System Menu"
        >
          <Menu size={16} />
          <span>Menu</span>
        </button>
      </header>

      {status.data?.shift?.needDayEnd ? (
        <div className="border-b border-border bg-warn-soft px-4 py-2 text-sm font-medium text-warn">
          The day end for {status.data.shift.businessDate} is not done.{' '}
          <Link to="/billing/day-end" className="underline">
            Finish it
          </Link>{' '}
          before billing today.
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="flex min-h-0 flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface p-4">
          <ItemEntry
            ref={entry}
            wholesale={wholesale}
            existing={lines}
            onAdd={onAdd}
            onEmptyKey={onEmptyKey}
            onOpenCan={(item, litersNeeded) =>
              new Promise((resolve) => setOpenCan({ item, litersNeeded, resolve }))
            }
            onPriceApproval={async () => {
              if (can('mix_paint.approve')) return true;
              const pin = await askPin(
                'MIX_PRICE_CHANGE',
                'Changing a mix paint price needs an Admin PIN.',
              );
              if (pin) setApprovalPin(pin);
              return Boolean(pin);
            }}
            onMoveFromStore={(item) => void moveFromStore(item)}
            canMoveStock={can('transfers.create')}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <table className="w-full text-[15px]" aria-label="Bill lines">
              <thead className="sticky top-0 bg-surface text-left text-sm text-muted">
                <tr className="border-b border-border">
                  <th className="w-10 py-2 font-medium">#</th>
                  <th className="py-2 font-medium">Item description</th>
                  <th className="num py-2 font-medium">{wholesale ? 'W-price' : 'R-price'}</th>
                  <th className="w-28 py-2 text-center font-medium">Discount (%)</th>
                  <th className="w-36 py-2 text-center font-medium">Qty</th>
                  <th className="num py-2 pr-1 font-medium">Amount</th>
                  <th className="w-8 py-2" />
                </tr>
              </thead>
              <tbody>
                {priced.map((l, i) => (
                  <BillLineRow
                    key={l.key}
                    line={l}
                    index={i}
                    selected={i === selected}
                    wholesale={wholesale}
                    onSelect={() => setSelected(i)}
                    onBumpQty={(dir) => bumpLineQty(i, dir)}
                    onUpdateQty={(qty) => updateLineQty(i, qty)}
                    onUpdateDiscount={(disc) => updateLineDiscount(i, disc)}
                    onRemove={() => removeLineAtIndex(i)}
                    onDone={focusEntry}
                  />
                ))}
              </tbody>
            </table>
            {lines.length === 0 ? (
              <p className="py-10 text-center text-muted">
                Type an item code or name to start the bill.
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => void hold()}
              keyHint={keys.hold}
              disabled={!lines.length}
            >
              Hold
            </Button>
            <Button size="sm" onClick={() => setDialog('held')} keyHint={keys.recall}>
              Recall
            </Button>
            <Button size="sm" onClick={() => setDialog('history')} keyHint={keys.history}>
              History
            </Button>
            <Button size="sm" onClick={removeLine} keyHint={keys.remove} disabled={selected < 0}>
              Remove line
            </Button>
            <Button
              size="sm"
              variant="ghost"
              keyHint={helpKey}
              onClick={() =>
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1', bubbles: true }))
              }
            >
              Shortcuts
            </Button>
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          <div className="rounded-[var(--radius-card)] border border-border bg-surface-2 p-5">
            <dl className="grid grid-cols-2 gap-y-2 text-[15px]">
              <dt className="text-muted">Net items</dt>
              <dd className="num">{totals.netItems}</dd>
              <dt className="text-muted">Net quantity</dt>
              <dd className="num">{formatQty(totals.netQty)}</dd>
              <dt className="text-muted">Gross</dt>
              <dd className="num">{formatMoney(totals.gross)}</dd>
              <dt className="text-muted">Discount</dt>
              <dd className="num">{formatMoney(totals.discount)}</dd>
            </dl>
            <div className="mt-4 border-t border-border pt-4">
              <div className="text-sm font-semibold uppercase tracking-wide text-muted">
                Net total
              </div>
              <div className="num mt-1 text-[32px] font-bold leading-tight" aria-live="polite">
                Rs {formatMoney(totals.netTotal)}
              </div>
            </div>
          </div>
          <Button
            variant="outlineAccent"
            size="lg"
            className="h-14 text-lg"
            onClick={openPay}
            disabled={!lines.length}
          >
            {mode === 'INVOICE' ? 'Pay' : 'Issue quotation'} · {keys.pay}
          </Button>
          {wholesale ? (
            <p className="text-sm font-medium text-accent-strong">
              Wholesale bill: W-prices, no extra discount.
            </p>
          ) : null}
        </aside>
      </div>

      <StatusBar billing={status.data} />

      <PayDialog
        open={dialog === 'pay'}
        kind={mode}
        netTotal={totals.netTotal.toFixed(2)}
        busy={busy}
        error={payError}
        onClose={() => {
          setDialog(null);
          focusEntry();
        }}
        onConfirm={(cash, print) => void pay(cash, print)}
      />
      <HeldBillsDialog
        open={dialog === 'held'}
        onClose={() => setDialog(null)}
        onRecall={(b) => void recall(b)}
      />
      <Dialog
        open={dialog === 'history'}
        onOpenChange={(o) => (!o ? (setDialog(null), focusEntry()) : undefined)}
        title="Bill history"
        className="max-w-6xl"
      >
        <div className="h-[65vh]">
          <HistoryPanel inDialog />
        </div>
      </Dialog>
      <MenuDialog
        open={dialog === 'menu'}
        onClose={() => {
          setDialog(null);
          focusEntry();
        }}
      />
      <OpenCanDialog request={openCan} onClose={() => setOpenCan(null)} />
    </div>
  );
}

const CustomerInput = ({
  ref,
  value,
  onChange,
  keyLabel,
  onDone,
}: {
  ref: React.Ref<HTMLInputElement>;
  value: string;
  onChange: (v: string) => void;
  keyLabel: string;
  onDone: () => void;
}) => {
  const term = useDebounced(value.trim(), 200);
  const suggestions = useQuery({
    queryKey: ['customers', term],
    queryFn: () =>
      api.get<{ items: { name: string; phone: string }[] }>(
        `/api/billing/customers${qs({ q: term })}`,
      ),
    enabled: term.length >= 2,
  });
  return (
    <>
      <Input
        ref={ref}
        aria-label="Customer name"
        list="customer-names"
        placeholder={`Customer (optional, ${keyLabel})`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') {
            e.preventDefault();
            onDone();
          }
        }}
        className="h-9 w-64"
      />
      <datalist id="customer-names">
        {(suggestions.data?.items ?? []).map((c) => (
          <option key={c.name} value={c.name}>
            {c.phone}
          </option>
        ))}
      </datalist>
    </>
  );
};

function BillLineRow({
  line,
  index,
  selected,
  wholesale,
  onSelect,
  onBumpQty,
  onUpdateQty,
  onUpdateDiscount,
  onRemove,
  onDone,
}: {
  line: PricedBillLine & { serverError?: string | null };
  index: number;
  selected: boolean;
  wholesale: boolean;
  onSelect: () => void;
  onBumpQty: (dir: 1 | -1) => void;
  onUpdateQty: (qty: string) => boolean;
  onUpdateDiscount: (disc: string) => boolean;
  onRemove: () => void;
  onDone: () => void;
}) {
  const getPercentDisplay = () => {
    if (line.discountText) {
      const t = line.discountText.trim().replace('%', '');
      return t ? `${t}%` : '0%';
    }
    if (D(line.discountPerUnit).greaterThan(0) && D(line.unitPrice).greaterThan(0)) {
      const pct = D(line.discountPerUnit)
        .dividedBy(D(line.unitPrice))
        .times(100)
        .toDecimalPlaces(2)
        .toNumber();
      return pct > 0 ? `${pct}%` : '0%';
    }
    return '0%';
  };

  const [qtyVal, setQtyVal] = useState(formatQty(line.qty));
  const [discVal, setDiscVal] = useState(getPercentDisplay);

  useEffect(() => {
    setQtyVal(formatQty(line.qty));
  }, [line.qty]);

  useEffect(() => {
    setDiscVal(getPercentDisplay());
  }, [line.discountText, line.discountPerUnit, line.unitPrice]);

  const commitQty = () => {
    if (qtyVal.trim() === formatQty(line.qty)) return;
    const ok = onUpdateQty(qtyVal);
    if (!ok) setQtyVal(formatQty(line.qty));
  };

  const commitDiscount = () => {
    const ok = onUpdateDiscount(discVal);
    if (!ok) {
      setDiscVal(getPercentDisplay());
    }
  };

  return (
    <tr
      onClick={onSelect}
      aria-selected={selected}
      className={cn(
        'group border-b border-border transition-colors',
        selected && 'bg-selected/70',
        (line.error || line.serverError) && 'bg-danger-soft',
      )}
    >
      <td className="py-2 text-muted align-middle">{index + 1}</td>
      <td className="py-2 font-medium align-middle">
        <div>{line.description}</div>
        {line.batch && line.item.batches.length > 1 ? (
          <span className="text-xs text-muted">Batch: {line.batch.code}</span>
        ) : null}
        {line.error || line.serverError ? (
          <div className="text-xs text-danger">{line.error ?? line.serverError}</div>
        ) : null}
      </td>
      <td className="num py-2 text-muted align-middle">{formatMoney(line.unitPrice)}</td>
      <td className="w-28 py-2 align-middle">
        {wholesale || line.kind === 'LOOSE' ? (
          <div className="text-center text-muted">0%</div>
        ) : (
          <div className="flex flex-col items-center justify-center">
            <input
              type="text"
              aria-label={`Discount percentage for ${line.description}`}
              placeholder="0%"
              value={discVal}
              onClick={(e) => {
                e.stopPropagation();
                onSelect();
              }}
              onChange={(e) => setDiscVal(e.target.value)}
              onFocus={(e) => {
                e.target.select();
              }}
              onBlur={commitDiscount}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitDiscount();
                  onDone();
                } else if (e.key === 'Escape') {
                  setDiscVal(getPercentDisplay());
                  onDone();
                }
              }}
              className="w-20 rounded border border-border/80 bg-surface px-2 py-1 text-center font-mono text-sm shadow-sm transition hover:border-accent focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
            />
            {D(line.discountPerUnit).greaterThan(0) ? (
              <span className="mt-0.5 text-[11px] text-muted text-center">
                -Rs {formatMoney(line.discountPerUnit)}
              </span>
            ) : null}
          </div>
        )}
      </td>
      <td className="w-36 py-2 align-middle">
        <div className="flex items-center justify-center gap-1">
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-surface-2 text-sm font-semibold transition hover:bg-surface-2/80 disabled:opacity-40"
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
              onBumpQty(-1);
            }}
            disabled={D(line.qty).lessThanOrEqualTo(line.kind === 'LOOSE' ? 0.5 : 1)}
            title="Decrease quantity"
          >
            −
          </button>
          <input
            type="text"
            aria-label={`Quantity for ${line.description}`}
            value={qtyVal}
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
            onChange={(e) => setQtyVal(e.target.value)}
            onBlur={commitQty}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitQty();
                onDone();
              } else if (e.key === 'Escape') {
                setQtyVal(formatQty(line.qty));
                onDone();
              }
            }}
            className="w-16 rounded border border-border/80 bg-surface px-1.5 py-1 text-center font-mono text-sm shadow-sm transition hover:border-accent focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
          />
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-surface-2 text-sm font-semibold transition hover:bg-surface-2/80"
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
              onBumpQty(1);
            }}
            title="Increase quantity"
          >
            +
          </button>
          {line.kind === 'LOOSE' ? <span className="text-xs text-muted">L</span> : null}
        </div>
      </td>
      <td className="num py-2 font-semibold align-middle">{formatMoney(line.amount)}</td>
      <td className="w-8 py-2 text-right align-middle">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="rounded p-1 text-muted transition hover:bg-danger/10 hover:text-danger"
          title="Remove line"
        >
          <Trash2 size={15} />
        </button>
      </td>
    </tr>
  );
}
