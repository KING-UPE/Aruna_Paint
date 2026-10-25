import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-muted',
        className,
      )}
      {...props}
    />
  );
}
