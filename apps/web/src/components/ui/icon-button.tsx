import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** What the button does, in words: read aloud and shown as a tooltip on hover or focus. */
  label: string;
  icon: ReactNode;
  tone?: 'default' | 'danger';
}

/**
 * A round icon-only button for row actions (edit, reset, delete). The words still exist: the
 * tooltip shows them on hover and keyboard focus, and screen readers read them.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, tone = 'default', className, type = 'button', ...props },
  ref,
) {
  return (
    <span className="group/icon relative inline-flex">
      <button
        ref={ref}
        type={type}
        aria-label={label}
        className={cn(
          'grid h-8 w-8 place-items-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-40',
          tone === 'danger'
            ? 'text-danger hover:bg-danger-soft'
            : 'text-muted hover:bg-surface-2 hover:text-text',
          className,
        )}
        {...props}
      >
        {icon}
      </button>
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-[6px] bg-text px-2 py-1 text-xs font-medium text-surface opacity-0 shadow-md transition-opacity delay-150 group-hover/icon:opacity-100 group-has-[:focus-visible]/icon:opacity-100"
      >
        {label}
      </span>
    </span>
  );
});
