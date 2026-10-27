import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatQty,
  parseDiscountText,
} from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Checkbox, Input } from '@/components/ui/input';
import { EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import type { ProductDetail, SubProduct } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ProductForm } from './ProductForm';

interface BinCard {
  subProduct: { code: string; name: string; unit: string };
  openingBalance: string;
  rows: {
    id: string;
    at: string;
    type: string;
    docNo: string;
    location: string;
    in: string | null;
    out: string | null;
    balance: string;
    user: string;
    note: string;
    unitCost?: string;
  }[];
  closingBalance: string;
}

export function ProductDetailPage() {
  const { id } = useParams();
  const { can, me } = useAuth();
  const [editing, setEditing] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [hi, setHi] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [binFor, setBinFor] = useState<SubProduct | null>(null);
  const [pricing, setPricing] = useState(false);
  const q = useQuery({
    queryKey: ['product', id],
    queryFn: () => api.get<ProductDetail>(`/api/products/${id}`),
  });
  if (q.isLoading) return <Spinner />;
  if (!q.data) return <EmptyState title="Product not found." />;
  const { product, subProducts, feeders } = q.data;
  const subs = subProducts.filter((s) => showHidden || !s.hidden);
  const showCost = subs.some((s) => s.costPrice !== undefined);
  const toggle = (sid: string) =>
    setPicked((p) =>
      p.has(sid) ? new Set([...p].filter((x) => x !== sid)) : new Set([...p, sid]),
    );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={`${product.code} · ${product.name}`}
        description={[product.category?.name, product.brand?.name, product.unit.name]
          .filter(Boolean)
          .join(' · ')}
      >
        {can('products.edit') && product.type === 'STANDARD' ? (
          <Button onClick={() => setPricing(true)}>Change prices</Button>
        ) : null}
        {can('products.edit') ? (
          <Button variant="primary" onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : null}
      </PageHeader>
      <div className="flex flex-wrap gap-2 text-sm">
        {product.allowLooseSale && product.mixProduct ? (
          <Badge tone="accent">
            Sold loose:{' '}
            <Link to={`/stock/products/${product.mixProduct.id}`} className="underline">
              {product.mixProduct.code}
            </Link>
          </Badge>
        ) : null}
        {product.packSize ? <Badge>{formatQty(product.packSize)} L per can</Badge> : null}
        {product.piecesPerBox > 1 ? (
          <Badge>
            {product.piecesPerBox} per {product.buyingUnit?.name ?? 'box'}
          </Badge>
        ) : null}
        <Badge>
          Reorder at {formatQty(product.reorderLevel)}, order {formatQty(product.reorderQty)}
        </Badge>
        {product.trackExpiry ? <Badge tone="warn">Tracks expiry</Badge> : null}
        {!product.active ? <Badge tone="danger">Inactive</Badge> : null}
        {feeders.length ? (
          <Badge tone="accent">Filled from {feeders.map((f) => f.code).join(', ')}</Badge>
        ) : null}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Sub-products</CardTitle>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show
            zero-stock sub-products
          </label>
        </CardHeader>
        <div
          tabIndex={0}
          className="overflow-x-auto outline-none"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown')
              (e.preventDefault(), setHi((h) => Math.min(subs.length - 1, h + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(0, h - 1)));
            else if (e.key === 'Enter' && subs[hi]) (e.preventDefault(), setBinFor(subs[hi]));
            else if (e.key === ' ' && subs[hi]) (e.preventDefault(), toggle(subs[hi].id));
          }}
        >
          {subs.length === 0 ? (
            <EmptyState title="No stock yet." action="Stock arrives with a purchase (GRN)." />
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-muted">
                <tr>
                  <th className="w-8 px-3 py-2" />
                  <th className="px-3 py-2 font-medium">Sub code</th>
                  <th className="px-3 py-2 font-medium">Supplier</th>
                  <th className="num px-3 py-2 font-medium">R-price</th>
                  <th className="num px-3 py-2 font-medium">W-price</th>
                  <th className="num px-3 py-2 font-medium">Sales disc</th>
                  <th className="num px-3 py-2 font-medium">Sales price</th>
                  <th className="num px-3 py-2 font-medium">Max off</th>
                  {showCost ? (
                    <>
                      <th className="num px-3 py-2 font-medium">Cost</th>
                      <th className="num px-3 py-2 font-medium">Actual</th>
                      <th className="num px-3 py-2 font-medium">Margin</th>
                    </>
                  ) : null}
                  <th className="px-3 py-2 font-medium">Expiry</th>
                  <th className="px-3 py-2 font-medium">Stock</th>
                </tr>
              </thead>
              <tbody>
                {subs.map((s, i) => (
                  <tr
                    key={s.id}
                    onClick={() => setHi(i)}
                    onDoubleClick={() => setBinFor(s)}
                    className={cn(
                      'border-t border-border',
                      i === hi && 'bg-selected',
                      s.hidden && 'text-muted',
                    )}
                  >
                    <td className="px-3 py-2">
                      <Checkbox
                        aria-label={`Pick ${s.code}`}
                        checked={picked.has(s.id)}
                        onChange={() => toggle(s.id)}
                      />
                    </td>
                    <td className="px-3 py-2 font-medium">{s.code}</td>
                    <td className="px-3 py-2">{s.supplier?.name ?? '—'}</td>
                    <td className="num px-3 py-2">{formatMoney(s.rPrice)}</td>
                    <td className="num px-3 py-2">{formatMoney(s.wPrice)}</td>
                    <td className="num px-3 py-2">{formatMoney(s.salesDiscount)}</td>
                    <td className="num px-3 py-2 font-medium">{formatMoney(s.salesPrice)}</td>
                    <td className="num px-3 py-2">{formatMoney(s.maxDiscount)}</td>
                    {showCost ? (
                      <>
                        <td className="num px-3 py-2">{formatMoney(s.costPrice)}</td>
                        <td className="num px-3 py-2">{formatMoney(s.actualPrice)}</td>
                        <td className="num px-3 py-2 text-ok">{formatMoney(s.margin)}</td>
                      </>
                    ) : null}
                    <td className="px-3 py-2">{s.expiryDate ? formatDate(s.expiryDate) : '—'}</td>
                    <td className="px-3 py-2">
                      {s.hidden ? (
                        <Badge>Zero everywhere</Badge>
                      ) : (
                        s.stock.map((x) => `${x.location} ${formatQty(x.qty)}`).join(' · ')
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <CardBody className="py-2 text-sm text-muted">
          ↑↓ move · Enter opens the bin card · Space picks rows for a price change.
        </CardBody>
      </Card>
      {me.roles.includes('SUPER_ADMIN') ? <RenameHistory productId={product.id} /> : null}
      <ProductForm open={editing} product={product} onClose={() => setEditing(false)} />
      <BinCardDialog sub={binFor} onClose={() => setBinFor(null)} />
      <PriceDialog
        open={pricing}
        productId={product.id}
        subIds={[...picked]}
        subs={subProducts}
        onClose={() => setPricing(false)}
      />
    </div>
  );
}

function BinCardDialog({ sub, onClose }: { sub: SubProduct | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['bin-card', sub?.id],
    queryFn: () => api.get<BinCard>(`/api/sub-products/${sub!.id}/bin-card`),
    enabled: Boolean(sub),
  });
  const showCost = q.data?.rows.some((r) => r.unitCost !== undefined);
  return (
    <Dialog
      open={Boolean(sub)}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={`Bin card · ${sub?.code ?? ''}`}
      description="Every movement with a running balance."
      className="max-w-4xl"
    >
      {!q.data ? (
        <Spinner />
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1.5 font-medium">Date</th>
              <th className="font-medium">Type</th>
              <th className="font-medium">Document</th>
              <th className="font-medium">Location</th>
              <th className="num font-medium">In</th>
              <th className="num font-medium">Out</th>
              <th className="num font-medium">Balance</th>
              {showCost ? <th className="num font-medium">Unit cost</th> : null}
              <th className="pl-3 font-medium">By</th>
            </tr>
          </thead>
          <tbody>
            {q.data.rows.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="py-1.5">{formatDateTime(r.at)}</td>
                <td>{r.type.replace(/_/g, ' ').toLowerCase()}</td>
                <td>{r.docNo}</td>
                <td>{r.location}</td>
                <td className="num text-ok">{r.in ? formatQty(r.in) : ''}</td>
                <td className="num text-danger">{r.out ? formatQty(r.out) : ''}</td>
                <td className="num font-medium">{formatQty(r.balance)}</td>
                {showCost ? <td className="num">{formatMoney(r.unitCost)}</td> : null}
                <td className="pl-3">{r.user}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

/** Admins can change the selling prices of one sub-product, or of all of them at once. */
function PriceDialog({
  open,
  productId,
  subIds,
  subs,
  onClose,
}: {
  open: boolean;
  productId: string;
  subIds: string[];
  subs: SubProduct[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    rPrice: '',
    wPrice: '',
    salesDiscount: '',
    salesPrice: '',
    note: '',
  });
  const [error, setError] = useState('');
  const target = subIds.length ? subs.filter((s) => subIds.includes(s.id)) : subs;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const disc = form.salesDiscount.trim() ? parseDiscountText(form.salesDiscount) : undefined;
    if (form.salesDiscount.trim() && !disc) {
      setError('Type the discount as 50 or 5%.');
      return;
    }
    try {
      const r = await api.post<{ changed: unknown[] }>(`/api/products/${productId}/prices`, {
        subProductIds: subIds,
        rPrice: form.rPrice || undefined,
        wPrice: form.wPrice || undefined,
        salesDiscount: disc,
        salesPrice: form.salesPrice || undefined,
        note: form.note,
      });
      toast.success(`${r.changed.length} sub-products changed. Kept in price history.`);
      await qc.invalidateQueries({ queryKey: ['product', productId] });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title="Change prices"
      description={`For ${target.map((s) => s.code).join(', ') || 'all sub-products'}. Leave a box empty to keep it.`}
    >
      <form onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="R-price">
          <Input
            autoFocus
            className="num"
            value={form.rPrice}
            onChange={(e) => setForm({ ...form, rPrice: e.target.value })}
          />
        </Field>
        <Field label="W-price">
          <Input
            className="num"
            value={form.wPrice}
            onChange={(e) => setForm({ ...form, wPrice: e.target.value })}
          />
        </Field>
        <Field label="Sales discount" hint="50 or 5%">
          <Input
            className="num"
            value={form.salesDiscount}
            onChange={(e) => setForm({ ...form, salesDiscount: e.target.value })}
          />
        </Field>
        <Field label="Sales price" hint="Wins over the discount">
          <Input
            className="num"
            value={form.salesPrice}
            onChange={(e) => setForm({ ...form, salesPrice: e.target.value })}
          />
        </Field>
        <Field label="Note" className="col-span-2">
          <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
        {error ? <p className="col-span-2 text-sm text-danger">{error}</p> : null}
        <div className="col-span-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Change prices
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface RenameEntry {
  at: string;
  by: string;
  subProduct: string | null;
  changes: { field: 'code' | 'name' | 'printName'; from: string; to: string }[];
  note: string;
}

const FIELD_LABELS = { code: 'Code', name: 'Name', printName: 'Receipt name' } as const;

/** Super Admin only: every code and name change ("10001 was changed to 30001") and who made it. */
function RenameHistory({ productId }: { productId: string }) {
  const q = useQuery({
    queryKey: ['product', productId, 'renames'],
    queryFn: () => api.get<{ items: RenameEntry[] }>(`/api/products/${productId}/renames`),
  });
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Name and code changes</CardTitle>
        <span className="text-sm text-muted">Old bills show the new code and name.</span>
      </CardHeader>
      <ol className="divide-y divide-border">
        {items.map((e, i) => (
          <li key={i} className="flex flex-col gap-1.5 px-5 py-3 sm:flex-row sm:gap-6">
            <div className="w-44 shrink-0 text-sm text-muted">
              <div>{formatDateTime(e.at)}</div>
              <div>by {e.by}</div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {e.changes.map((c) => (
                <div key={c.field} className="flex flex-wrap items-center gap-2 text-[15px]">
                  <span className="w-28 shrink-0 text-sm text-muted">
                    {e.subProduct ? `${e.subProduct} name` : FIELD_LABELS[c.field]}
                  </span>
                  <span className="text-muted line-through decoration-muted/50">
                    {c.from || '—'}
                  </span>
                  <ArrowRight size={14} className="text-muted" aria-label="changed to" />
                  <span className="font-medium">{c.to || '—'}</span>
                </div>
              ))}
              {e.note ? <p className="text-sm text-muted">{e.note}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
