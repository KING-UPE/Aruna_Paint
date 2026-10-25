import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_SCREENS,
  effectiveKeyMap,
  eventToCombo,
  RESERVED_KEYS,
  type KeyMap,
  type ShortcutScreen,
} from '@aruna/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type Handler = (e: KeyboardEvent) => void;

interface Registration {
  id: number;
  screen: ShortcutScreen;
  handlers: Partial<Record<string, Handler>>;
  /** Fire while a dialog is open (handlers that belong to the dialog itself). */
  inDialog: boolean;
  /** Single-character keys normally don't fire while typing in a field. */
  whileTyping: string[];
}

interface KeymapValue {
  maps: Record<ShortcutScreen, KeyMap>;
  register: (r: Omit<Registration, 'id'>) => () => void;
  /** The screen the user is on, for F1 help. */
  activeScreen: ShortcutScreen;
  keyFor: (screen: ShortcutScreen, action: string) => string;
}

const KeymapContext = createContext<KeymapValue | null>(null);

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function dialogOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"][data-state="open"]'));
}

/**
 * One keyboard listener for the whole app. Screens register their actions; the user's own key
 * map decides which key fires which action. The newest registration wins, so a dialog's keys
 * beat the screen behind it.
 */
export function KeymapProvider({
  overrides,
  children,
}: {
  overrides: { screen: string; action: string; keys: string }[];
  children: ReactNode;
}) {
  const maps = useMemo(() => {
    const out = {} as Record<ShortcutScreen, KeyMap>;
    for (const s of SHORTCUT_SCREENS) out[s] = effectiveKeyMap(s, overrides);
    return out;
  }, [overrides]);
  const regs = useRef<Registration[]>([]);
  const nextId = useRef(1);
  const [activeScreen, setActiveScreen] = useState<ShortcutScreen>('global');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const combo = eventToCombo(e);
      if (!combo) return;
      const typing = isTyping(e.target);
      const inDialog = dialogOpen();
      for (const reg of [...regs.current].reverse()) {
        if (inDialog && !reg.inDialog) continue;
        const map = maps[reg.screen];
        const action = Object.keys(map).find((a) => map[a] === combo);
        if (!action) continue;
        const handler = reg.handlers[action];
        if (!handler) continue;
        if (typing && combo.length === 1 && !reg.whileTyping.includes(action)) continue;
        e.preventDefault();
        e.stopPropagation();
        handler(e);
        return;
      }
      // The counter app blocks keys the browser reserves, to prevent accidents.
      if (
        combo === 'F5' ||
        combo === 'Ctrl+R' ||
        (RESERVED_KEYS.includes(combo) && combo.startsWith('F'))
      )
        e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [maps]);

  const register = useCallback((r: Omit<Registration, 'id'>) => {
    const reg = { ...r, id: nextId.current++ };
    regs.current.push(reg);
    if (r.screen !== 'global' && r.screen !== 'list') setActiveScreen(r.screen);
    return () => {
      regs.current = regs.current.filter((x) => x.id !== reg.id);
      const last = [...regs.current]
        .reverse()
        .find((x) => x.screen !== 'global' && x.screen !== 'list');
      setActiveScreen(last?.screen ?? 'global');
    };
  }, []);

  const value = useMemo<KeymapValue>(
    () => ({
      maps,
      activeScreen,
      register,
      keyFor: (screen, action) => maps[screen]?.[action] ?? '',
    }),
    [maps, activeScreen, register],
  );
  return <KeymapContext.Provider value={value}>{children}</KeymapContext.Provider>;
}

export function useKeymap(): KeymapValue {
  const v = useContext(KeymapContext);
  if (!v) throw new Error('useKeymap outside KeymapProvider');
  return v;
}

/** Registers actions for a screen while the component is mounted (and `enabled`). */
export function useHotkeys(
  screen: ShortcutScreen,
  handlers: Partial<Record<string, Handler>>,
  opts: { enabled?: boolean; inDialog?: boolean; whileTyping?: string[] } = {},
) {
  const { register } = useKeymap();
  const ref = useRef(handlers);
  ref.current = handlers;
  const enabled = opts.enabled ?? true;
  const inDialog = opts.inDialog ?? false;
  const whileTyping = (opts.whileTyping ?? []).join(',');
  const actions = Object.keys(handlers).join(',');
  useEffect(() => {
    if (!enabled) return;
    const proxied: Partial<Record<string, Handler>> = {};
    for (const a of actions.split(',').filter(Boolean)) proxied[a] = (e) => ref.current[a]?.(e);
    return register({
      screen,
      handlers: proxied,
      inDialog,
      whileTyping: whileTyping.split(',').filter(Boolean),
    });
  }, [register, screen, enabled, inDialog, whileTyping, actions]);
}

/** The label of the user's key for an action, for button hints like "Pay F10". */
export function useKeyLabel(screen: ShortcutScreen, action: string): string {
  return useKeymap().keyFor(screen, action);
}

export function actionLabel(screen: ShortcutScreen, action: string): string {
  return DEFAULT_SHORTCUTS[screen][action]?.label ?? action;
}
