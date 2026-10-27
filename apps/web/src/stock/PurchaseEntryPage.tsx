import {
  D,
  computePurchaseLine,
  computePurchaseTotals,
  formatDate,
  formatMoney,
  formatQty,
  parseDiscountText,
  shopDate,
  supplierTotalMatches,
  validatePurchaseLine,
  type DiscountInput,
} from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ArrowLeft, PackagePlus, Pencil, Plus, Printer, Save, Trash2, Undo2 } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { useAsk } from '@/components/AskDialog';
import { usePinPrompt } from '@/components/PinPrompt';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Card, CardBody } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Money, PageHeader, Spinner } from '@/components/ui/misc';
import { useValues } from '@/components/values';
import { useHotkeys } from '@/keyboard/keymap';
import { api, ApiError, errorMessage, qs } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import type { StockSearchItem, Supplier } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ProductForm } from './ProductForm';

interface GrnProduct {
  id: string;
  code: string;
  name: string;
  piecesPerBox: number;
  unit: string;
  trackExpiry?: boolean;
}

interface GrnLine {
  key: string;
  product: GrnProduct | null;
  value: string;
  qty: string;
  free: string;
  discount: string;
  rPrice: string | null;
  wPrice: string | null;
  salesDiscount: string;
  salesPrice: string | null;
  expiryDate: string;
}

const emptyLine = (): GrnLine => ({
  key: Math.random().toString(36).slice(2),
  product: null,
  value: '',
  qty: '',
  free: '',
  discount: '',
  rPrice: null,
  wPrice: null,
  salesDiscount: '',
  salesPrice: null,
  expiryDate: '',
});

const disc = (t: string): DiscountInput => {
  const s = t.trim();
  if (!s) return { type: 'AMOUNT', value: '0' };
  const rsMatch = /^(?:rs\.?\s*)(.+)$/i.exec(s);
  if (rsMatch?.[1]) {
    const val = rsMatch[1].replace(/,/g, '').trim();
    return { type: 'AMOUNT', value: val };
  }
  const pctMatch = /^(.+)\s*%$/.exec(s);
  if (pctMatch?.[1]) {
    const val = pctMatch[1].replace(/,/g, '').trim();
    return { type: 'PERCENT', value: val };
  }
  const clean = s.replace(/,/g, '');
  if (!Number.isNaN(Number(clean))) {
    return { type: 'PERCENT', value: clean };
  }
  return { type: 'AMOUNT', value: 'x' };
};
const num = (t: string) =>
  t.trim() && !Number.isNaN(Number(t.replace(/,/g, ''))) ? t.replace(/,/g, '') : '0';

function compute(l: GrnLine) {
  const input = {
    value: num(l.value),
    qty: num(l.qty),
    free: num(l.free),
    discount: disc(l.discount),
    piecesPerBox: l.product?.piecesPerBox ?? 1,
    rPrice: l.rPrice,
    wPrice: l.wPrice,
    salesDiscount: disc(l.salesDiscount),
    salesPrice: l.salesPrice,
  };
  try {
    const r = computePurchaseLine(input);
    return { r, issues: l.product && Number(num(l.qty)) > 0 ? validatePurchaseLine(input, r) : [] };
  } catch {
    return {
      r: null,
      issues: [
        { field: 'value', message: 'Check the numbers on this line.', code: 'VALIDATION' as const },
      ],
    };
  }
}

const COLS = [
  'item',
  'value',
  'qty',
  'free',
  'discount',
  'rPrice',
  'wPrice',
  'salesDiscount',
  'salesPrice',
  'expiryDate',
] as const;

// Prices a line can't be saved with, not even as a draft (the server checks the same).
const PRICE_RULES = new Set(['DISCOUNT_ABOVE_LIMIT', 'PRICE_ABOVE_R_PRICE', 'BELOW_COST']);

