import { formatMoney, formatTime } from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface HeldBill {
  id: string;
  kind: 'INVOICE' | 'QUOTATION';
  heldAt: string;
  cashier: string;
  counter: string;
  wholesale: boolean;
  customerName: string;
  customerPhone: string;
  itemCount: number;
  netTotal: string;
  lines: (
    | {
        kind: 'BATCH';
        productId: string;
        subProductId: string;
        qty: string;
        discount: { type: 'AMOUNT'; value: string } | null;
      }
    | { kind: 'LOOSE'; productId: string; liters: string; pricePerLiter: null }
  )[];
}

/** F8 lists held bills to resume; Delete discards one. */
export function HeldBillsDialog({
  open,
  onClose,
  onRecall,
}: {
  open: boolean;
  onClose: () => void;
  onRecall: (bill: HeldBill) => void;
}) {
  const qc = useQueryClient();
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const held = useQuery({
    queryKey: ['held'],
    queryFn: () => api.get<{ items: HeldBill[] }>('/api/sales/held'),
    enabled: open,
  });
  const items = held.data?.items ?? [];
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title="Held bills"
      description="↑↓ to pick, Enter to resume, Delete to discard."
      initialFocus={() => box.current}
    >
      <div
        ref={box}
        tabIndex={0}
        className="outline-none"
        onKeyDown={async (e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHi((h) => Math.min(items.length - 1, h + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHi((h) => Math.max(0, h - 1));
          } else if (e.key === 'Enter' && items[hi]) {
            e.preventDefault();
            onRecall(items[hi]);
          } else if (e.key === 'Delete' && items[hi]) {
            e.preventDefault();
            try {
              await api.delete(`/api/sales/held/${items[hi].id}`);
              await qc.invalidateQueries({ queryKey: ['held'] });
              setHi(0);
              toast.success('Held bill discarded.');
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }
        }}
      >
        {items.length === 0 ? (
          <EmptyState title="No held bills." action="Park the current bill with" keys="F7" />
        ) : (
          <ul role="listbox" aria-label="Held bills">
            {items.map((b, i) => (
              <li
                key={b.id}
                role="option"
                aria-selected={i === hi}
                onClick={() => onRecall(b)}
                className={cn(
                  'flex cursor-pointer items-center justify-between rounded-[8px] px-3 py-2',
                  i === hi && 'bg-selected',
                )}
              >
                <span>
                  <span className="font-medium">{formatTime(b.heldAt)}</span> · {b.cashier} ·{' '}
                  {b.counter}
                  {b.customerName ? ` · ${b.customerName}` : ''}
                  {b.kind === 'QUOTATION' ? ' · quotation' : ''}
                </span>
                <span className="num">
                  {b.itemCount} items · Rs {formatMoney(b.netTotal)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
