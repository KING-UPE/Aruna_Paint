import { describe, expect, it } from 'vitest';
import { THEME_PRESETS, contrastRatio, themeAccent, themeTokens } from '../src/domain/themes';

const samples = [
  ...THEME_PRESETS.map((p) => p.accent),
  '#facc15',
  '#ffffff',
  '#000000',
  '#22d3ee',
  '#808080',
];

describe('colour themes', () => {
  it.each(samples)('keeps text readable in light and dark mode for %s', (accent) => {
    for (const mode of ['light', 'dark'] as const) {
      const t = themeTokens(accent, mode);
      // Body text and secondary text on cards and on the page.
      expect(contrastRatio(t.text, t.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.muted, t.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.muted, t['surface-2'])).toBeGreaterThanOrEqual(4.5);
      // Text on accent buttons, and accent text (links, chips) on cards and soft chips.
      expect(contrastRatio(t['accent-text'], t.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.accent, t.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t['accent-strong'], t['accent-soft'])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('a custom theme uses its own colour; a bad colour falls back to teal', () => {
    expect(themeAccent('custom', '#123456')).toBe('#123456');
    expect(themeAccent('custom', 'red')).toBe('#0f766e');
    expect(themeAccent('blue', '#123456')).toBe('#1d4ed8');
  });
});
