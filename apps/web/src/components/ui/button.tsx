import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Kbd } from './kbd';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-input)] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-text hover:bg-accent-strong',
        secondary: 'border border-border bg-surface text-text hover:bg-surface-2',
        ghost: 'text-text hover:bg-surface-2',
        danger: 'bg-danger text-white hover:opacity-90',
        outlineAccent:
          'border-2 border-accent bg-accent-soft text-accent-strong hover:bg-accent hover:text-accent-text',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-10 px-4 text-[15px]',
        lg: 'h-12 px-5 text-base',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** The user's own key for this button, shown as a hint ("Pay F10"). */
  keyHint?: string;
  /** A small icon before the words (16 px lucide icon). */
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, keyHint, icon, children, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props}>
      {icon ? (
        <span aria-hidden className="-ml-0.5 inline-flex shrink-0">
          {icon}
        </span>
      ) : null}
      {children}
      {keyHint ? (
        <Kbd className={variant === 'primary' ? 'border-white/40 bg-white/15 text-inherit' : ''}>
          {keyHint}
        </Kbd>
      ) : null}
    </button>
  ),
);
Button.displayName = 'Button';