/** The GRN screen. Enter moves across the line; Enter on the last column starts a new line. */
export function PurchaseEntryPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const { can, me } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const askPin = usePinPrompt();
  const canCost = can('cost.item', 'cost.totals');
  const existing = useQuery({
    queryKey: ['purchase', id],
    queryFn: () => api.get<PurchaseView>(`/api/purchases/${id}`),
    enabled: !isNew,
  });
  const locations = useValues('locations');
  const [header, setHeader] = useState({
    supplier: null as Supplier | null,
    supplierInvoiceNo: '',
    date: shopDate(),
    ref: '',
    locationId: '',
    salesRepId: '',
  });
  const [footer, setFooter] = useState({
    invoiceDiscount: '',
    otherCharges: '',
    supplierInvoiceTotal: '',
    paidNow: '',
    paymentMethod: 'CASH',
  });
  const [lines, setLines] = useState<GrnLine[]>([emptyLine()]);
  const [cellError, setCellError] = useState<{
    row: number;
    field: string;
    message: string;
  } | null>(null);
  const [warning, setWarning] = useState<{ message: string; confirm: string } | null>(null);
  const [newItemFor, setNewItemFor] = useState<number | null>(null);

  const handleNewItem = (rowIdx?: number) => {
    if (rowIdx !== undefined) {
      setNewItemFor(rowIdx);
      return;
    }
    const emptyIdx = lines.findIndex((l) => !l.product);
    if (emptyIdx !== -1) {
      setNewItemFor(emptyIdx);
    } else {
      const nextIdx = lines.length;
      setLines((ls) => [...ls, emptyLine()]);
      setNewItemFor(nextIdx);
    }
  };
  const [busy, setBusy] = useState(false);
  const grid = useRef<HTMLDivElement>(null);

  // Load a draft for editing.
  useEffect(() => {
    const p = existing.data;
    if (!p || p.status !== 'DRAFT') return;
    void api.get<Supplier>(`/api/suppliers/${p.supplier.id}`).then((s) =>
      setHeader({
        supplier: s,
        supplierInvoiceNo: p.supplierInvoiceNo,
        date: p.date,
        ref: p.ref,
        locationId: p.location.id,
        salesRepId: p.salesRep?.id ?? '',
      }),
    );
    setFooter({
      invoiceDiscount: p.invoiceDiscount ?? '',
      otherCharges: p.otherCharges ?? '',
      supplierInvoiceTotal: p.supplierInvoiceTotal,
      paidNow: '',
      paymentMethod: 'CASH',
    });
    if (p.supplierInvoiceTotal) {
      setIsCustomSupplierTotal(true);
    }
    setLines([
      ...p.lines.map((l) => ({
        key: l.id,
        product: {
          id: l.product.id,
          code: l.product.code,
          name: l.product.name,
          piecesPerBox: l.product.piecesPerBox,
          unit: l.product.unit.name,
        },
        value: l.value ?? '',
        qty: formatQty(l.qty),
        free: formatQty(l.free),
        discount:
          l.discountType === 'PERCENT'
            ? `${D(l.discountValue ?? 0).toString()}%`
            : D(l.discountValue ?? 0).toString(),
        rPrice: l.rPrice,
        wPrice: l.wPrice,
        salesDiscount:
          l.salesDiscountType === 'PERCENT'
            ? `${D(l.salesDiscountValue).toString()}%`
            : D(l.salesDiscountValue).toString(),
        salesPrice: null,
        expiryDate: l.expiryDate ?? '',
      })),
      emptyLine(),
    ]);
  }, [existing.data]);

  const computed = useMemo(() => lines.map(compute), [lines]);
  const filled = lines.map((l, i) => ({ l, c: computed[i]! })).filter((x) => x.l.product);
  const totals = computePurchaseTotals({
    lineAmounts: filled.map((x) => x.c.r?.amount ?? 0),
    invoiceDiscount: num(footer.invoiceDiscount),
    otherCharges: num(footer.otherCharges),
  });
  const [isCustomSupplierTotal, setIsCustomSupplierTotal] = useState(false);

  useEffect(() => {
    if (!isCustomSupplierTotal) {
      const net = D(totals.netTotal);
      if (net.greaterThan(0)) {
        setFooter((f) => ({ ...f, supplierInvoiceTotal: net.toFixed(2) }));
      } else {
        setFooter((f) => ({ ...f, supplierInvoiceTotal: '' }));
      }
    }
  }, [totals.netTotal.toString(), isCustomSupplierTotal]);

  const totalOk =
    footer.supplierInvoiceTotal.trim() !== '' &&
    supplierTotalMatches(totals.netTotal, num(footer.supplierInvoiceTotal));

  const update = (i: number, patch: Partial<GrnLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const focusCell = (row: number, col: number) => {
    window.requestAnimationFrame(() => {
      const el = grid.current?.querySelector<HTMLInputElement>(
        `[data-row="${row}"][data-col="${col}"]`,
      );
      el?.focus();
      el?.select();
    });
  };

  const onCellKey =
    (row: number, col: number, lastCol: number) => (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter' || e.ctrlKey) return;
      e.preventDefault();
      if (e.shiftKey) return focusCell(row, Math.max(0, col - 1));
      if (col < lastCol) return focusCell(row, col + 1);
      if (row === lines.length - 1) setLines((ls) => [...ls, emptyLine()]);
      focusCell(row + 1, 0);
    };

  const body = () => ({
    supplierId: header.supplier?.id,
    supplierInvoiceNo: header.supplierInvoiceNo,
    date: header.date,
    ref: header.ref,
    locationId: header.locationId || null,
    salesRepId: header.salesRepId || null,
    invoiceDiscount: num(footer.invoiceDiscount),
    otherCharges: num(footer.otherCharges),
    supplierInvoiceTotal: num(footer.supplierInvoiceTotal),
    lines: filled.map(({ l, c }) => ({
      productId: l.product!.id,
      value: num(l.value),
      qty: num(l.qty),
      free: num(l.free),
      discount: disc(l.discount),
      rPrice: c.r?.rPrice.toFixed(2) ?? null,
      wPrice: c.r?.wPrice.toFixed(2) ?? null,
      salesDiscount: disc(l.salesDiscount),
      salesPrice: l.salesPrice,
      expiryDate: l.expiryDate || null,
    })),
  });

  const handleError = (err: unknown) => {
    if (err instanceof ApiError && err.isWarning && typeof err.details?.confirm === 'string') {
      setWarning({ message: err.message, confirm: err.details.confirm });
      return;
    }
    const m = err instanceof ApiError ? /^lines\.(\d+)\.(\w+)/.exec(err.field ?? '') : null;
    if (m) {
      const filledIdx = Number(m[1]);
      const row = lines.indexOf(filled[filledIdx]!.l);
      setCellError({ row, field: m[2]!, message: errorMessage(err) });
    }
    toast.error(errorMessage(err));
  };

  const priceIssue = (row: number, field: string) =>
    computed[row]?.issues.find((x) => x.field === field && PRICE_RULES.has(x.code)) ?? null;

  const save = async (post: boolean, confirm: Record<string, boolean> = {}) => {
    if (!header.supplier) return toast.error('Pick the supplier first.');
    if (!filled.length) return toast.error('Add at least one line.');
    for (const [row, c] of computed.entries()) {
      const bad = lines[row]!.product ? c.issues.find((x) => PRICE_RULES.has(x.code)) : undefined;
      if (!bad) continue;
      setCellError({ row, field: bad.field, message: bad.message });
      focusCell(row, COLS.indexOf(bad.field as (typeof COLS)[number]));
      return toast.error(`Line ${row + 1}: ${bad.message}`);
    }
    setBusy(true);
    setCellError(null);
    try {
      const postBody = {
        paidNow: num(footer.paidNow),
        paymentMethod: footer.paymentMethod,
        ...confirm,
      };
      let result: { id: string; no?: string; warnings?: string[] };
      if (isNew) {
        result = await api.post('/api/purchases', { ...body(), post: post ? postBody : undefined });
      } else {
        await api.put(`/api/purchases/${id}`, body());
        result = post ? await api.post(`/api/purchases/${id}/post`, postBody) : { id: id! };
      }
      for (const w of result.warnings ?? []) toast.warning(w);
      toast.success(
        post ? `${result.no ?? 'GRN'} posted. Stock and supplier balance updated.` : 'Draft saved.',
      );
      setWarning(null);
      await qc.invalidateQueries({ queryKey: ['purchases'] });
      await qc.invalidateQueries({ queryKey: ['products'] });
      void nav(post ? '/stock/purchases' : `/stock/purchases/${result.id}`);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  useHotkeys(
    'global',
    { saveDraft: () => void save(false), post: () => void save(true) },
    { enabled: isNew || existing.data?.status === 'DRAFT' },
  );

  // The same supplier with the same invoice no raises a warning.
  const dupCheck = useQuery({
    queryKey: ['dup-invoice', header.supplier?.id, header.supplierInvoiceNo],
    queryFn: () =>
      api.get<{ duplicate: { no: string } | null }>(
        `/api/purchases/check-invoice${qs({ supplierId: header.supplier!.id, invoiceNo: header.supplierInvoiceNo, exceptId: isNew ? undefined : id })}`,
      ),
    enabled: Boolean(header.supplier && header.supplierInvoiceNo.trim()),
  });

  if (!isNew && existing.isLoading) return <Spinner />;
  if (!isNew && existing.data && existing.data.status !== 'DRAFT')
    return <PostedPurchase p={existing.data} askPin={askPin} />;

  const last = COLS.length - 1;
  const errFor = (row: number, field: string) =>
    cellError && cellError.row === row && cellError.field === field ? cellError.message : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={isNew ? 'New GRN' : `Edit ${existing.data?.no}`}
        description="Ctrl+S saves a draft (no stock change). Ctrl+Enter posts."
      >
        {can('products.create') ? (
          <Button
            type="button"
            variant="ghost"
            icon={<PackagePlus size={16} />}
            onClick={() => handleNewItem()}
          >
            New item
          </Button>
        ) : null}
        <Button
          icon={<Save size={16} />}
          onClick={() => void save(false)}
          disabled={busy}
          keyHint="Ctrl+S"
        >
          Save draft
        </Button>
        <Button
          variant="primary"
          onClick={() => void save(true)}
          disabled={busy || !totalOk}
          keyHint="Ctrl+Enter"
        >
          Post
        </Button>
      </PageHeader>
      <Card>
        <CardBody className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <div className="md:col-span-2">
            <SupplierPicker
              value={header.supplier}
              onChange={(s) => setHeader({ ...header, supplier: s, salesRepId: '' })}
            />
          </div>
          <Field
            label="Supplier invoice no"
            hint={dupCheck.data?.duplicate ? `Already on ${dupCheck.data.duplicate.no}` : undefined}
          >
            <Input
              value={header.supplierInvoiceNo}
              onChange={(e) => setHeader({ ...header, supplierInvoiceNo: e.target.value })}
              aria-invalid={Boolean(dupCheck.data?.duplicate)}
            />
          </Field>
          <Field label="Date">
            <Input
              type="date"
              value={header.date}
              max={shopDate()}
              onChange={(e) => setHeader({ ...header, date: e.target.value })}
            />
          </Field>
          <Field label="Sales rep">
            <Select
              value={header.salesRepId}
              onChange={(e) => setHeader({ ...header, salesRepId: e.target.value })}
            >
              <option value="">—</option>
              {(header.supplier?.reps ?? [])
                .filter((r) => r.active)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Location">
            <Select
              value={header.locationId || me.location?.id || ''}
              onChange={(e) => setHeader({ ...header, locationId: e.target.value })}
            >
              {(locations.data?.items ?? [])
                .filter((l) => l.kind !== 'DAMAGED')
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Ref (note)" className="md:col-span-3 lg:col-span-6">
            <Input
              value={header.ref}
              onChange={(e) => setHeader({ ...header, ref: e.target.value })}
            />
          </Field>
        </CardBody>
      </Card>

      <Card className="overflow-x-auto">
        <div ref={grid}>
          <table className="w-full min-w-[1200px] text-sm">
            <thead className="bg-surface-2 text-left text-muted">
              <tr>
                <th className="w-8 px-2 py-2">#</th>
                <th className="min-w-56 px-2 py-2 font-medium">Item</th>
                <th className="num px-2 py-2 font-medium">Value</th>
                <th className="num px-2 py-2 font-medium">Qty</th>
                <th className="num px-2 py-2 font-medium">Free</th>
                <th className="num px-2 py-2 font-medium">Discount (%)</th>
                {canCost ? <th className="num px-2 py-2 font-medium">Cost</th> : null}
                {canCost ? <th className="num px-2 py-2 font-medium">Amount</th> : null}
                {canCost ? <th className="num px-2 py-2 font-medium">Actual</th> : null}
                <th className="num px-2 py-2 font-medium">R-price</th>
                <th className="num px-2 py-2 font-medium">W-price</th>
                <th className="num px-2 py-2 font-medium">Sales disc (%)</th>
                <th className="num px-2 py-2 font-medium">Sales price</th>
                {canCost ? <th className="num px-2 py-2 font-medium">Margin</th> : null}
                <th className="px-2 py-2 font-medium">Exp date</th>
                <th className="w-10 px-1 py-2 text-center" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const { r, issues } = computed[i]!;
                const issue = (f: string) =>
                  errFor(i, f) ?? issues.find((x) => x.field === f)?.message ?? null;
                const cell = (
                  col: number,
                  field: keyof GrnLine,
                  value: string,
                  onChange: (v: string) => void,
                  extra?: string,
                  onBlur?: () => void,
                  placeholder?: string,
                ) => (
                  <td className="px-1 py-1">
                    <Input
                      data-row={i}
                      data-col={col}
                      value={value}
                      onChange={(e) => onChange(e.target.value)}
                      onBlur={onBlur}
                      onKeyDown={(e) => {
                        // A price that breaks a rule stays put until it is fixed.
                        if (
                          e.key === 'Enter' &&
                          !e.shiftKey &&
                          !e.ctrlKey &&
                          priceIssue(i, field)
                        ) {
                          e.preventDefault();
                          return;
                        }
                        onCellKey(i, col, last)(e);
                      }}
                      aria-invalid={Boolean(issue(field))}
                      title={issue(field) ?? undefined}
                      placeholder={placeholder}
                      className={cn('num h-8 w-24 px-2', extra)}
                    />
                  </td>
                );
                const rowIssues = [
                  ...new Set(
                    [
                      cellError?.row === i ? cellError.message : null,
                      ...issues.map((x) => x.message),
                    ].filter((m): m is string => Boolean(m)),
                  ),
                ];
                return (
                  <tr key={l.key} className="border-t border-border align-top">
                    <td className="px-2 py-2 text-muted">{i + 1}</td>
                    <td className="px-1 py-1">
                      <ItemCell
                        row={i}
                        product={l.product}
                        supplierId={header.supplier?.id}
                        onPick={(p) => {
                          const lp = p.lastPurchase;
                          update(i, {
                            product: {
                              id: p.id,
                              code: p.code,
                              name: p.name,
                              piecesPerBox: p.piecesPerBox,
                              unit: p.unit.name,
                              trackExpiry: p.trackExpiry,
                            },
                            ...(lp && !l.value
                              ? {
                                  value: lp.value,
                                  discount:
                                    lp.discount.type === 'PERCENT'
                                      ? `${D(lp.discount.value).toString()}%`
                                      : D(lp.discount.value).toString(),
                                  salesDiscount:
                                    lp.salesDiscount.type === 'PERCENT'
                                      ? `${D(lp.salesDiscount.value).toString()}%`
                                      : D(lp.salesDiscount.value).toString(),
                                }
                              : {}),
                          });
                          focusCell(i, 1);
                        }}
                        onNew={() => setNewItemFor(i)}
                        onEnterEmpty={() => (i > 0 ? void save(true) : undefined)}
                      />
                      {rowIssues.map((m) => (
                        <div key={m} className="mt-1 max-w-56 text-xs text-danger">
                          {m}
                        </div>
                      ))}
                    </td>
                    {cell(1, 'value', l.value, (v) => update(i, { value: v }))}
                    {cell(2, 'qty', l.qty, (v) => update(i, { qty: v }), 'w-20')}
                    {cell(3, 'free', l.free, (v) => update(i, { free: v }), 'w-16')}
                    {cell(
                      4,
                      'discount',
                      l.discount,
                      (v) => update(i, { discount: v }),
                      'w-20',
                      () => {
                        const trimmed = l.discount.trim();
                        if (
                          trimmed &&
                          !trimmed.endsWith('%') &&
                          !/^rs/i.test(trimmed) &&
                          !isNaN(Number(trimmed.replace(/,/g, '')))
                        ) {
                          update(i, { discount: `${trimmed}%` });
                        }
                      },
                    )}
                    {canCost ? (
                      <td className="num px-2 py-2">{r ? formatMoney(r.cost) : ''}</td>
                    ) : null}
                    {canCost ? (
                      <td className="num px-2 py-2">{r ? formatMoney(r.amount) : ''}</td>
                    ) : null}
                    {canCost ? (
                      <td className="num px-2 py-2">{r ? formatMoney(r.actualPrice) : ''}</td>
                    ) : null}
                    {cell(5, 'rPrice', l.rPrice ?? (r && l.value ? r.rPrice.toFixed(2) : ''), (v) =>
                      update(i, { rPrice: v || null }),
                    )}
                    {cell(6, 'wPrice', l.wPrice ?? (r && l.value ? r.wPrice.toFixed(2) : ''), (v) =>
                      update(i, { wPrice: v || null }),
                    )}
                    {cell(
                      7,
                      'salesDiscount',
                      l.salesDiscount,
                      (v) => update(i, { salesDiscount: v, salesPrice: null }),
                      'w-20',
                      () => {
                        const trimmed = l.salesDiscount.trim();
                        if (
                          trimmed &&
                          !trimmed.endsWith('%') &&
                          !/^rs/i.test(trimmed) &&
                          !isNaN(Number(trimmed.replace(/,/g, '')))
                        ) {
                          update(i, { salesDiscount: `${trimmed}%`, salesPrice: null });
                        }
                      },
                      r && l.value ? `max ${r.purchaseDiscount.toFixed(2)}` : undefined,
                    )}
                    {cell(
                      8,
                      'salesPrice',
                      l.salesPrice ?? (r && l.value ? r.salesPrice.toFixed(2) : ''),
                      (v) => update(i, { salesPrice: v || null }),
                    )}
                    {canCost ? (
                      <td
                        className={cn(
                          'num px-2 py-2',
                          r && r.margin.isNegative() ? 'text-danger' : 'text-ok',
                        )}
                      >
                        {r && l.value ? formatMoney(r.margin) : ''}
                      </td>
                    ) : null}
                    <td className="px-1 py-1">
                      <Input
                        type="date"
                        data-row={i}
                        data-col={9}
                        value={l.expiryDate}
                        onChange={(e) => update(i, { expiryDate: e.target.value })}
                        onKeyDown={onCellKey(i, 9, last)}
                        aria-invalid={Boolean(issue('expiryDate'))}
                        className="h-8 w-36 px-2"
                      />
                    </td>
                    <td className="px-1 py-1 text-center align-middle">
                      <button
                        type="button"
                        onClick={() => {
                          if (lines.length > 1) {
                            setLines((ls) => ls.filter((_, j) => j !== i));
                          } else {
                            setLines([emptyLine()]);
                          }
                        }}
                        className="rounded p-1 text-muted transition hover:bg-danger/10 hover:text-danger"
                        title={lines.length > 1 ? `Delete row ${i + 1}` : 'Clear row'}
                        aria-label={`Delete row ${i + 1}`}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={<Plus size={16} />}
            onClick={() => setLines((ls) => [...ls, emptyLine()])}
          >
            Add row
          </Button>
          {can('products.create') ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon={<PackagePlus size={16} />}
              onClick={() => handleNewItem()}
            >
              New item
            </Button>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardBody className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="grid grid-cols-2 gap-3">
            <Field
              label={
                <div className="flex items-center justify-between">
                  <span>Supplier's invoice total</span>
                  {isCustomSupplierTotal ? (
                    <button
                      type="button"
                      onClick={() => {
                        setIsCustomSupplierTotal(false);
                        const net = D(totals.netTotal);
                        setFooter((f) => ({
                          ...f,
                          supplierInvoiceTotal: net.greaterThan(0) ? net.toFixed(2) : '',
                        }));
                      }}
                      className="text-xs text-primary underline hover:text-primary/80 font-normal cursor-pointer"
                    >
                      Reset to net total
                    </button>
                  ) : (
                    <span className="text-[11px] text-muted font-normal">(Auto-filled)</span>
                  )}
                </div>
              }
              hint="Must match the net total within Rs 1."
              error={
                footer.supplierInvoiceTotal && !totalOk
                  ? `Net total is Rs ${formatMoney(totals.netTotal)}.`
                  : undefined
              }
            >
              <Input
                className="num"
                value={footer.supplierInvoiceTotal}
                onChange={(e) => {
                  setIsCustomSupplierTotal(true);
                  setFooter({ ...footer, supplierInvoiceTotal: e.target.value });
                }}
              />
            </Field>
            <Field label="Other charges (transport)">
              <Input
                className="num"
                value={footer.otherCharges}
                onChange={(e) => setFooter({ ...footer, otherCharges: e.target.value })}
              />
            </Field>
            <Field label="Paid now">
              <Input
                className="num"
                value={footer.paidNow}
                onChange={(e) => setFooter({ ...footer, paidNow: e.target.value })}
              />
            </Field>
            <Field label="Paid by">
              <Select
                value={footer.paymentMethod}
                onChange={(e) => setFooter({ ...footer, paymentMethod: e.target.value })}
              >
                <option value="CASH">Cash</option>
                <option value="BANK_TRANSFER">Bank</option>
              </Select>
            </Field>
          </div>
          <dl className="grid grid-cols-2 content-start gap-y-2 text-[15px]">
            <dt className="text-muted">Lines</dt>
            <dd className="num">{filled.length}</dd>
            {canCost ? (
              <>
                <dt className="text-muted">Subtotal</dt>
                <dd className="num">{formatMoney(totals.subtotal)}</dd>
              </>
            ) : null}
            {D(totals.invoiceDiscount).greaterThan(0) ? (
              <>
                <dt className="text-muted">Invoice discount</dt>
                <dd className="num">−{formatMoney(totals.invoiceDiscount)}</dd>
              </>
            ) : null}
            <dt className="text-muted">Other charges</dt>
            <dd className="num">{formatMoney(totals.otherCharges)}</dd>
            <dt className="border-t border-border pt-2 font-semibold">Net total</dt>
            <dd className="num border-t border-border pt-2 text-2xl font-bold">
              Rs {formatMoney(totals.netTotal)}
            </dd>
            <dt className="text-muted">Rest to supplier balance</dt>
            <dd className="num">{formatMoney(D(totals.netTotal).minus(D(num(footer.paidNow))))}</dd>
          </dl>
        </CardBody>
      </Card>

      {warning ? (
        <div className="flex items-center justify-between gap-3 rounded-[var(--radius-card)] bg-warn-soft p-4 text-warn">
          <span>{warning.message}</span>
          <Button variant="primary" onClick={() => void save(true, { [warning.confirm]: true })}>
            Post anyway
          </Button>
        </div>
      ) : null}

      <ProductForm
        open={newItemFor !== null}
        onClose={() => setNewItemFor(null)}
        onSaved={(p) => {
          if (newItemFor === null) return;
          const target = newItemFor;
          setNewItemFor(null);
          update(target, {
            product: {
              id: p.product.id,
              code: p.product.code,
              name: p.product.name,
              piecesPerBox: p.product.piecesPerBox,
              unit: p.product.unit.name,
              trackExpiry: p.product.trackExpiry,
            },
          });
          focusCell(target, 1);
        }}
      />
    </div>
  );
}

function SupplierPicker({
  value,
  onChange,
}: {
  value: Supplier | null;
  onChange: (s: Supplier) => void;
}) {
  const [text, setText] = useState('');
  const [hi, setHi] = useState(0);
  const term = useDebounced(text.trim(), 150);
  const q = useQuery({
    queryKey: ['suppliers', 'pick', term],
    queryFn: () => api.get<{ items: Supplier[] }>(`/api/suppliers${qs({ q: term, limit: 10 })}`),
    enabled: term.length >= 1,
  });
  const items = q.data?.items ?? [];
  const open = term.length >= 1 && items.length > 0;
  return (
    <div className="relative">
      <Field
        label="Supplier"
        hint={
          value
            ? `${value.code} · balance Rs ${formatMoney(value.balance)}`
            : 'Type a code, name or phone.'
        }
      >
        <Input
          autoFocus
          value={text || value?.name || ''}
          onChange={(e) => {
            setText(e.target.value);
            setHi(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown')
              (e.preventDefault(), setHi((h) => Math.min(items.length - 1, h + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(0, h - 1)));
            else if (e.key === 'Enter' && open) {
              e.preventDefault();
              onChange(items[hi]!);
              setText('');
            }
          }}
        />
      </Field>
      {open ? (
        <ul className="absolute z-30 mt-1 w-full rounded-[var(--radius-card)] border border-border bg-surface shadow-lg">
          {items.map((s, i) => (
            <li
              key={s.id}
              onMouseDown={(e) => (e.preventDefault(), onChange(s), setText(''))}
              className={cn(
                'flex cursor-pointer justify-between px-3 py-2 text-sm',
                i === hi && 'bg-selected',
              )}
            >
              <span>
                {s.code} · {s.name}
              </span>
              <span className="num text-muted">Rs {formatMoney(s.balance)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ItemCell({
  row,
  product,
  supplierId,
  onPick,
  onNew,
  onEnterEmpty,
}: {
  row: number;
  product: GrnProduct | null;
  supplierId?: string;
  onPick: (p: StockSearchItem) => void;
  onNew: () => void;
  onEnterEmpty: () => void;
}) {
  const [text, setText] = useState('');
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    width: number;
    transform?: string;
  } | null>(null);

  const term = useDebounced(text.trim(), 150);
  const q = useQuery({
    queryKey: ['products', 'grn-search', term, supplierId],
    queryFn: () =>
      api.get<{ items: StockSearchItem[] }>(`/api/products/search${qs({ q: term, supplierId })}`),
    enabled: term.length >= 1,
  });
  const items = q.data?.items ?? [];
  const open = term.length >= 1;
  const options = items.length + 1;

  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const updateCoords = () => {
      if (inputRef.current) {
        const rect = inputRef.current.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        const openUp = spaceBelow < 220 && rect.top > 220;
        setCoords({
          top: openUp ? rect.top - 4 : rect.bottom + 4,
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 420)),
          width: Math.max(380, rect.width),
          transform: openUp ? 'translateY(-100%)' : undefined,
        });
      }
    };
    updateCoords();
    window.addEventListener('scroll', updateCoords, true);
    window.addEventListener('resize', updateCoords);
    return () => {
      window.removeEventListener('scroll', updateCoords, true);
      window.removeEventListener('resize', updateCoords);
    };
  }, [open]);

  return (
    <div className="relative flex items-center gap-1">
      <Input
        ref={inputRef}
        data-row={row}
        data-col={0}
        placeholder="Code or name"
        value={text || (product ? `${product.code} · ${product.name}` : '')}
        onChange={(e) => {
          setText(e.target.value);
          setHi(0);
        }}
        onBlur={() => {
          setTimeout(() => {
            setText('');
          }, 200);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown')
            (e.preventDefault(), setHi((h) => Math.min(options - 1, h + 1)));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(0, h - 1)));
          else if (e.key === 'Enter' && !e.ctrlKey) {
            e.preventDefault();
            if (open) {
              if (hi < items.length) onPick(items[hi]!);
              else onNew();
              setText('');
            } else if (product) {
              document
                .querySelector<HTMLInputElement>(`[data-row="${row}"][data-col="1"]`)
                ?.focus();
            } else onEnterEmpty();
          } else if (e.key === 'Escape') setText('');
        }}
        className="h-8 w-52 px-2"
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={onNew}
        title="Add new product"
        className="flex h-8 w-7 shrink-0 items-center justify-center rounded border border-border bg-surface-2 text-sm font-semibold text-muted transition hover:bg-surface-3 hover:text-primary"
      >
        +
      </button>
      {open && coords && typeof document !== 'undefined'
        ? createPortal(
            <ul
              style={{
                position: 'fixed',
                top: `${coords.top}px`,
                left: `${coords.left}px`,
                width: `${coords.width}px`,
                transform: coords.transform,
                zIndex: 99999,
                maxHeight: '320px',
                overflowY: 'auto',
              }}
              className="rounded-[var(--radius-card)] border border-border bg-surface shadow-2xl"
            >
              {items.map((p, i) => (
                <li
                  key={p.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onPick(p);
                    setText('');
                  }}
                  className={cn(
                    'flex cursor-pointer justify-between gap-3 px-3 py-2 text-sm hover:bg-surface-2',
                    i === hi && 'bg-selected font-medium',
                  )}
                >
                  <span className="truncate">
                    {p.code} · {p.name}
                  </span>
                  <span className="shrink-0 text-muted">
                    {formatQty(p.stockHere)} {p.unit.name}
                  </span>
                </li>
              ))}
              <li
                onMouseDown={(e) => {
                  e.preventDefault();
                  onNew();
                  setText('');
                }}
                className={cn(
                  'cursor-pointer px-3 py-2 text-sm font-semibold text-accent-strong hover:bg-surface-2',
                  hi === items.length && 'bg-selected',
                )}
              >
                + New item
              </li>
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}

interface PurchaseView {
  id: string;
  no: string;
  status: 'DRAFT' | 'POSTED' | 'REVERSED';
  supplier: { id: string; code: string; name: string };
  supplierInvoiceNo: string;
  date: string;
  ref: string;
  location: { id: string; name: string };
  salesRep: { id: string; name: string } | null;
  netTotal: string;
  supplierInvoiceTotal: string;
  paidAmount: string;
  due: string;
  subtotal?: string;
  invoiceDiscount?: string;
  otherCharges?: string;
  createdBy: string;
  postedBy: string | null;
  postedAt: string | null;
  reversedBy: string | null;
  reverseReason: string;
  lines: {
    id: string;
    lineNo: number;
    product: {
      id: string;
      code: string;
      name: string;
      piecesPerBox: number;
      unit: { name: string };
    };
    subProduct: { id: string; code: string } | null;
    qty: string;
    free: string;
    stockQty: string;
    discountType: 'PERCENT' | 'AMOUNT';
    rPrice: string;
    wPrice: string;
    salesDiscountType: 'PERCENT' | 'AMOUNT';
    salesDiscountValue: string;
    salesPrice: string;
    expiryDate: string | null;
    value?: string;
    discountValue?: string;
    cost?: string;
    amount?: string;
    actualPrice?: string;
    margin?: string;
  }[];
}

function PostedPurchase({
  p,
  askPin,
}: {
  p: PurchaseView;
  askPin: ReturnType<typeof usePinPrompt>;
}) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const ask = useAsk();
  const nav = useNavigate();
  const showCost = p.lines.some((l) => l.cost !== undefined);
  const reopen = async () => {
    try {
      await api.post(`/api/purchases/${p.id}/reopen`);
      toast.success(`${p.no} is a draft again. Its stock and supplier balance were taken back.`);
      await qc.invalidateQueries({ queryKey: ['purchase', p.id] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const reverse = async () => {
    const reason = await ask({
      title: `Reverse ${p.no}`,
      message: 'Its stock and the supplier balance are taken back.',
      label: 'Why is this purchase being reversed?',
      confirmLabel: 'Reverse purchase',
    });
    if (!reason) return;
    try {
      let approval: { pin: string } | undefined;
      if (!can('purchases.approve')) {
        const pin = await askPin('REVERSE_PURCHASE');
        if (!pin) return;
        approval = { pin };
      }
      await api.post(`/api/purchases/${p.id}/reverse`, { reason, approval });
      toast.success(`${p.no} reversed.`);
      await qc.invalidateQueries({ queryKey: ['purchase', p.id] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={`${p.no} · ${p.supplier.name}`}
        description={`${formatDate(p.date)} · invoice ${p.supplierInvoiceNo || '—'} · ${p.location.name}${p.ref ? ` · ${p.ref}` : ''}`}
      >
        <Badge tone={p.status === 'POSTED' ? 'ok' : 'danger'}>{p.status.toLowerCase()}</Badge>
        <IconButton label="Print" icon={<Printer size={17} />} onClick={() => window.print()} />
        {p.status === 'POSTED' && can('purchases.edit') ? (
          <Button icon={<Pencil size={16} />} onClick={() => void reopen()}>
            Edit (if stock unmoved)
          </Button>
        ) : null}
        {p.status === 'POSTED' ? (
          <Button variant="danger" icon={<Undo2 size={16} />} onClick={() => void reverse()}>
            Reverse
          </Button>
        ) : null}
        <Button
          variant="ghost"
          icon={<ArrowLeft size={16} />}
          onClick={() => void nav('/stock/purchases')}
        >
          Back
        </Button>
      </PageHeader>
      {p.status === 'REVERSED' ? (
        <p className="rounded-[8px] bg-danger-soft p-3 text-sm text-danger">
          Reversed by {p.reversedBy}: {p.reverseReason}
        </p>
      ) : null}
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Item</th>
              <th className="px-3 py-2 font-medium">Sub code</th>
              {showCost ? <th className="num px-3 py-2 font-medium">Value</th> : null}
              <th className="num px-3 py-2 font-medium">Qty + free</th>
              {showCost ? <th className="num px-3 py-2 font-medium">Cost</th> : null}
              {showCost ? <th className="num px-3 py-2 font-medium">Amount</th> : null}
              <th className="num px-3 py-2 font-medium">R-price</th>
              <th className="num px-3 py-2 font-medium">W-price</th>
              <th className="num px-3 py-2 font-medium">Sales price</th>
              {showCost ? <th className="num px-3 py-2 font-medium">Margin</th> : null}
              <th className="px-3 py-2 font-medium">Expiry</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l) => (
              <tr key={l.id} className="border-t border-border">
                <td className="px-3 py-2">
                  {l.product.code} · {l.product.name}
                </td>
                <td className="px-3 py-2">{l.subProduct?.code ?? '—'}</td>
                {showCost ? <td className="num px-3 py-2">{formatMoney(l.value)}</td> : null}
                <td className="num px-3 py-2">
                  {formatQty(l.qty)} + {formatQty(l.free)} = {formatQty(l.stockQty)}{' '}
                  {l.product.unit.name}
                </td>
                {showCost ? <td className="num px-3 py-2">{formatMoney(l.cost)}</td> : null}
                {showCost ? <td className="num px-3 py-2">{formatMoney(l.amount)}</td> : null}
                <td className="num px-3 py-2">{formatMoney(l.rPrice)}</td>
                <td className="num px-3 py-2">{formatMoney(l.wPrice)}</td>
                <td className="num px-3 py-2">{formatMoney(l.salesPrice)}</td>
                {showCost ? (
                  <td className="num px-3 py-2 text-ok">{formatMoney(l.margin)}</td>
                ) : null}
                <td className="px-3 py-2">{l.expiryDate ? formatDate(l.expiryDate) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <div className="flex justify-end gap-8 text-[15px]">
        <span>
          Net total <strong className="num">Rs {formatMoney(p.netTotal)}</strong>
        </span>
        <span>
          Paid <Money value={p.paidAmount} />
        </span>
        <span>
          Due <Money value={p.due} />
        </span>
      </div>
    </div>
  );
}
