import { D, formatDateTime, formatMoney, formatQty } from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/misc';
import { api, errorMessage, qs } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import type { Page, ProductDetail, StockListItem } from '@/lib/types';

interface Transfer {
  id: string;
  no: string;
  at: string;
  source: { code: string; name: string };
  mix: { code: string; name: string };
  cans: number;
  liters: string;
  oldPricePerLiter: string;
  newPricePerLiter: string;
  fromCounter: boolean;
  by: string;
  approvedBy: string | null;
  costPerLiter?: string;
  newAverageCost?: string;
}

export function MixPaintPage() {
  const { can } = useAuth();
  const qc = useQueryClient();

  // Search for paint product to transfer
  const [paintSearch, setPaintSearch] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<StockListItem | null>(null);
  const debouncedSearch = useDebounced(paintSearch.trim(), 150);

  const searchResults = useQuery({
    queryKey: ['products', 'paint-search', debouncedSearch],
    queryFn: () =>
      api.get<Page<StockListItem>>(
        `/api/products${qs({ q: debouncedSearch, type: 'STANDARD', pageSize: 15 })}`,
      ),
    enabled: debouncedSearch.length >= 1 && !selectedProduct,
  });

  // Load detailed product with sub-products/batches to check stock
  const productDetail = useQuery({
    queryKey: ['product', selectedProduct?.id],
    queryFn: () => api.get<ProductDetail>(`/api/products/${selectedProduct!.id}`),
    enabled: Boolean(selectedProduct?.id),
  });

  // All mix paint items and stock
  const mixItems = useQuery({
    queryKey: ['products', 'mix-items'],
    queryFn: () =>
      api.get<Page<StockListItem>>(`/api/products${qs({ type: 'MIX', pageSize: 200 })}`),
  });

  // Recent transfers history
  const transfers = useQuery({
    queryKey: ['mix', 'transfers'],
    queryFn: () => api.get<{ items: Transfer[] }>('/api/mix-paint/transfers'),
  });

  const [cansCount, setCansCount] = useState('1');
  const [adminCanPrice, setAdminCanPrice] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Available stock of whole cans
  const inStockBatches = (productDetail.data?.subProducts ?? []).filter(
    (s) => !s.hidden && Number(s.totalStock) > 0,
  );
  const selectedSub = inStockBatches[0];

  const packSize = Number(
    (selectedProduct?.packSize ?? selectedProduct?.unit?.name === 'can') ? '4' : '1',
  );
  const canLiters = D(packSize > 0 ? packSize : 1);
  const cansNum = Math.max(1, parseInt(cansCount || '1', 10) || 1);
  const totalLiters = canLiters.times(cansNum);

  // Price calculation: Admin Price / Can Size = Price per 1L
  const calculatedPricePerLiter =
    adminCanPrice.trim() && canLiters.greaterThan(0)
      ? D(adminCanPrice).dividedBy(canLiters).toFixed(2)
      : selectedSub?.salesPrice && canLiters.greaterThan(0)
        ? D(selectedSub.salesPrice).dividedBy(canLiters).toFixed(2)
        : '0.00';

  const onSelectPaint = (p: StockListItem) => {
    setSelectedProduct(p);
    setPaintSearch(`${p.code} · ${p.name}`);
    setCansCount('1');
    setError('');
  };

  const clearSelection = () => {
    setSelectedProduct(null);
    setPaintSearch('');
    setCansCount('1');
    setAdminCanPrice('');
    setError('');
  };

  const submitTransfer = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedProduct) return;
    setError('');
    setSubmitting(true);

    try {
      const r = await api.post<{
        no: string;
        liters: string;
        pricePerLiter: string;
      }>('/api/mix-paint/transfers', {
        sourceProductId: selectedProduct.id,
        sourceSubProductId: selectedSub?.id ?? null,
        cans: cansNum,
        adminCanPrice: adminCanPrice.trim() || null,
        pricePerLiter: calculatedPricePerLiter,
      });

      toast.success(
        `${r.no}: Transferred ${cansNum} can(s) (${formatQty(r.liters)} L) to Mix Paint at Rs ${formatMoney(r.pricePerLiter)}/L.`,
      );
      clearSelection();
      await qc.invalidateQueries({ queryKey: ['products'] });
      await qc.invalidateQueries({ queryKey: ['mix'] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Mix paint"
        description="Transfer whole cans to Mix Paint (MP) stock. 1 can transfers based on can size (e.g. 4L can = 4 units in MP). Sold strictly at POS."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Transfer Form Card */}
        <Card>
          <CardHeader>
            <CardTitle>Transfer Can to Mix Paint (MP)</CardTitle>
          </CardHeader>
          <CardBody>
            <form onSubmit={submitTransfer} className="flex flex-col gap-4">
              {/* Paint Product Search */}
              <div className="relative">
                <Field
                  label="Search paint to mix"
                  hint="Type paint name or code to select from stock"
                >
                  <div className="flex gap-2">
                    <Input
                      autoFocus
                      placeholder="e.g. Apex 4L, Dulux, 10007..."
                      value={paintSearch}
                      onChange={(e) => {
                        setPaintSearch(e.target.value);
                        if (selectedProduct) setSelectedProduct(null);
                      }}
                      className="flex-1"
                    />
                    {selectedProduct ? (
                      <Button type="button" variant="ghost" onClick={clearSelection}>
                        Change
                      </Button>
                    ) : null}
                  </div>
                </Field>

                {/* Search Suggestions Dropdown */}
                {searchResults.data?.items &&
                searchResults.data.items.length > 0 &&
                !selectedProduct ? (
                  <ul className="absolute left-0 right-0 top-[70px] z-30 max-h-60 overflow-y-auto rounded-lg border border-border bg-surface shadow-xl">
                    {searchResults.data.items.map((p) => (
                      <li
                        key={p.id}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          onSelectPaint(p);
                        }}
                        className="flex cursor-pointer items-center justify-between gap-4 px-3 py-2 hover:bg-surface-2"
                      >
                        <span className="font-medium">
                          {p.code} · {p.name}
                        </span>
                        <span className="text-sm text-muted">
                          {formatQty(p.stock)} {p.unit.name} in stock
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              {/* Selected Paint Info Box */}
              {selectedProduct ? (
                <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm">
                  <div className="flex items-center justify-between font-semibold">
                    <span>
                      {selectedProduct.code} · {selectedProduct.name}
                    </span>
                    <Badge tone={Number(selectedProduct.stock) > 0 ? 'ok' : 'danger'}>
                      {formatQty(selectedProduct.stock)} {selectedProduct.unit.name} available
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    Can size: {canLiters.toString()} L · Brand: {selectedProduct.brand?.name ?? '—'}
                  </div>
                </div>
              ) : null}

              {/* Transfer Details (When product selected) */}
              {selectedProduct ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Cans to transfer" hint={`1 can = ${canLiters.toString()} L in MP`}>
                    <Input
                      type="number"
                      min="1"
                      className="num"
                      value={cansCount}
                      onChange={(e) => setCansCount(e.target.value)}
                    />
                  </Field>

                  <Field
                    label="Admin can price (Rs)"
                    hint="Total price set by admin for the whole can"
                  >
                    <Input
                      type="number"
                      step="0.01"
                      className="num"
                      placeholder={selectedSub?.salesPrice ?? 'Can Price'}
                      value={adminCanPrice}
                      onChange={(e) => setAdminCanPrice(e.target.value)}
                    />
                  </Field>

                  {/* Summary Calculation Banner */}
                  <div className="rounded-lg bg-surface-3 p-3 sm:col-span-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted">Total units added to MP:</span>
                      <span className="num font-bold text-primary">
                        {cansNum} can × {canLiters.toString()}L = {formatQty(totalLiters)} L (units)
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-sm">
                      <span className="text-muted">Calculated selling price per 1L:</span>
                      <span className="num font-bold text-ok">
                        Rs {formatMoney(calculatedPricePerLiter)} / L
                        <span className="ml-1 text-xs text-muted">
                          ({adminCanPrice || selectedSub?.salesPrice || '0'} ÷{' '}
                          {canLiters.toString()})
                        </span>
                      </span>
                    </div>
                  </div>

                  {error ? <p className="text-sm text-danger sm:col-span-2">{error}</p> : null}

                  {can('mix_paint.create') ? (
                    <Button
                      type="submit"
                      variant="primary"
                      className="mt-2 sm:col-span-2"
                      disabled={submitting || Number(selectedProduct.stock) <= 0}
                    >
                      {submitting ? 'Transferring...' : 'Transfer to Mix Paint'}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </form>
          </CardBody>
        </Card>

        {/* Mix Paint Stock Summary */}
        <Card>
          <CardHeader>
            <CardTitle>Current Mix Paint Stock (MP-)</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            <div className="max-h-[380px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2">Brand</th>
                    <th className="num px-3 py-2">Stock</th>
                    <th className="px-3 py-2">State</th>
                  </tr>
                </thead>
                <tbody>
                  {(mixItems.data?.items ?? []).map((m) => (
                    <tr key={m.id} className="border-t border-border hover:bg-surface-2">
                      <td className="px-3 py-2">
                        <div className="font-semibold">{m.code}</div>
                        <div className="text-xs text-muted">{m.name}</div>
                      </td>
                      <td className="px-3 py-2 text-muted">{m.brand?.name ?? '—'}</td>
                      <td className="num px-3 py-2 font-bold text-ok">{formatQty(m.stock)} L</td>
                      <td className="px-3 py-2">
                        {m.outOfStock ? (
                          <Badge tone="danger">Out of stock</Badge>
                        ) : (
                          <Badge tone="ok">In stock</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                  {mixItems.data?.items.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-muted">
                        No mix paint stock yet. Search a paint and transfer above.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Recent Transfers History Table */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Transfers to Mix Paint</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-4 py-2">Transfer No</th>
                  <th className="px-4 py-2">Source Paint</th>
                  <th className="px-4 py-2">Target MP</th>
                  <th className="num px-4 py-2">Cans</th>
                  <th className="num px-4 py-2">Transferred (L)</th>
                  <th className="num px-4 py-2">Price / 1L</th>
                  <th className="px-4 py-2">Transferred by</th>
                  <th className="px-4 py-2">Date & Time</th>
                </tr>
              </thead>
              <tbody>
                {(transfers.data?.items ?? []).slice(0, 25).map((t) => (
                  <tr key={t.id} className="border-t border-border hover:bg-surface-2">
                    <td className="px-4 py-2 font-semibold">{t.no}</td>
                    <td className="px-4 py-2">
                      {t.source.code} · {t.source.name}
                    </td>
                    <td className="px-4 py-2 text-primary font-medium">
                      {t.mix.code} · {t.mix.name}
                    </td>
                    <td className="num px-4 py-2">{t.cans} can</td>
                    <td className="num px-4 py-2 font-bold text-ok">{formatQty(t.liters)} L</td>
                    <td className="num px-4 py-2">Rs {formatMoney(t.newPricePerLiter)}</td>
                    <td className="px-4 py-2 text-muted">{t.by}</td>
                    <td className="px-4 py-2 text-muted">{formatDateTime(t.at)}</td>
                  </tr>
                ))}
                {transfers.data?.items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-6 text-center text-muted">
                      No transfers yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
