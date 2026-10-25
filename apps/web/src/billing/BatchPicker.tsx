import { formatDate, formatMoney, formatQty } from '@aruna/shared';
import { useLayoutEffect, useRef, useState } from 'react';
import type { BillingItem } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Multi-price pop-up: every batch with its sub code, price, qty here and expiry. The oldest stock
 * is highlighted, so Enter sells first-in, first-out. It opens under the entry row and takes the
 * keyboard at once, so a fast cashier never loses a key.
 */
export function BatchPicker({
  item,
  wholesale,
  onPick,
  onClose,
}: {
  item: BillingItem;
  wholesale: boolean;
  onPick: (batchId: string) => void;
  onClose: () => void;
}) {
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => ref.current?.focus(), []);
  const batches = item.batches;
  return (
    <div
      ref={ref}
      role="listbox"
      aria-label="Batches"
      tabIndex={0}
      className="absolute left-0 right-0 top-[52px] z-30 rounded-[var(--radius-card)] border-2 border-accent bg-surface p-3 shadow-xl outline-none"
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHi((h) => Math.min(batches.length - 1, h + 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHi((h) => Math.max(0, h - 1));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          onPick(batches[hi]!.id);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <p className="mb-2 text-sm">
        <span className="font-semibold">
          {item.code} · {item.name}
        </span>{' '}
        <span className="text-muted">
          has batches at different prices. Enter takes the oldest; Esc goes back.
        </span>
      </p>
      <table className="w-full text-sm">
        <thead className="text-left text-muted">
          <tr>
            <th className="py-1.5 font-medium">Sub code</th>
            <th className="num py-1.5 font-medium">{wholesale ? 'W-price' : 'Price'}</th>
            <th className="num py-1.5 font-medium">Qty here</th>
            <th className="py-1.5 pl-4 font-medium">Expiry</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b, i) => (
            <tr
              key={b.id}
              role="option"
              aria-selected={i === hi}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(b.id);
              }}
              className={cn(
                'cursor-pointer border-t border-border',
                i === hi && 'bg-selected font-semibold',
              )}
            >
              <td className="py-2">{b.code}</td>
              <td className="num py-2">{formatMoney(wholesale ? b.wPrice : b.salesPrice)}</td>
              <td className="num py-2">{formatQty(b.available)}</td>
              <td className="py-2 pl-4">{b.expiryDate ? formatDate(b.expiryDate) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
