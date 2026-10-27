import { formatMoney, formatTime } from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAsk } from '@/components/AskDialog';
import { Dialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
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

/**
 * F8 lists held bills to resume. The bin button or the Delete key deletes one with a reason;
 * it stays in bill history under Deleted, so nothing rung up disappears.
 */
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
  const ask = useAsk();

  const discard = async (b: HeldBill) => {
    const reason = await ask({
      title: 'Delete this held bill?',
      message: `Held at ${formatTime(b.heldAt)} by ${b.cashier}${b.customerName ? ` for ${b.customerName}` : ''}: ${b.itemCount} items, Rs ${formatMoney(b.netTotal)}. It stays in bill history under Deleted, with your name and the reason.`,
      label: 'Why is it being deleted?',
      confirmLabel: 'Delete held bill',
      check: (v) => (v.length < 3 ? 'Say why, in a few words.' : null),
      danger: true,
      returnFocus: () => box.current,
    });
    if (!reason) return;
    try {
      await api.post(`/api/sales/held/${b.id}/delete`, { reason });
      await qc.invalidateQueries({ queryKey: ['held'] });
      setHi((h) => Math.max(0, Math.min(h, items.length - 2)));
      toast.success('Held bill deleted.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title="Held bills"
      description="↑↓ to pick, Enter to resume, Delete to delete."
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
            await discard(items[hi]);
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
                onPointerMove={() => setHi(i)}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-3 rounded-[10px] py-1.5 pl-3 pr-1.5',
                  i === hi && 'bg-selected',
                )}
              >
                <span>
                  <span className="font-medium">{formatTime(b.heldAt)}</span> · {b.cashier} ·{' '}
                  {b.counter}
                  {b.customerName ? ` · ${b.customerName}` : ''}
                  {b.kind === 'QUOTATION' ? ' · quotation' : ''}
                </span>
                <span className="flex items-center gap-2">
                  <span className="num">
                    {b.itemCount} items · Rs {formatMoney(b.netTotal)}
                  </span>
                  <IconButton
                    label="Delete held bill"
                    tone="danger"
                    tabIndex={-1}
                    icon={<Trash2 size={17} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      void discard(b);
                    }}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
