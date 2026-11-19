import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { THEME_OPTIONS } from './bob-theme';
import { resetThemeChoiceForTests, setThemeChoice, THEME_CHOICES, useActiveTheme, useSystemPrefersDark } from './theme-choice';

const DARK_QUERY = '(prefers-color-scheme: dark)';

// A matchMedia whose dark result the test controls and can flip like an OS setting change.
function mockOsScheme(startsDark: boolean): (dark: boolean) => void {
  let matches = startsDark;
  const listeners = new Set<() => void>();
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        get matches(): boolean {
          return query === DARK_QUERY && matches;
        },
        media: query,
        addEventListener: (_type: string, listener: () => void): void => {
          listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: () => void): void => {
          listeners.delete(listener);
        },
      }) as unknown as MediaQueryList,
  );
  return (dark: boolean): void => {
    matches = dark;
    act(() => listeners.forEach((listener) => listener()));
  };
}

describe('the active theme', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetThemeChoiceForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers only System, Light and Dark', () => {
    expect(THEME_CHOICES.map((choice) => choice.label)).toEqual(['System', 'Light', 'Dark']);
  });

  it("is the brand's default for the mode's scheme, whatever the OS wants", () => {
    mockOsScheme(true);
    const { result } = renderHook(() => useActiveTheme());
    act(() => setThemeChoice('light'));
    expect(result.current).toBe(THEME_OPTIONS.find((option) => option.id === 'bob'));
    act(() => setThemeChoice('dark'));
    expect(result.current).toBe(THEME_OPTIONS.find((option) => option.id === 'bob-dark'));
  });

  it('ignores a theme an older build stored per scheme', () => {
    window.localStorage.setItem('bob.theme.light', 'paper');
    window.localStorage.setItem('bob.theme.dark', 'midnight');
    mockOsScheme(false);
    const { result } = renderHook(() => useActiveTheme());
    expect(result.current.id).toBe('bob');
  });

  it('follows a mocked matchMedia in system mode, live', () => {
    const setOsDark = mockOsScheme(false);
    const { result } = renderHook(() => useActiveTheme());
    expect(result.current.id).toBe('bob');
    expect(result.current.scheme).toBe('light');
    setOsDark(true);
    expect(result.current.id).toBe('bob-dark');
    expect(result.current.scheme).toBe('dark');
    setOsDark(false);
    expect(result.current.id).toBe('bob');
  });

  it('reports whether the OS prefers dark, asking the dark query', () => {
    const setOsDark = mockOsScheme(false);
    const { result } = renderHook(() => useSystemPrefersDark());
    expect(result.current).toBe(false);
    setOsDark(true);
    expect(result.current).toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith(DARK_QUERY);
  });
});
