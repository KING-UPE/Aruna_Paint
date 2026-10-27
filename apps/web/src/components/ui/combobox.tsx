import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Plus } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useDebounced } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { IconButton } from './icon-button';
import { Input } from './input';

export interface ComboboxProps<T> {
  value: T | null;
  onChange: (item: T | null) => void;
  /** What the box shows once an item is picked. */
  display: (item: T) => string;
  itemKey: (item: T) => string;
  /** One suggestion row; defaults to the display text. */
  render?: (item: T) => ReactNode;
  /** A fixed list, filtered by what is typed… */
  options?: T[];
  /** …or a search on the server for what is typed. */
  search?: { key: readonly unknown[]; fn: (term: string) => Promise<T[]> };
  /** Offers "+ Add <what> "<typed>"" and a + button beside the box; the caller opens its pop-up. */
  onAdd?: (typed: string) => void;
  /** The thing added, in words: "supplier", "brand". */
  addWhat?: string;
  /** An empty box on leaving means "none". */
  clearable?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  id?: string;
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  /** Extra attributes for the text box (data-row, aria-label…). */
  inputProps?: InputHTMLAttributes<HTMLInputElement> & Record<`data-${string}`, unknown>;
  /** Enter while nothing is being typed (e.g. move on to the next cell). */
  onEnterIdle?: () => void;
  /** After a pick, e.g. to move focus on. */
  onPicked?: (item: T) => void;
  /** "sm" for table cells. */
  size?: 'sm' | 'md';
  minListWidth?: number;
}

const words = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * A text box that suggests as you type. Only a picked item counts: whatever was typed but not
 * picked disappears when you leave the box, so the screen never shows a name it isn't using.
 * A name that isn't in the list offers "+ Add" right there.
 */
