import {
  appearanceSettingsSchema,
  appearanceTokens,
  type AppearanceSettings,
  type ThemeTokens,
} from '@aruna/shared';

const STORAGE_KEY = 'aruna.appearance';
const STYLE_ID = 'aruna-theme';

function css(tokens: ThemeTokens): string {
  return Object.entries(tokens)
    .map(([k, v]) => `--${k}:${v};`)
    .join('');
}

/** Light or dark right now: the shop's choice, or this PC's setting when it is "system". */
export function effectiveMode(mode: AppearanceSettings['mode']): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Puts the shop's colour theme on every screen. The light and dark colours both go in, so a
 * "system" choice follows the PC's own setting without a reload. The last theme is remembered
 * on this PC so the next start doesn't flash the old colours.
 */
export function applyAppearance(a: AppearanceSettings, remember = true) {
  const root = document.documentElement;
  if (a.mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = a.mode;
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  const light = css(appearanceTokens(a.theme, a.customAccent, 'light'));
  const dark = css(appearanceTokens(a.theme, a.customAccent, 'dark'));
  style.textContent =
    `:root{${light}}` +
    `@media (prefers-color-scheme: dark){:root:not([data-theme='light']){${dark}}}` +
    `:root[data-theme='dark']{${dark}}`;
  if (!remember) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
  } catch {
    // Private window or blocked storage: the theme still applies, it just isn't remembered.
  }
}

/** At start-up, before the server answers: the theme this PC last showed. */
export function restoreAppearance() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = appearanceSettingsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) applyAppearance(parsed.data, false);
  } catch {
    // Nothing remembered; the default theme from index.css shows until the server answers.
  }
}
