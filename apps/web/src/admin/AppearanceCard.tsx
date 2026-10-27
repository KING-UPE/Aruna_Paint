import {
  HEX_COLOR,
  THEME_PRESETS,
  appearanceTokens,
  type AppearanceSettings,
  type ThemeId,
  type ThemeMode,
} from '@aruna/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Monitor, Moon, Palette, Sun } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { applyAppearance, effectiveMode } from '@/lib/theme';
import { cn } from '@/lib/utils';

const MODES: { id: ThemeMode; label: string; icon: ReactNode }[] = [
  { id: 'system', label: 'Same as the PC', icon: <Monitor size={15} /> },
  { id: 'light', label: 'Light', icon: <Sun size={15} /> },
  { id: 'dark', label: 'Dark', icon: <Moon size={15} /> },
];

const same = (a: AppearanceSettings, b: AppearanceSettings) =>
  a.theme === b.theme && a.customAccent === b.customAccent && a.mode === b.mode;

/** Arrow keys move between the choices of a radio group, as people expect. */
function arrowKeys(e: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  e.preventDefault();
  const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
  const next = items[(at + step + items.length) % items.length]!;
  next.focus();
  next.click();
}

/**
 * The Super Admin picks the shop's colour theme: five ready-made ones or their own colour, and
 * light, dark or the PC's setting. The screen previews the choice straight away; Save puts it
 * on every PC in the shop.
 */
export function AppearanceCard({ saved }: { saved: AppearanceSettings }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<AppearanceSettings>(saved);
  const [hex, setHex] = useState(saved.customAccent);
  const [busy, setBusy] = useState(false);
  const savedRef = useRef(saved);
  savedRef.current = saved;

  useEffect(() => {
    setDraft(saved);
    setHex(saved.customAccent);
  }, [saved]);

  // Preview on this screen only; leaving the page without saving puts the shop's theme back.
  useEffect(() => {
    applyAppearance(draft, false);
  }, [draft]);
  useEffect(() => () => applyAppearance(savedRef.current), []);

  const changed = !same(draft, saved);
  const mode = effectiveMode(draft.mode);

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/api/settings/appearance', draft);
      applyAppearance(draft);
      toast.success('Colour theme saved for every screen in the shop.');
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const pick = (theme: ThemeId) => setDraft((d) => ({ ...d, theme }));
  const setCustom = (value: string) => {
    setHex(value);
    const v = value.startsWith('#') ? value : `#${value}`;
    if (HEX_COLOR.test(v))
      setDraft((d) => ({ ...d, theme: 'custom', customAccent: v.toLowerCase() }));
  };
  const hexValid = HEX_COLOR.test(hex.startsWith('#') ? hex : `#${hex}`);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Colour theme</CardTitle>
          <p className="mt-0.5 text-sm text-muted">
            For every screen and counter in the shop. Green, amber and red always mean done, warning
            and error.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {changed ? (
            <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
              Undo
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            disabled={!changed || busy}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </CardHeader>
      <CardBody className="flex flex-col gap-5">
        <div
          role="radiogroup"
          aria-label="Colour theme"
          onKeyDown={arrowKeys}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6"
        >
          {THEME_PRESETS.map((p) => (
            <ThemeTile
              key={p.id}
              label={p.label}
              selected={draft.theme === p.id}
              onSelect={() => pick(p.id)}
              tokens={appearanceTokens(p.id, draft.customAccent, mode)}
            />
          ))}
          <ThemeTile
            label="Custom colour"
            selected={draft.theme === 'custom'}
            onSelect={() => pick('custom')}
            tokens={appearanceTokens('custom', draft.customAccent, mode)}
            icon={<Palette size={14} />}
          />
        </div>

        {draft.theme === 'custom' ? (
          <div className="flex flex-wrap items-end gap-3 rounded-[12px] border border-border bg-surface-2/60 p-3">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Colour
              <span className="relative block h-10 w-14 overflow-hidden rounded-[var(--radius-input)] border border-border">
                <input
                  type="color"
                  aria-label="Pick the custom colour"
                  value={draft.customAccent}
                  onChange={(e) => setCustom(e.target.value)}
                  className="absolute -inset-2 h-[calc(100%+16px)] w-[calc(100%+16px)] cursor-pointer border-0 p-0"
                />
              </span>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Colour code
              <Input
                value={hex}
                onChange={(e) => setCustom(e.target.value.trim())}
                aria-invalid={!hexValid}
                maxLength={7}
                className="w-32 font-mono uppercase"
              />
            </label>
            <p className="pb-2.5 text-sm text-muted">
              {hexValid
                ? 'Any colour works: it is made lighter or darker where needed so text stays easy to read.'
                : 'Type a colour code like #1D4ED8.'}
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Light or dark</span>
          <div
            role="radiogroup"
            aria-label="Light or dark"
            onKeyDown={arrowKeys}
            className="inline-flex w-fit gap-1 rounded-[12px] border border-border bg-surface-2 p-1"
          >
            {MODES.map((m) => {
              const on = draft.mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setDraft((d) => ({ ...d, mode: m.id }))}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-[8px] px-3 text-sm transition-colors',
                    on
                      ? 'bg-surface font-medium text-text shadow-sm'
                      : 'text-muted hover:text-text',
                  )}
                >
                  {m.icon}
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

/** A small picture of the theme: a page, a card, an accent button and a soft chip. */
function ThemeTile({
  label,
  selected,
  onSelect,
  tokens: t,
  icon,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  tokens: ReturnType<typeof appearanceTokens>;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={cn(
        'group flex flex-col gap-2 rounded-[14px] border-2 p-2 text-left transition-colors',
        selected ? 'border-accent' : 'border-transparent hover:border-border',
      )}
    >
      <span
        aria-hidden
        className="relative flex h-20 w-full flex-col gap-1.5 overflow-hidden rounded-[10px] border p-2"
        style={{ background: t.bg, borderColor: t.border }}
      >
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: t.accent }} />
          <span className="h-1.5 w-10 rounded-full" style={{ background: t.border }} />
        </span>
        <span
          className="flex flex-1 items-center justify-between gap-1.5 rounded-[6px] border px-1.5"
          style={{ background: t.surface, borderColor: t.border }}
        >
          <span
            className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
            style={{ background: t['accent-soft'], color: t['accent-strong'] }}
          >
            Aa
          </span>
          <span
            className="rounded-[5px] px-2 py-0.5 text-[10px] font-semibold"
            style={{ background: t.accent, color: t['accent-text'] }}
          >
            Pay
          </span>
        </span>
        {selected ? (
          <span
            className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full"
            style={{ background: t.accent, color: t['accent-text'] }}
          >
            <Check size={12} strokeWidth={3} />
          </span>
        ) : null}
      </span>
      <span className="flex items-center gap-1.5 px-0.5 text-sm font-medium">
        {icon}
        {label}
      </span>
    </button>
  );
}