export function Combobox<T>({
  value,
  onChange,
  display,
  itemKey,
  render,
  options,
  search,
  onAdd,
  addWhat = 'new',
  clearable = false,
  placeholder,
  autoFocus,
  id,
  invalid,
  disabled,
  className,
  inputClassName,
  inputProps,
  onEnterIdle,
  onPicked,
  size = 'md',
  minListWidth = 260,
}: ComboboxProps<T>) {
  // null = not typing: the box shows the picked item.
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [enterPending, setEnterPending] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean }>();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  const typed = text?.trim() ?? '';
  const term = useDebounced(typed, 150);
  const q = useQuery({
    queryKey: [...(search?.key ?? ['combobox']), term],
    queryFn: () => search!.fn(term),
    enabled: Boolean(search) && text !== null && term.length >= 1,
  });
  // Suggestions must match exactly what is typed now: stale ones plus a fast Enter would pick
  // the previous item.
  const ready = !search || (term === typed && (typed.length === 0 || !q.isPending));

  let matches: T[] = [];
  if (search) matches = text !== null && typed && ready ? (q.data ?? []) : [];
  else if (options) {
    const w = words(typed);
    matches =
      text === null || !w.length
        ? options
        : options.filter((o) => {
            const hay = display(o).toLowerCase();
            return w.every((x) => hay.includes(x));
          });
  }
  const exact = matches.some((m) => display(m).trim().toLowerCase() === typed.toLowerCase());
  const showAdd = Boolean(onAdd) && typed.length > 0 && ready && !exact;
  const rows = matches.length + (showAdd ? 1 : 0);
  const shown = open && !disabled && (rows > 0 || (Boolean(search) && typed.length > 0));
  const cur = Math.min(hi, Math.max(0, rows - 1));

  const place = useCallback(() => {
    const t = input.current;
    if (!t) return;
    // Inside a dialog the list renders in the dialog, so focus and clicks stay inside it.
    const container = (t.closest('[role="dialog"]') as HTMLElement | null) ?? document.body;
    const base =
      container === document.body ? { left: 0, top: 0 } : container.getBoundingClientRect();
    const r = t.getBoundingClientRect();
    const up = window.innerHeight - r.bottom < 240 && r.top > 240;
    setHost(container);
    setPos({
      left: r.left - base.left,
      top: (up ? r.top - 4 : r.bottom + 4) - base.top,
      width: Math.max(r.width, minListWidth),
      up,
    });
  }, [minListWidth]);

  useLayoutEffect(() => {
    if (shown) place();
  }, [shown, place, rows]);

  useEffect(() => {
    if (!shown) return;
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [shown, place]);

  useEffect(() => {
    if (!shown) return;
    list.current?.querySelector(`[data-index="${cur}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [shown, cur]);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  // After a pick the box keeps focus with the name selected, so typing again starts afresh.
  const selectAfter = useRef(false);
  useLayoutEffect(() => {
    if (!selectAfter.current) return;
    selectAfter.current = false;
    if (document.activeElement === input.current) input.current?.select();
  });

  const reset = () => {
    setText(null);
    setOpen(false);
    setEnterPending(false);
  };

  const pick = (i: number) => {
    if (i < matches.length) {
      const item = matches[i]!;
      reset();
      selectAfter.current = true;
      onChange(item);
      onPicked?.(item);
    } else if (showAdd) {
      const name = typed;
      reset();
      onAdd?.(name);
    }
  };

  // Enter typed before the search answered: pick once the answer for this text is in.
  useEffect(() => {
    if (!enterPending || !ready) return;
    setEnterPending(false);
    if (rows > 0) pick(0);
  }, [enterPending, ready, rows]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    inputProps?.onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setHi(0);
      } else setHi(Math.min(rows - 1, cur + 1));
    } else if (e.key === 'ArrowUp') {
      if (!open) return;
      e.preventDefault();
      setHi(Math.max(0, cur - 1));
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
      if (text === null) {
        if (onEnterIdle) {
          e.preventDefault();
          onEnterIdle();
        } else if (options && !open) {
          e.preventDefault();
          setOpen(true);
          setHi(0);
        }
        return;
      }
      e.preventDefault();
      if (!typed) {
        // Emptied box: "none" where that is allowed, otherwise back to the picked item.
        if (clearable && value !== null) onChange(null);
        reset();
        return;
      }
      if (!ready) return setEnterPending(true);
      if (shown && rows > 0) pick(cur);
    } else if (e.key === 'Escape') {
      if (text === null && !open) return;
      e.preventDefault();
      e.stopPropagation();
      reset();
    }
  };

  const onBlur = () => {
    if (text !== null && !typed && clearable && value !== null) onChange(null);
    // Typed but not picked: it goes, so the box never shows a name it isn't using.
    reset();
  };

  return (
    <div className={cn('relative flex min-w-0 items-center gap-1', className)}>
      <div className="relative min-w-0 flex-1">
        <Input
          {...inputProps}
          ref={input}
          id={id}
          role="combobox"
          aria-expanded={shown}
          aria-controls={shown ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={shown ? `${listId}-${cur}` : undefined}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          disabled={disabled}
          placeholder={placeholder}
          value={text ?? (value ? display(value) : '')}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setHi(0);
          }}
          onFocus={(e) => {
            inputProps?.onFocus?.(e);
            e.currentTarget.select();
          }}
          onClick={() => {
            if (options && !open) {
              setOpen(true);
              setHi(0);
            }
          }}
          onBlur={(e) => {
            inputProps?.onBlur?.(e);
            onBlur();
          }}
          onKeyDown={onKeyDown}
          className={cn(size === 'sm' && 'h-8 px-2', options && 'pr-8', inputClassName)}
        />
        {options ? (
          <ChevronDown
            size={16}
            aria-hidden
            className={cn(
              'pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted transition-transform',
              shown && 'rotate-180',
            )}
          />
        ) : null}
      </div>
      {onAdd ? (
        <IconButton
          label={`Add ${addWhat}`}
          icon={<Plus size={16} />}
          tabIndex={-1}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const name = typed;
            reset();
            onAdd(name);
          }}
          className={cn(
            'shrink-0 rounded-[var(--radius-input)] border border-border bg-surface-2',
            size === 'sm' ? 'h-8 w-8' : 'h-10 w-10',
          )}
        />
      ) : null}
      {shown && pos && host
        ? createPortal(
            <ul
              ref={list}
              id={listId}
              role="listbox"
              data-select-open=""
              style={{
                position: host === document.body ? 'fixed' : 'absolute',
                left: pos.left,
                top: pos.top,
                minWidth: pos.width,
                transform: pos.up ? 'translateY(-100%)' : undefined,
              }}
              className="z-[60] max-h-80 overflow-y-auto rounded-[12px] border border-border bg-surface p-1 shadow-xl"
            >
              {matches.map((m, i) => (
                <li
                  key={itemKey(m)}
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === cur}
                  onMouseMove={() => setHi(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(i)}
                  className={cn(
                    'flex cursor-pointer items-center justify-between gap-3 rounded-[8px] px-3 py-2 text-[15px]',
                    i === cur && 'bg-selected',
                    value && itemKey(value) === itemKey(m) && 'font-medium text-accent-strong',
                  )}
                >
                  {render ? render(m) : <span className="truncate">{display(m)}</span>}
                </li>
              ))}
              {showAdd ? (
                <li
                  id={`${listId}-${matches.length}`}
                  data-index={matches.length}
                  role="option"
                  aria-selected={cur === matches.length}
                  onMouseMove={() => setHi(matches.length)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(matches.length)}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-[8px] px-3 py-2 text-[15px] font-semibold text-accent-strong',
                    cur === matches.length && 'bg-selected',
                  )}
                >
                  <Plus size={16} aria-hidden />
                  <span className="truncate">
                    Add {addWhat} “{typed}”
                  </span>
                </li>
              ) : null}
              {!rows ? (
                <li className="px-3 py-2 text-sm text-muted">
                  {ready ? 'Nothing found.' : 'Searching…'}
                </li>
              ) : null}
            </ul>,
            host,
          )
        : null}
    </div>
  );
}
