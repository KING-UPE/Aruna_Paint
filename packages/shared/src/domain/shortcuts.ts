/**
 * Every screen works with zero mouse. The Super Admin sets the default keys, each user can remap
 * any action in their profile, and "Reset to default" brings the defaults back.
 */

export const SHORTCUT_SCREENS = ['global', 'billing', 'bill_history', 'purchases', 'list'] as const;
export type ShortcutScreen = (typeof SHORTCUT_SCREENS)[number];

export interface ShortcutAction {
  label: string;
  keys: string;
}

export const DEFAULT_SHORTCUTS: Record<ShortcutScreen, Record<string, ShortcutAction>> = {
  global: {
    palette: { label: 'Command palette', keys: 'Ctrl+K' },
    goBilling: { label: 'Go to Billing', keys: 'Alt+1' },
    goStock: { label: 'Go to Stock', keys: 'Alt+2' },
    goAdmin: { label: 'Go to Admin', keys: 'Alt+3' },
    help: { label: 'Shortcut help', keys: 'F1' },
    saveDraft: { label: 'Save as draft', keys: 'Ctrl+S' },
    post: { label: 'Post or confirm', keys: 'Ctrl+Enter' },
    filter: { label: 'Filter the current list', keys: 'Ctrl+F' },
    print: { label: 'Print or export', keys: 'Ctrl+P' },
    lock: { label: 'Lock screen', keys: 'Ctrl+L' },
  },
  billing: {
    itemCode: { label: 'Item code field', keys: 'F2' },
    customer: { label: 'Customer name', keys: 'F3' },
    toggleMode: { label: 'Invoice or quotation', keys: 'F4' },
    wholesale: { label: 'Wholesale checkbox', keys: 'F6' },
    noDiscount: { label: 'No discount on this bill', keys: 'Alt+N' },
    hold: { label: 'Hold bill', keys: 'F7' },
    recall: { label: 'Recall a held bill', keys: 'F8' },
    history: { label: 'Bill history', keys: 'F9' },
    pay: { label: 'Pay', keys: 'F10' },
    removeLine: { label: 'Remove the selected line', keys: 'Delete' },
    qtyUp: { label: 'Qty up on the selected line', keys: '+' },
    qtyDown: { label: 'Qty down on the selected line', keys: '-' },
  },
  bill_history: {
    reprint: { label: 'Reprint', keys: 'P' },
    return: { label: 'Return', keys: 'R' },
    convert: { label: 'Convert a quotation', keys: 'C' },
    void: { label: 'Void', keys: 'V' },
  },
  purchases: {
    newLine: { label: 'New line', keys: 'Ctrl+Shift+N' },
  },
  list: {
    select: { label: 'Select a row', keys: 'Space' },
  },
};

/** Browsers reserve these; the counter app also blocks them to prevent accidents. */
export const RESERVED_KEYS = [
  'F5',
  'F11',
  'F12',
  'Ctrl+W',
  'Ctrl+T',
  'Ctrl+N',
  'Ctrl+R',
  'Ctrl+Shift+I',
  'Alt+F4',
];

/** Keys that move around every screen and can't be remapped. */
export const STRUCTURAL_KEYS = [
  'Enter',
  'Shift+Enter',
  'Escape',
  'Tab',
  'Shift+Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
];

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;

const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  del: 'Delete',
  delete: 'Delete',
  return: 'Enter',
  enter: 'Enter',
  space: 'Space',
  ' ': 'Space',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  plus: '+',
  minus: '-',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  cmd: 'Meta',
  meta: 'Meta',
  option: 'Alt',
  alt: 'Alt',
  shift: 'Shift',
};

function canonicalKey(k: string): string {
  const alias = KEY_ALIASES[k.toLowerCase()];
  if (alias) return alias;
  if (/^f\d{1,2}$/i.test(k)) return k.toUpperCase();
  if (k.length === 1) return k.toUpperCase();
  return k.charAt(0).toUpperCase() + k.slice(1);
}

/** "shift+ctrl+k" → "Ctrl+Shift+K". */
export function normalizeCombo(combo: string): string {
  const raw = combo.trim();
  // "+" on its own (or as the last key, as in "Ctrl++") is the plus key.
  const parts =
    raw === '+'
      ? ['+']
      : raw.endsWith('++')
        ? [...raw.slice(0, -2).split('+'), '+']
        : raw.split('+');
  const mods = new Set<string>();
  let key = '';
  for (const p of parts.map((x) => x.trim()).filter((x) => x !== '')) {
    const c = canonicalKey(p);
    if ((MODIFIER_ORDER as readonly string[]).includes(c)) mods.add(c);
    else key = c;
  }
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].filter(Boolean).join('+');
}

/** Builds the combo string from a keyboard event. */
export function eventToCombo(e: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return '';
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  // Shift is part of printable characters like "+", so only count it with named keys.
  const printable = e.key.length === 1;
  if (e.shiftKey && (!printable || e.ctrlKey || e.altKey)) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  const key = e.key === ' ' ? 'Space' : canonicalKey(e.key);
  return [...mods, key].join('+');
}

export type KeyMap = Record<string, string>;

/** Defaults overlaid with the user's own keys for one screen. */
export function effectiveKeyMap(
  screen: ShortcutScreen,
  overrides: { screen: string; action: string; keys: string }[],
): KeyMap {
  const map: KeyMap = {};
  for (const [action, def] of Object.entries(DEFAULT_SHORTCUTS[screen]))
    map[action] = normalizeCombo(def.keys);
  for (const o of overrides) {
    if (o.screen === screen && o.action in map) map[o.action] = normalizeCombo(o.keys);
  }
  return map;
}

/**
 * A key already used on that screen (global keys count on every screen), or one the browser
 * reserves, can't be assigned.
 */
export function validateKeyAssignment(
  screen: ShortcutScreen,
  action: string,
  keys: string,
  overrides: { screen: string; action: string; keys: string }[],
): string | null {
  const combo = normalizeCombo(keys);
  if (!combo) return 'Press a key.';
  if (!(action in DEFAULT_SHORTCUTS[screen])) return 'Unknown action.';
  if (RESERVED_KEYS.includes(combo)) return `${combo} is reserved by the browser.`;
  if (STRUCTURAL_KEYS.includes(combo))
    return `${combo} moves around every screen and can't be used.`;
  const screensToCheck: ShortcutScreen[] =
    screen === 'global' ? [...SHORTCUT_SCREENS] : ['global', screen];
  for (const s of screensToCheck) {
    const map = effectiveKeyMap(s, overrides);
    for (const [a, k] of Object.entries(map)) {
      if (s === screen && a === action) continue;
      if (k === combo)
        return `${combo} is already used for "${DEFAULT_SHORTCUTS[s][a]?.label ?? a}".`;
    }
  }
  return null;
}
