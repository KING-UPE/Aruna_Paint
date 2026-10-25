import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { EmptyState, Spinner } from './ui/misc';

/**
 * Tables: sticky header, a clear focused row and keyboard moves. ↑↓ move, Enter opens the row,
 * Space selects it when `onToggle` is given.
 */
export function DataTable<T>({
  data,
  columns,
  loading,
  empty,
  onOpen,
  onToggle,
  isSelected,
  rowKey,
  autoFocus,
  className,
}: {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  loading?: boolean;
  empty?: React.ReactNode;
  onOpen?: (row: T) => void;
  onToggle?: (row: T) => void;
  isSelected?: (row: T) => boolean;
  rowKey: (row: T) => string;
  autoFocus?: boolean;
  className?: string;
}) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });
  const [hi, setHi] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => setHi((h) => Math.min(h, Math.max(0, data.length - 1))), [data.length]);
  useEffect(() => {
    body.current
      ?.querySelector<HTMLElement>(`[data-row="${hi}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [hi]);
  const rows = table.getRowModel().rows;
  return (
    <div
      ref={body}
      tabIndex={0}
      autoFocus={autoFocus}
      role="grid"
      className={cn(
        'overflow-auto rounded-[var(--radius-card)] border border-border bg-surface outline-none',
        className,
      )}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHi((h) => Math.min(rows.length - 1, h + 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHi((h) => Math.max(0, h - 1));
        } else if (e.key === 'Enter' && rows[hi] && onOpen) {
          e.preventDefault();
          onOpen(rows[hi].original);
        } else if (e.key === ' ' && rows[hi] && onToggle) {
          e.preventDefault();
          onToggle(rows[hi].original);
        }
      }}
    >
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-surface-2 text-left text-muted">
          {table.getHeaderGroups().map((g) => (
            <tr key={g.id}>
              {g.headers.map((h) => (
                <th
                  key={h.id}
                  className={cn(
                    'px-3 py-2 font-medium',
                    (h.column.columnDef.meta as { num?: boolean } | undefined)?.num && 'text-right',
                  )}
                >
                  {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={rowKey(r.original)}
              data-row={i}
              aria-selected={i === hi}
              onClick={() => setHi(i)}
              onDoubleClick={() => onOpen?.(r.original)}
              className={cn(
                'border-t border-border',
                i === hi && 'bg-selected',
                isSelected?.(r.original) && 'font-semibold',
                onOpen && 'cursor-pointer',
              )}
            >
              {r.getVisibleCells().map((c) => (
                <td
                  key={c.id}
                  className={cn(
                    'px-3 py-2',
                    (c.column.columnDef.meta as { num?: boolean } | undefined)?.num && 'num',
                  )}
                >
                  {flexRender(c.column.columnDef.cell, c.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {loading ? (
        <div className="p-6">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        (empty ?? <EmptyState title="Nothing here yet." />)
      ) : null}
    </div>
  );
}
