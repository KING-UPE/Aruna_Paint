/**
 * Colour themes the Super Admin picks for the whole shop: five ready-made ones and a custom
 * colour. A theme is one accent colour; every screen colour (backgrounds, borders, text, the
 * accent's darker and softer shades) is worked out from it for light and dark mode, checked so
 * text stays readable (WCAG AA, 4.5:1). Green, amber and red keep their meaning (done, warning,
 * error) in every theme.
 */

export const THEME_IDS = ['teal', 'blue', 'purple', 'berry', 'graphite', 'custom'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export interface ThemePreset {
  id: Exclude<ThemeId, 'custom'>;
  label: string;
  accent: string;
}

/** Teal is the original look; its colours stay exactly as designed (see index.css). */
export const THEME_PRESETS: ThemePreset[] = [
  { id: 'teal', label: 'Teal', accent: '#0f766e' },
  { id: 'blue', label: 'Ocean blue', accent: '#1d4ed8' },
  { id: 'purple', label: 'Royal purple', accent: '#6d28d9' },
  { id: 'berry', label: 'Berry', accent: '#be185d' },
  { id: 'graphite', label: 'Graphite', accent: '#334155' },
];

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** The CSS variables a theme sets (the rest, like ok/warn/danger, never change). */
export type ThemeTokens = Record<
  | 'bg'
  | 'surface'
  | 'surface-2'
  | 'border'
  | 'text'
  | 'muted'
  | 'accent'
  | 'accent-strong'
  | 'accent-soft'
  | 'accent-text'
  | 'focus'
  | 'selected',
  string
>;

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

function hexToHsl(hex: string): Hsl {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) * 60
      : max === g
        ? ((b - r) / d + 2) * 60
        : ((r - g) / d + 4) * 60;
  return { h, s: s * 100, l: l * 100 };
}

function hsl(h: number, s: number, l: number): string {
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const lig = Math.max(0, Math.min(100, l)) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const READABLE = 4.6;

/** Every colour of one theme in one mode, worked out from its accent colour. */
export function themeTokens(accentHex: string, mode: 'light' | 'dark'): ThemeTokens {
  const seed = hexToHsl(HEX_COLOR.test(accentHex) ? accentHex : '#0f766e');
  const h = seed.h;
  // Greys get a faint tint of the accent so the screens feel of a piece.
  const tint = seed.s < 8 ? seed.s : Math.min(12, seed.s * 0.15);
  if (mode === 'light') {
    const surface = '#ffffff';
    const surface2 = hsl(h, tint * 0.9, 94.5);
    let l = Math.min(seed.l, 48);
    // White text on the accent, and the accent as text on the light greys, must both read well.
    while (l > 8 && contrastRatio(hsl(h, seed.s, l), surface2) < READABLE) l -= 1;
    const accent = hsl(h, seed.s, l);
    const soft = hsl(h, Math.min(seed.s, 70) * 0.55, 93.5);
    return {
      bg: hsl(h, tint, 96.5),
      surface,
      'surface-2': surface2,
      border: hsl(h, tint * 0.85, 87.5),
      text: hsl(h, tint, 11),
      muted: hsl(h, tint * 0.6, 38),
      accent,
      'accent-strong': hsl(h, seed.s, Math.max(6, l - 9)),
      'accent-soft': soft,
      'accent-text': '#ffffff',
      focus: accent,
      selected: soft,
    };
  }
  const surface = hsl(h, tint, 11);
  const sat = Math.min(seed.s, 75);
  let l = Math.max(seed.l, 55);
  while (l < 92 && contrastRatio(hsl(h, sat, l), hsl(h, tint * 0.9, 14.5)) < READABLE) l += 1;
  const accent = hsl(h, sat, l);
  const soft = hsl(h, sat * 0.45, 17);
  return {
    bg: hsl(h, tint, 7),
    surface,
    'surface-2': hsl(h, tint * 0.9, 14.5),
    border: hsl(h, tint * 0.8, 21),
    text: hsl(h, tint * 0.8, 91),
    muted: hsl(h, tint * 0.6, 64),
    accent,
    'accent-strong': hsl(h, sat, Math.min(90, l + 11)),
    'accent-soft': soft,
    'accent-text': hsl(h, Math.min(sat, 60), 8),
    focus: hsl(h, sat, Math.min(90, l + 11)),
    selected: soft,
  };
}

/** The accent colour a saved appearance stands for. */
export function themeAccent(theme: ThemeId, customAccent: string): string {
  if (theme === 'custom') return HEX_COLOR.test(customAccent) ? customAccent : '#0f766e';
  return THEME_PRESETS.find((p) => p.id === theme)?.accent ?? '#0f766e';
}

/** The original teal theme, exactly as designed (the same values as index.css). */
export const TEAL_TOKENS: Record<'light' | 'dark', ThemeTokens> = {
  light: {
    bg: '#f5f6f4',
    surface: '#ffffff',
    'surface-2': '#f0f2ef',
    border: '#dfe3de',
    text: '#1b201d',
    muted: '#5d6660',
    accent: '#0f766e',
    'accent-strong': '#0b5c56',
    'accent-soft': '#e2f2ef',
    'accent-text': '#ffffff',
    focus: '#0f766e',
    selected: '#e2f2ef',
  },
  dark: {
    bg: '#111513',
    surface: '#1a201d',
    'surface-2': '#222a26',
    border: '#2f3934',
    text: '#e7ece9',
    muted: '#9aa69f',
    accent: '#2bb3a5',
    'accent-strong': '#5cc9bd',
    'accent-soft': '#17332f',
    'accent-text': '#06201d',
    focus: '#5cc9bd',
    selected: '#17332f',
  },
};

/** All colours of a saved theme in one mode. */
export function appearanceTokens(
  theme: ThemeId,
  customAccent: string,
  mode: 'light' | 'dark',
): ThemeTokens {
  if (theme === 'teal') return TEAL_TOKENS[mode];
  return themeTokens(themeAccent(theme, customAccent), mode);
}
