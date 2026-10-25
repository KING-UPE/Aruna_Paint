import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Kbd } from './kbd';

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2 className={cn('animate-spin text-muted', className)} size={18} aria-label="Loading" />
  );
}

/** Empty states say what to do next and show its shortcut. */
export function EmptyState({
  title,
  action,
  keys,
}: {
  title: string;
  action?: string;
  keys?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <p className="font-medium">{title}</p>
      {action ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          {action} {keys ? <Kbd>{keys}</Kbd> : null}
        </p>
      ) : null}
    </div>
  );
}

export function PageHeader({
  title,
  children,
  description,
}: {
  title: string;
  children?: ReactNode;
  description?: string;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

export function Money({
  value,
  className,
}: {
  value: string | number | null | undefined;
  className?: string;
}) {
  const n = Number(value ?? 0);
  return (
    <span className={cn('num', n < 0 && 'text-danger', className)}>
      {n < 0 ? '−' : ''}
      {Math.abs(n).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
}
