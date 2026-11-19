import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installStaleBuildReload, isChunkLoadError, type ReloadHost } from './stale-build';

const KEY = 'bob.staleReloadAt';

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length(): number {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, String(value)),
  };
}

// A real EventTarget stands in for window so the handler runs the way it does in the browser.
function fakeWindow(sessionStorage: Storage = memoryStorage()): {
  win: ReloadHost;
  reload: ReturnType<typeof vi.fn>;
  preloadError: () => Event;
} {
  const target = new EventTarget();
  const reload = vi.fn();
  const win: ReloadHost = {
    addEventListener: (type, listener) => target.addEventListener(type, listener),
    removeEventListener: (type, listener) => target.removeEventListener(type, listener),
    sessionStorage,
    location: { reload },
  };
  const preloadError = (): Event => {
    const event = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  return { win, reload, preloadError };
}

describe('installStaleBuildReload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reloads once on vite:preloadError and stops the error from being thrown', () => {
    const { win, reload, preloadError } = fakeWindow();
    installStaleBuildReload(win);
    const event = preloadError();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(win.sessionStorage.getItem(KEY)).toBe(String(Date.now()));
  });

  it('does not reload again within 10 seconds and lets the error propagate', () => {
    const { win, reload, preloadError } = fakeWindow();
    installStaleBuildReload(win);
    preloadError();
    vi.advanceTimersByTime(9_999);
    const second = preloadError();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(second.defaultPrevented).toBe(false);
  });

  it('reloads again once the 10 second window has passed', () => {
    const { win, reload, preloadError } = fakeWindow();
    installStaleBuildReload(win);
    preloadError();
    vi.advanceTimersByTime(10_000);
    preloadError();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not reload when sessionStorage throws, since the loop guard could not work', () => {
    const broken = memoryStorage();
    broken.getItem = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    const { win, reload, preloadError } = fakeWindow(broken);
    installStaleBuildReload(win);
    const event = preloadError();
    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('stops listening once the returned function is called', () => {
    const { win, reload, preloadError } = fakeWindow();
    installStaleBuildReload(win)();
    preloadError();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('isChunkLoadError', () => {
  it.each([
    ['Chrome', 'Failed to fetch dynamically imported module: https://app.heybob.xyz/assets/spaces-page-CQtrY5O0.js'],
    ['Safari', 'Importing a module script failed.'],
    ['Firefox', 'error loading dynamically imported module: https://app.heybob.xyz/assets/spaces-page-CQtrY5O0.js'],
  ])('matches the %s message', (_browser, message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });

  it('does not match an unrelated Error or a non-error value', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});
