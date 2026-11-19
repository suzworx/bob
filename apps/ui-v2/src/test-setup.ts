import type React from 'react';
import { vi } from 'vitest';
import { configure } from '@testing-library/react';

// findBy*/waitFor give up after 1 s by default. A render that takes ~400 ms on
// an idle machine blows through that when the suite shares the CPU (validate on
// a busy laptop, or a CI runner): at load ~138 a `findByText` missed "No spaces
// yet". This is the budget contention needs, not a licence for slow tests; a
// passing wait still returns the moment its condition holds.
//
// Astryx's FieldStatus also announces its message through useAnnounce, which
// writes the same text into a visually hidden, page-level live region
// (data-astryx-live-region) and clears it 2 s later. The region persists
// across the tests in a file, so a text query saw two matches ("Found multiple
// elements"), or a stale one from the previous test, depending on timing.
// Queries look at what is on the page; the announcer is not.
configure({
  asyncUtilTimeout: 5000,
  defaultIgnore: 'script, style, [data-astryx-live-region]',
});

class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;

// Node 22 can expose its experimental process-wide localStorage to jsdom even
// when no backing file was configured. That object has no Storage methods, so
// every browser-facing test fails before exercising the UI. Give jsdom the
// small, per-worker Storage implementation its browser contract expects.
const localStorageEntries = new Map<string, string>();
const localStorageMock: Storage = {
  get length(): number {
    return localStorageEntries.size;
  },
  clear(): void {
    localStorageEntries.clear();
  },
  getItem(key: string): string | null {
    return localStorageEntries.get(key) ?? null;
  },
  key(index: number): string | null {
    return [...localStorageEntries.keys()][index] ?? null;
  },
  removeItem(key: string): void {
    localStorageEntries.delete(key);
  },
  setItem(key: string, value: string): void {
    localStorageEntries.set(key, String(value));
  },
};
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: localStorageMock,
});

// jsdom ships no matchMedia. Theme mode="system" follows the OS colour-scheme
// preference, so give components a never-matching stub if they query it.
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => {
      const listeners = new Set<(event: MediaQueryListEvent) => void>();
      const mql = {
        matches: false,
        media: query,
        onchange: null,
        addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void): void => {
          listeners.add(listener);
        },
        removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void): void => {
          listeners.delete(listener);
        },
        addListener: (listener: (event: MediaQueryListEvent) => void): void => {
          listeners.add(listener);
        },
        removeListener: (listener: (event: MediaQueryListEvent) => void): void => {
          listeners.delete(listener);
        },
        dispatchEvent: (): boolean => true,
      };
      return mql as unknown as MediaQueryList;
    },
  });
}

// jsdom has no CSS.escape and Astryx Dialog calls it when it opens. This is the
// CSSOM "serialize an identifier" algorithm.
function cssEscape(value: string): string {
  const text = String(value);
  const first = text.charCodeAt(0);
  let result = '';
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    const isDigit = unit >= 0x30 && unit <= 0x39;
    if (unit === 0) {
      result += '�';
    } else if (
      (unit >= 0x01 && unit <= 0x1f) ||
      unit === 0x7f ||
      (index === 0 && isDigit) ||
      (index === 1 && isDigit && first === 0x2d)
    ) {
      result += `\\${unit.toString(16)} `;
    } else if (index === 0 && text.length === 1 && unit === 0x2d) {
      result += `\\${text.charAt(index)}`;
    } else if (
      unit >= 0x80 ||
      unit === 0x2d ||
      unit === 0x5f ||
      isDigit ||
      (unit >= 0x41 && unit <= 0x5a) ||
      (unit >= 0x61 && unit <= 0x7a)
    ) {
      result += text.charAt(index);
    } else {
      result += `\\${text.charAt(index)}`;
    }
  }
  return result;
}

if (typeof globalThis.CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    writable: true,
    value: { ...globalThis.CSS, escape: cssEscape },
  });
}

// jsdom has no layout engine, so scrolling is a no-op in tests.
window.scrollTo = ((..._args: unknown[]): void => {}) as typeof window.scrollTo;
Element.prototype.scrollTo = ((..._args: unknown[]): void => {}) as typeof Element.prototype.scrollTo;
Element.prototype.scrollIntoView = ((..._args: unknown[]): void => {}) as typeof Element.prototype.scrollIntoView;

// Astryx's useToast() falls back to a detached viewport (its own createRoot,
// outside the tree Testing Library renders and cleans up) when no
// LayerProvider is above it. An auto-hide toast shown near the end of a file
// then fires its dismiss timer after jsdom is torn down ("document is not
// defined", an unhandled error that fails the run; seen in CI on #1243).
// The app mounts LayerProvider in app.tsx, so every render here gets one too,
// and cleanup() unmounts it with the toast and its timer.
vi.mock('@testing-library/react', async (importOriginal) => {
  const rtl = await importOriginal<typeof import('@testing-library/react')>();
  const { createElement } = await import('react');
  const { LayerProvider } = await import('@astryxdesign/core/Layer');
  const withLayer = (Wrapper?: React.JSXElementConstructor<{ children: React.ReactNode }>) =>
    function TestLayer({ children }: { children: React.ReactNode }): React.ReactElement {
      return createElement(LayerProvider, null, Wrapper ? createElement(Wrapper, null, children) : children);
    };
  const render: typeof rtl.render = ((ui: React.ReactNode, options?: Parameters<typeof rtl.render>[1]) =>
    rtl.render(ui, { ...options, wrapper: withLayer(options?.wrapper) })) as typeof rtl.render;
  const renderHook: typeof rtl.renderHook = ((callback: never, options?: { wrapper?: React.JSXElementConstructor<{ children: React.ReactNode }> }) =>
    rtl.renderHook(callback, { ...options, wrapper: withLayer(options?.wrapper) })) as typeof rtl.renderHook;
  return { ...rtl, render, renderHook };
});
