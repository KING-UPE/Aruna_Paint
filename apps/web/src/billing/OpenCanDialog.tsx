import { D, formatMoney, formatQty } from '@aruna/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { api, ApiError, errorMessage, qs } from '@/lib/api';
import type { BillingItem } from '@/lib/types';

export interface OpenCanRequest {
  item: BillingItem;
  litersNeeded: string;
  resolve: (item: BillingItem | null) => void;
}

/**
 * The mix paint runs short: a can must go into mix paint first. Only Stock Managers and Admins
 * move cans, so one of them types their PIN here unless the user can do it themselves.
 */
export function OpenCanDialog({
  request,
  onClose,
}: {
  request: OpenCanRequest | null;
  onClose: () => void;
}) {
  const { can } = useAuth();
  const self = can('mix_paint.create');
  const [batchId, setBatchId] = useState('');
  const [cans, setCans] = useState('1');
  const [pin, setPin] = useState('');
  const [price, setPrice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!request) return;
    const pack = D(request.item.packSize ?? 1);
    setBatchId(request.item.batches[0]?.id ?? '');
    setCans(String(Math.max(1, D(request.litersNeeded).dividedBy(pack).ceil().toNumber())));
    setPin('');
    setPrice('');
    setError('');
  }, [request]);

  if (!request) return null;
  const { item } = request;
  const noPrice = !D(item.mix?.pricePerLiter ?? 0).greaterThan(0);

  const finish = (result: BillingItem | null) => {
    request.resolve(result);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/mix-paint/transfers', {
        sourceSubProductId: batchId,
        cans: Number(cans),
        pricePerLiter: price.trim() || null,
        approval: self ? undefined : { pin },
      });
      const fresh = await api.get<{ items: BillingItem[] }>(
        `/api/billing/items/by-products${qs({ ids: item.productId })}`,
      );
      finish(fresh.items[0] ?? null);
    } catch (err) {
      setError(
        err instanceof ApiError && err.field === 'pricePerLiter'
          ? `${err.message}`
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => (!o ? finish(null) : undefined)}
      title="Open a can into mix paint"
      description={`${formatQty(item.mix?.litersHere)} L of ${item.mix?.name} here; ${formatQty(request.litersNeeded)} L more are needed.`}
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        {item.batches.length === 0 ? (
          <p className="text-sm text-danger">No cans of {item.name} in stock here.</p>
        ) : (
          <>
            <Field label="Can">
              <Select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
                {item.batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} · {formatQty(b.available)} in stock
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Whole cans" hint={`1 can = ${formatQty(item.packSize)} L`}>
              <Input
                autoFocus
                inputMode="numeric"
                value={cans}
                onChange={(e) => setCans(e.target.value.replace(/\D/g, ''))}
                className="num"
              />
            </Field>
            {noPrice ? (
              <Field label="Price per liter (Rs)" hint="This mix paint has no price yet.">
                <Input
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className="num"
                />
              </Field>
            ) : (
              <p className="text-sm text-muted">
                Price stays Rs {formatMoney(item.mix?.pricePerLiter)} per L.
              </p>
            )}
            {!self ? (
              <Field label="Stock Manager or Admin PIN">
                <Input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                />
              </Field>
            ) : null}
          </>
        )}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !batchId || !cans || (!self && pin.length < 4)}
          >
            Open can
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
