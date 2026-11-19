import { describe, expect, it } from 'vitest';
import { neutralTheme } from '@astryxdesign/theme-neutral';
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, THEME_OPTIONS, bobTheme } from './bob-theme';

// A defined theme is flat: extends is resolved when it is defined, so the resolved tokens, icons and
// component overrides sit on the object itself.
interface ResolvedTheme {
  name: string;
  tokens: Record<string, unknown>;
  icons: Record<string, unknown>;
  components: Record<string, unknown>;
}

const bob = bobTheme as unknown as ResolvedTheme;
const neutral = neutralTheme as unknown as ResolvedTheme;

// A token is either one colour or `light-dark(<light>, <dark>)`; this is the half a scheme renders.
function halfFor(value: unknown, scheme: 'light' | 'dark'): string {
  const text = String(value);
  const pair = /^light-dark\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/.exec(text);
  if (!pair) return text;
  return scheme === 'light' ? pair[1] : pair[2];
}

function channel(hex: string, start: number): number {
  const value = parseInt(hex.slice(start, start + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

// WCAG 2.x relative luminance of #rrggbb.
function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function ratio(theme: ResolvedTheme, scheme: 'light' | 'dark', foreground: string, background: string): number {
  return contrast(halfFor(theme.tokens[foreground], scheme), halfFor(theme.tokens[background], scheme));
}

describe('THEME_OPTIONS', () => {
  it('offers the Bob themes with unique ids, each named after its theme', () => {
    expect(THEME_OPTIONS.map((option) => option.id)).toEqual(['bob', 'bob-paper', 'bob-dark', 'bob-navy']);
    for (const option of THEME_OPTIONS) {
      expect(option.theme.name).toBe(option.theme === bobTheme ? 'bob' : option.id);
    }
  });

  it('defaults both schemes to the Bob theme', () => {
    expect(THEME_OPTIONS.find((option) => option.id === DEFAULT_LIGHT_THEME)?.theme).toBe(bobTheme);
    expect(THEME_OPTIONS.find((option) => option.id === DEFAULT_DARK_THEME)?.theme).toBe(bobTheme);
    expect(DEFAULT_LIGHT_THEME).toBe('bob');
    expect(DEFAULT_DARK_THEME).toBe('bob-dark');
  });

  it('reads at least 4.5:1 for text on the body and for on-accent on the accent, in its own scheme', () => {
    for (const { id, scheme, theme } of THEME_OPTIONS) {
      const resolved = theme as unknown as ResolvedTheme;
      expect(ratio(resolved, scheme, '--color-text-primary', '--color-background-body'), `${id} text`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(resolved, scheme, '--color-on-accent', '--color-accent'), `${id} on-accent`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps Nunito, DM Mono and neutral's icon registry in every theme", () => {
    for (const { theme } of THEME_OPTIONS) {
      const resolved = theme as unknown as ResolvedTheme;
      expect(resolved.tokens['--font-family-body']).toBe('Nunito, system-ui, sans-serif');
      expect(resolved.tokens['--font-family-code']).toBe('"DM Mono", ui-monospace, monospace');
      expect(resolved.icons.close).toBe(neutral.icons.close);
    }
  });
});

describe('bobTheme', () => {
  const schemes = ['light', 'dark'] as const;

  it('is named bob, matching the data-astryx-theme attribute in index.html', () => {
    expect(bob.name).toBe('bob');
  });

  it('extends the neutral theme, keeping its icon registry and component overrides', () => {
    expect(bob.icons.close).toBe(neutral.icons.close);
    expect(Object.keys(bob.icons)).toEqual(expect.arrayContaining(Object.keys(neutral.icons)));
    expect(bob.components.badge).toBeDefined();
  });

  it("keeps neutral's surfaces and text: no cream, no navy", () => {
    for (const token of ['--color-background-body', '--color-background-surface', '--color-background-card', '--color-text-primary', '--color-border']) {
      expect(bob.tokens[token], token).toBe(neutral.tokens[token]);
    }
  });

  it('uses Bob ink as the light accent, with white on it, and reserves Bob yellow (in no token)', () => {
    expect(halfFor(bob.tokens['--color-accent'], 'light').toLowerCase()).toBe('#173e57');
    expect(halfFor(bob.tokens['--color-on-accent'], 'light').toLowerCase()).toBe('#ffffff');
    for (const [token, value] of Object.entries(bob.tokens)) {
      expect(String(value).toLowerCase(), token).not.toContain('f0c75e');
    }
  });

  it.each(schemes)('%s: reads at least 4.5:1 for text, on-accent and accent text', (scheme) => {
    expect(ratio(bob, scheme, '--color-text-primary', '--color-background-body')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(bob, scheme, '--color-on-accent', '--color-accent')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(bob, scheme, '--color-text-accent', '--color-background-body')).toBeGreaterThanOrEqual(4.5);
  });

  it("replaces neutral's blue hover and selected rings", () => {
    for (const token of ['--shadow-inset-hover', '--shadow-inset-selected']) {
      expect(String(bob.tokens[token]).toLowerCase()).not.toContain('#0074e2');
    }
  });

  it('sets Nunito for body and headings, DM Mono for code, neutral icons', () => {
    expect(bob.tokens['--font-family-body']).toBe('Nunito, system-ui, sans-serif');
    expect(bob.tokens['--font-family-heading']).toBe('Nunito, system-ui, sans-serif');
    expect(bob.tokens['--font-family-code']).toBe('"DM Mono", ui-monospace, monospace');
    expect(bob.icons.close).toBe(neutral.icons.close);
  });
});
