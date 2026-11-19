import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'bob.theme';

export function readStoredTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = choice;
  }
}

/**
 * Resolves the appearance from an explicit stored choice, falling back to the
 * operating system setting, and follows system changes while the client is
 * open (FR-035, FR-036). An appearance preference is per-device by definition,
 * so it lives in this browser only (data-model.md).
 */
function useTheme(): {
  choice: ThemeChoice;
  setChoice: (choice: ThemeChoice) => void;
  systemPrefersDark: boolean;
} {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStoredTheme);
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false,
  );

  useEffect(() => {
    applyTheme(readStoredTheme());
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent): void => {
      setSystemPrefersDark(event.matches);
      if (readStoredTheme() === 'system') {
        applyTheme('system');
      }
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const setChoice = useCallback((next: ThemeChoice): void => {
    try {
      if (next === 'system') {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      // A blocked storage must not break the toggle; the choice applies for
      // this session regardless.
    }
    setChoiceState(next);
    applyTheme(next);
  }, []);

  return { choice, setChoice, systemPrefersDark };
}
