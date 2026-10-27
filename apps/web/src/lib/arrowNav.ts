import type { KeyboardEvent } from 'react';

const BUTTONS = 'button:not([disabled]):not([tabindex="-1"]), a[href]:not([tabindex="-1"])';
/** Places that already use the arrow keys for themselves. */
const OWN_ARROWS =
  '[role="radiogroup"], [role="listbox"], [role="grid"], [role="tablist"], [role="menu"], [role="img"], [data-select-open], table';

/**
 * Arrow keys move between buttons, like Tab and Shift+Tab: → and ↓ go to the next one, ← and ↑
 * to the previous. Only when a button or link has focus, so typing in a box is never affected,
 * and never inside lists, dropdowns and radio groups that move with the arrows already.
 */
export function arrowNav(e: KeyboardEvent<HTMLElement>) {
  const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
  const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
  if ((!forward && !back) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const target = e.target as HTMLElement;
  if (!target.matches('button, a[href]') || target.closest(OWN_ARROWS)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(BUTTONS)].filter(
    (el) => !el.closest(OWN_ARROWS) && el.offsetParent !== null,
  );
  const at = items.indexOf(target);
  if (at < 0) return;
  const next = items[forward ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1)];
  e.preventDefault();
  e.stopPropagation();
  next?.focus();
}
