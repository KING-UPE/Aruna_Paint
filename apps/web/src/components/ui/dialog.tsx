import * as D from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { arrowNav } from '@/lib/arrowNav';
import { cn } from '@/lib/utils';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Where focus goes first; Esc always closes. */
  initialFocus?: () => HTMLElement | null | undefined;
  /** Put focus back where it was when the dialog closes (off when the caller moves it on). */
  restoreFocus?: boolean;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  initialFocus,
  restoreFocus = true,
}: DialogProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <D.Content
          onOpenAutoFocus={(e) => {
            const el = initialFocus?.();
            if (el) {
              e.preventDefault();
              el.focus();
            }
          }}
          onKeyDown={arrowNav}
          onEscapeKeyDown={(e) => {
            // Esc inside an open dropdown closes only the dropdown.
            if (document.querySelector('[data-select-open]')) e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            if (!restoreFocus) e.preventDefault();
          }}
          className={cn(
            'fixed left-1/2 top-[12vh] z-50 flex max-h-[80vh] w-[calc(100vw-32px)] max-w-lg -translate-x-1/2 flex-col rounded-[var(--radius-card)] border border-border bg-surface shadow-xl',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-3">
            <div>
              <D.Title className="text-base font-semibold">{title}</D.Title>
              {description ? (
                <D.Description className="mt-0.5 text-sm text-muted">{description}</D.Description>
              ) : (
                <D.Description />
              )}
            </div>
            {/* Out of the tab order so dialogs open on their own content; Esc closes. */}
            <D.Close
              tabIndex={-1}
              className="rounded p-1 text-muted hover:bg-surface-2"
              aria-label="Close (Esc)"
            >
              <X size={18} />
            </D.Close>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer ? (
            <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
          ) : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
