import { Check, ChevronDown } from 'lucide-react';
import {
  Children,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

interface Option {
  value: string;
  label: ReactNode;
  text: string;
  disabled: boolean;
}

/** The part of a change event callers read: `e.target.value`, as with a native select. */
export interface SelectChangeEvent {
  target: { value: string };
}

export interface SelectProps {
  value?: string | number | null;
  defaultValue?: string;
  onChange?: (e: SelectChangeEvent) => void;
  /** `<option value="…">Label</option>` children, exactly like a native select. */
  children?: ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
  autoFocus?: boolean;
  placeholder?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  name?: string;
  onBlur?: () => void;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

function readOptions(children: ReactNode): Option[] {
  const out: Option[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<{
      value?: string | number;
      children?: ReactNode;
      disabled?: boolean;
    }>;
    if (el.type === 'option') {
      const value = el.props.value ?? textOf(el.props.children);
      out.push({
        value: String(value),
        label: el.props.children,
        text: textOf(el.props.children),
        disabled: Boolean(el.props.disabled),
      });
    } else if (el.props.children) {
      out.push(...readOptions(el.props.children));
    }
  });
  return out;
}

/**
 * A rounded dropdown that replaces the browser's select. Same props as a native select
 * (`value`, `onChange(e)`, `<option>` children). Keyboard: Enter, Space or ↓ opens; ↑↓ move;
 * typing jumps to a matching item; Enter picks; Esc closes without changing anything.
 */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    value,
    defaultValue,
    onChange,
    children,
    disabled,
    className,
    id,
    autoFocus,
    placeholder,
    name,
    onBlur,
    ...aria
  },
  ref,
) {
  const options = useMemo(() => readOptions(children), [children]);
  const [inner, setInner] = useState(defaultValue ?? '');
  const current = value === undefined ? inner : value === null ? '' : String(value);
  const selected = options.find((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    width: number;
    up: boolean;
    maxH: number;
  }>();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const listId = useId();
  useImperativeHandle(ref, () => trigger.current!);

  const place = useCallback(() => {
    const t = trigger.current;
    if (!t) return;
    // Inside a dialog the list renders in the dialog, so focus and clicks stay inside it.
    const container = (t.closest('[role="dialog"]') as HTMLElement | null) ?? document.body;
    const base =
      container === document.body ? { left: 0, top: 0 } : container.getBoundingClientRect();
    const r = t.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 220 && above > below;
    setHost(container);
    setPos({
      left: r.left - base.left,
      top: (up ? r.top - 4 : r.bottom + 4) - base.top,
      width: r.width,
      up,
      maxH: Math.max(160, Math.min(320, up ? above : below)),
    });
  }, []);

  const openList = () => {
    if (disabled || !options.length) return;
    place();
    const idx = options.findIndex((o) => o.value === current);
    setHi(
      idx >= 0
        ? idx
        : Math.max(
            0,
            options.findIndex((o) => !o.disabled),
          ),
    );
    setOpen(true);
  };

  const close = (focus = true) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };

  const choose = (o: Option | undefined) => {
    if (!o || o.disabled) return;
    if (value === undefined) setInner(o.value);
    if (o.value !== current) onChange?.({ target: { value: o.value } });
    close();
  };

  const move = (from: number, step: number) => {
    let i = from;
    for (let n = 0; n < options.length; n++) {
      i = Math.min(options.length - 1, Math.max(0, i + step));
      if (!options[i]?.disabled) return i;
    }
    return from;
  };

  // Typing letters jumps to the first item that starts with them.
  const typeAhead = (key: string, from: number) => {
    const now = Date.now();
    typed.current = {
      text:
        now - typed.current.at < 700 ? typed.current.text + key.toLowerCase() : key.toLowerCase(),
      at: now,
    };
    const q = typed.current.text;
    const order = [...options.slice(from + 1), ...options.slice(0, from + 1)];
    return order.find((o) => !o.disabled && o.text.toLowerCase().startsWith(q));
  };

  const onTriggerKey = (e: KeyboardEvent) => {
    if (disabled) return;
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      openList();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Like a native select: letters change the value without opening.
      const hit = typeAhead(
        e.key,
        options.findIndex((o) => o.value === current),
      );
      if (hit && hit.value !== current) {
        if (value === undefined) setInner(hit.value);
        onChange?.({ target: { value: hit.value } });
      }
    }
  };

  const onListKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') (e.preventDefault(), setHi((h) => move(h, 1)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => move(h, -1)));
    else if (e.key === 'Home') (e.preventDefault(), setHi(move(-1, 1)));
    else if (e.key === 'End') (e.preventDefault(), setHi(move(options.length, -1)));
    else if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), choose(options[hi]));
    else if (e.key === 'Escape') (e.preventDefault(), close());
    else if (e.key === 'Tab') close(false);
    else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
      const hit = typeAhead(e.key, hi);
      if (hit) setHi(options.indexOf(hit));
    }
  };

  useLayoutEffect(() => {
    if (open) list.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector(`[data-index="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, hi]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !trigger.current?.contains(t)) close(false);
    };
    const onScroll = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  useEffect(() => {
    if (autoFocus) trigger.current?.focus();
  }, [autoFocus]);

  return (
    <>
      <button
        ref={trigger}
        id={id}
        name={name}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={aria['aria-label']}
        aria-invalid={aria['aria-invalid']}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onTriggerKey}
        onBlur={onBlur}
        className={cn(
          'flex h-10 w-full items-center justify-between gap-2 rounded-[var(--radius-input)] border border-border bg-surface px-3 text-left text-[15px] text-text transition-colors',
          'hover:border-muted/60 focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0',
          'disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger',
          open && 'border-accent',
          className,
        )}
      >
        <span className={cn('min-w-0 truncate', !selected && 'text-muted/70')}>
          {selected ? selected.label : (placeholder ?? 'Choose…')}
        </span>
        <ChevronDown
          size={16}
          className={cn('shrink-0 text-muted transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open && pos && host
        ? createPortal(
            <ul
              ref={list}
              id={listId}
              role="listbox"
              tabIndex={-1}
              data-select-open=""
              aria-label={aria['aria-label']}
              aria-activedescendant={`${listId}-${hi}`}
              onKeyDown={onListKey}
              style={{
                position: host === document.body ? 'fixed' : 'absolute',
                left: pos.left,
                top: pos.top,
                minWidth: pos.width,
                maxHeight: pos.maxH,
                transform: pos.up ? 'translateY(-100%)' : undefined,
              }}
              className="z-[60] overflow-y-auto rounded-[12px] border border-border bg-surface p-1 shadow-xl outline-none"
            >
              {options.map((o, i) => (
                <li
                  key={`${o.value}-${i}`}
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={o.value === current}
                  aria-disabled={o.disabled || undefined}
                  onPointerMove={() => !o.disabled && setHi(i)}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => choose(o)}
                  className={cn(
                    'flex cursor-pointer items-center justify-between gap-3 rounded-[8px] px-3 py-2 text-[15px]',
                    i === hi && 'bg-selected',
                    o.value === current && 'font-medium text-accent-strong',
                    o.disabled && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <span className="whitespace-nowrap">{o.label}</span>
                  {o.value === current ? (
                    <Check size={15} aria-hidden />
                  ) : (
                    <span className="w-[15px]" />
                  )}
                </li>
              ))}
            </ul>,
            host,
          )
        : null}
    </>
  );
});
