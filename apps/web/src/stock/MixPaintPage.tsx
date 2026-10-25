import { D, formatDateTime, formatMoney, formatQty } from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { EmptyState, PageHeader } from '@/components/ui/misc';
import { api, errorMessage, qs } from '@/lib/api';
import type { Page, ProductDetail, StockListItem } from '@/lib/types';

interface MixStatus {
  product: { id: string; code: string; name: string };
  subProductId: string;
  litersHere: string;
  litersTotal: string;
  pricePerLiter: string;
  averageCost?: string;
  feeders: { id: string; code: string; name: string; packSize: string | null }[];
}

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
  newAverageCost?: string;
}

/**
 * Transfer to mix paint: choose the can's sub-product and the number of whole cans; the liters go
 * into the mix paint item at a new weighted-average cost. Keep the price or change it, never
 * below the new average cost.
 */
export function MixPaintPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const mixes = useQuery({
    queryKey: ['products', 'mix-items'],
    queryFn: () =>
      api.get<Page<StockListItem>>(`/api/products${qs({ type: 'MIX', pageSize: 200 })}`),
  });
  const [mixId, setMixId] = useState('');
  const selectedMix = mixId || mixes.data?.items[0]?.id || '';
  const status = useQuery({
    queryKey: ['mix', selectedMix],
    queryFn: () => api.get<MixStatus>(`/api/mix-paint/${selectedMix}`),
    enabled: Boolean(selectedMix),
  });
  const transfers = useQuery({
    queryKey: ['mix', 'transfers'],
    queryFn: () => api.get<{ items: Transfer[] }>('/api/mix-paint/transfers'),
  });
  const [feederId, setFeederId] = useState('');
  const feeder = feederId || status.data?.feeders[0]?.id || '';
  const cans = useQuery({
    queryKey: ['product', feeder],
    queryFn: () => api.get<ProductDetail>(`/api/products/${feeder}`),
    enabled: Boolean(feeder),
  });
  const [subId, setSubId] = useState('');
  const [count, setCount] = useState('1');
  const [price, setPrice] = useState('');
  const [error, setError] = useState('');
  const inStock = (cans.data?.subProducts ?? []).filter(
    (s) => !s.hidden && Number(s.totalStock) > 0,
  );
  const source = subId || inStock[0]?.id || '';
  const sourceSub = inStock.find((s) => s.id === source);
  const pack = D(cans.data?.product.packSize ?? 0);
  const addLiters = pack.times(Number(count || 0));
  const preview =
    status.data?.averageCost !== undefined && sourceSub?.actualPrice && pack.greaterThan(0)
      ? D(status.data.litersTotal)
          .times(D(status.data.averageCost))
          .plus(addLiters.times(D(sourceSub.actualPrice).dividedBy(pack)))
          .dividedBy(D(status.data.litersTotal).plus(addLiters))
      : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api.post<{
        no: string;
        liters: string;
        newAverageCost: string;
        pricePerLiter: string;
      }>('/api/mix-paint/transfers', {
        sourceSubProductId: source,
        cans: Number(count),
        pricePerLiter: price.trim() || null,
      });
      toast.success(
        `${r.no}: ${formatQty(r.liters)} L added at Rs ${formatMoney(r.pricePerLiter)} per L.`,
      );
      setPrice('');
      await qc.invalidateQueries({ queryKey: ['mix'] });
      await qc.invalidateQueries({ queryKey: ['product'] });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Mix paint"
        description="Cans become liters of mix paint (MP-code), sold loose by the liter."
      />
      {mixes.data?.items.length === 0 ? (
        <EmptyState
          title="No mix paint items yet."
          action="Tick “Sold loose from mix paint” on a paint product."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Mix paint item</CardTitle>
              <Select
                aria-label="Mix paint item"
                value={selectedMix}
                onChange={(e) => (setMixId(e.target.value), setFeederId(''), setSubId(''))}
                className="w-64"
              >
                {(mixes.data?.items ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.code} · {m.name}
                  </option>
                ))}
              </Select>
            </CardHeader>
            <CardBody>
              {status.data ? (
                <div className="grid grid-cols-3 gap-4 rounded-[var(--radius-card)] bg-surface-2 p-4 text-center">
                  <div>
                    <div className="text-sm text-muted">Liters here</div>
                    <div className="num text-2xl font-bold">
                      {formatQty(status.data.litersHere)}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-muted">Price per L</div>
                    <div className="num text-2xl font-bold">
                      {formatMoney(status.data.pricePerLiter)}
                    </div>
                  </div>
                  {status.data.averageCost !== undefined ? (
                    <div>
                      <div className="text-sm text-muted">Average cost per L</div>
                      <div className="num text-2xl font-bold">
                        {formatMoney(status.data.averageCost)}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {can('mix_paint.create') && status.data ? (
                <form onSubmit={submit} className="mt-4 grid grid-cols-2 gap-3">
                  <Field label="Paint size">
                    <Select
                      value={feeder}
                      onChange={(e) => (setFeederId(e.target.value), setSubId(''))}
                    >
                      {status.data.feeders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.code} · {f.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Can (sub-product)">
                    <Select value={source} onChange={(e) => setSubId(e.target.value)}>
                      {inStock.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.code} · {formatQty(s.totalStock)} cans
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Whole cans" hint={`= ${formatQty(addLiters)} L`}>
                    <Input
                      inputMode="numeric"
                      className="num"
                      value={count}
                      onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))}
                    />
                  </Field>
                  <Field
                    label="New price per L"
                    hint={
                      preview
                        ? `New average cost about Rs ${formatMoney(preview)}`
                        : 'Empty keeps the price.'
                    }
                  >
                    <Input
                      className="num"
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                      placeholder={status.data.pricePerLiter}
                    />
                  </Field>
                  {error ? <p className="col-span-2 text-sm text-danger">{error}</p> : null}
                  <Button
                    type="submit"
                    variant="primary"
                    className="col-span-2"
                    disabled={!source || !count}
                  >
                    Move to mix paint
                  </Button>
                </form>
              ) : null}
            </CardBody>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Recent transfers</CardTitle>
            </CardHeader>
            <CardBody className="p-0">
              <table className="w-full text-sm">
                <tbody>
                  {(transfers.data?.items ?? []).slice(0, 20).map((t) => (
                    <tr key={t.id} className="border-t border-border first:border-t-0">
                      <td className="px-4 py-2">
                        <div className="font-medium">
                          {t.no} · {t.cans} × {t.source.code} → {formatQty(t.liters)} L {t.mix.code}
                        </div>
                        <div className="text-muted">
                          {formatDateTime(t.at)} · {t.by}
                          {t.approvedBy ? ` (PIN ${t.approvedBy})` : ''}
                          {t.fromCounter ? ' · at the counter' : ''}
                          {t.oldPricePerLiter !== t.newPricePerLiter
                            ? ` · price ${formatMoney(t.oldPricePerLiter)} → ${formatMoney(t.newPricePerLiter)}`
                            : ''}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
