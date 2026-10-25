import { formatMoney, formatQty, returnRefund } from '@aruna/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Input, Select } from '@/components/ui/input';
import { useReasons } from '@/components/values';
import { api, errorMessage } from '@/lib/api';
import type { SaleDetail } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Row {
  selected: boolean;
  qty: string;
  reasonId: string;
  disposition: 'RESTOCK' | 'DAMAGED';
}

/**
 * R: each line shows the sold qty, the qty already returned and the returnable qty. Space selects
 * lines; the refund is what the customer actually paid for those units.
 */
export function ReturnDialog({
  saleId,
  onClose,
  onDone,
}: {
  saleId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const sale = useQuery({
    queryKey: ['sale', saleId],
    queryFn: () => api.get<SaleDetail>(`/api/sales/${saleId}`),
    enabled: Boolean(saleId),
  });
  const reasons = useReasons('RETURN');
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [hi, setHi] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const lines = (sale.data?.lines ?? []).filter((l) => !l.isLoose && Number(l.returnableQty) > 0);

  useEffect(() => {
    setRows({});
    setHi(0);
    setError('');
  }, [saleId]);

  const row = (id: string, returnable: string): Row =>
    rows[id] ?? {
      selected: false,
      qty: formatQty(returnable),
      reasonId: reasons[0]?.id ?? '',
      disposition: 'RESTOCK',
    };
  const update = (id: string, returnable: string, patch: Partial<Row>) =>
    setRows((r) => ({ ...r, [id]: { ...row(id, returnable), ...patch } }));

  let refund = 0;
  for (const l of sale.data?.lines ?? []) {
    const r = rows[l.id];
    if (!r?.selected) continue;
    try {
      refund += returnRefund(
        {
          soldQty: l.qty,
          returnedQty: l.returnedQty,
          amount: l.amount,
          refundedAmount: l.refundedAmount,
        },
        r.qty,
      ).toNumber();
    } catch {
      // shown by the server on submit
    }
  }

  const submit = async () => {
    const chosen = lines.filter((l) => rows[l.id]?.selected);
    if (!chosen.length) {
      setError('Select at least one line with Space.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ no: string; refundTotal: string }>('/api/returns', {
        saleId,
        lines: chosen.map((l) => {
          const x = row(l.id, l.returnableQty);
          return { saleLineId: l.id, qty: x.qty, reasonId: x.reasonId, disposition: x.disposition };
        }),
      });
      toast.success(`${r.no}: refund Rs ${formatMoney(r.refundTotal)}`);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={Boolean(saleId)}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={`Return from ${sale.data?.no ?? ''}`}
      description="Space selects a line. Ctrl+Enter confirms. Loose paint can't be returned."
      className="max-w-3xl"
      initialFocus={() => box.current}
      footer={
        <>
          <span className="mr-auto self-center text-lg font-semibold">
            Refund about Rs {formatMoney(refund)}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void submit()}
            keyHint="Ctrl+Enter"
          >
            Return
          </Button>
        </>
      }
    >
      <div
        ref={box}
        tabIndex={0}
        className="outline-none"
        onKeyDown={(e) => {
          const l = lines[hi];
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHi((h) => Math.min(lines.length - 1, h + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHi((h) => Math.max(0, h - 1));
          } else if (e.key === ' ' && l && (e.target as HTMLElement).tagName !== 'INPUT') {
            e.preventDefault();
            update(l.id, l.returnableQty, { selected: !row(l.id, l.returnableQty).selected });
          } else if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        {lines.length === 0 ? (
          <p className="py-6 text-center text-muted">Nothing left to return on this bill.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-muted">
              <tr>
                <th className="w-8" />
                <th className="py-1.5 font-medium">Item</th>
                <th className="num font-medium">Sold</th>
                <th className="num font-medium">Returned</th>
                <th className="w-24 pl-2 font-medium">Return qty</th>
                <th className="pl-2 font-medium">Reason</th>
                <th className="pl-2 font-medium">Goes to</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const r = row(l.id, l.returnableQty);
                return (
                  <tr
                    key={l.id}
                    className={cn('border-t border-border', i === hi && 'bg-selected')}
                    onClick={() => setHi(i)}
                  >
                    <td className="py-2">
                      <Checkbox
                        aria-label={`Return ${l.name}`}
                        checked={r.selected}
                        onChange={(e) =>
                          update(l.id, l.returnableQty, { selected: e.target.checked })
                        }
                      />
                    </td>
                    <td className="py-2">{l.name}</td>
                    <td className="num">{formatQty(l.qty)}</td>
                    <td className="num">{formatQty(l.returnedQty)}</td>
                    <td className="pl-2">
                      <Input
                        className="num h-8"
                        value={r.qty}
                        onChange={(e) =>
                          update(l.id, l.returnableQty, { qty: e.target.value, selected: true })
                        }
                      />
                    </td>
                    <td className="pl-2">
                      <Select
                        className="h-8 text-sm"
                        value={r.reasonId}
                        onChange={(e) =>
                          update(l.id, l.returnableQty, { reasonId: e.target.value })
                        }
                      >
                        {reasons.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="pl-2">
                      <Select
                        className="h-8 text-sm"
                        value={r.disposition}
                        onChange={(e) =>
                          update(l.id, l.returnableQty, {
                            disposition: e.target.value as Row['disposition'],
                          })
                        }
                      >
                        <option value="RESTOCK">Restock</option>
                        <option value="DAMAGED">Damaged</option>
                      </Select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
