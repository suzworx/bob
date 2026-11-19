import { useSyncExternalStore } from 'react';
import { readStoredTheme, type ThemeChoice } from '@/app/use-theme';
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, THEME_OPTIONS, type ThemeId } from './bob-theme';

export type { ThemeChoice };

// v1's storage contract: 'light' | 'dark' under this key, 'system' = key absent.
const STORAGE_KEY = 'bob.theme';

const listeners = new Set<() => void>();

// A blocked storage must not break the toggle, so the choice is also held in
// memory: `override` wins over storage once set, for this session.
let override: ThemeChoice | null = null;

function currentChoice(): ThemeChoice {
  return override ?? readStoredTheme();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The appearance choice, shared by every reader (the Astryx Theme in app.tsx
 * and the sidebar control) so they always agree. Same contract as v1's
 * use-theme: persisted per device in localStorage, absent key = follow system.
 */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, currentChoice, () => 'system');
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'system') {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, choice);
    }
    override = null;
  } catch {
    // Storage is blocked: keep the choice for this session only.
    override = choice;
  }
  for (const listener of [...listeners]) {
    listener();
  }
}

type ThemeScheme = 'light' | 'dark';
type ThemeOption = (typeof THEME_OPTIONS)[number];

// The person chooses only the mode (2026-10 redesign); each scheme renders the brand's default theme.
// Picks an older build stored under 'bob.theme.light' / 'bob.theme.dark' are ignored.
const SCHEME_DEFAULTS: Record<ThemeScheme, ThemeId> = { light: DEFAULT_LIGHT_THEME, dark: DEFAULT_DARK_THEME };

/** The choices the appearance picker offers, in order. */
export const THEME_CHOICES: ReadonlyArray<{ value: ThemeChoice; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function isThemeChoice(value: string): value is ThemeChoice {
  return THEME_CHOICES.some((option) => option.value === value);
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeSystemDark(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

/** Whether the OS prefers dark; follows changes while the app is open. */
export function useSystemPrefersDark(): boolean {
  return useSyncExternalStore(subscribeSystemDark, systemPrefersDark, () => false);
}

/**
 * The theme to render: the brand's default for the scheme the mode names, or
 * for the scheme the OS wants in system mode. The option's scheme is the
 * Theme's mode, so a light theme is never rendered dark.
 */
export function useActiveTheme(): ThemeOption {
  const choice = useThemeChoice();
  const prefersDark = useSystemPrefersDark();
  const scheme: ThemeScheme = choice === 'system' ? (prefersDark ? 'dark' : 'light') : choice;
  const id = SCHEME_DEFAULTS[scheme];
  return THEME_OPTIONS.find((option) => option.id === id) ?? THEME_OPTIONS[0];
}

// Tests reset the module between cases; clears the in-memory fallback.
export function resetThemeChoiceForTests(): void {
  override = null;
}
