import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useInitialLoading, useRefreshOnFocus } from './use-refresh-on-focus';

let visibility: DocumentVisibilityState = 'visible';

function showTab(state: DocumentVisibilityState): void {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function focusWindow(): void {
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('useRefreshOnFocus', () => {
  it('starts at zero and ticks when the document becomes visible again', () => {
    const { result } = renderHook(() => useRefreshOnFocus());
    expect(result.current).toBe(0);
    showTab('visible');
    expect(result.current).toBe(1);
  });

  it('ignores the document going hidden', () => {
    const { result } = renderHook(() => useRefreshOnFocus());
    showTab('hidden');
    expect(result.current).toBe(0);
  });

  it('ticks when the window regains focus', () => {
    const { result } = renderHook(() => useRefreshOnFocus());
    focusWindow();
    expect(result.current).toBe(1);
  });

  it('counts a visibility change and a focus that arrive together once', () => {
    const { result } = renderHook(() => useRefreshOnFocus());
    showTab('visible');
    focusWindow();
    expect(result.current).toBe(1);
  });

  it('ticks at most once per five seconds', () => {
    const { result } = renderHook(() => useRefreshOnFocus());
    focusWindow();
    vi.advanceTimersByTime(4_999);
    focusWindow();
    expect(result.current).toBe(1);
    vi.advanceTimersByTime(1);
    focusWindow();
    expect(result.current).toBe(2);
  });

  it('removes both listeners on unmount', () => {
    const addDocument = vi.spyOn(document, 'addEventListener');
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    const addWindow = vi.spyOn(window, 'addEventListener');
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useRefreshOnFocus());

    const visibilityListener = addDocument.mock.calls.find(([type]) => type === 'visibilitychange')?.[1];
    const focusListener = addWindow.mock.calls.find(([type]) => type === 'focus')?.[1];
    expect(visibilityListener).toBeTypeOf('function');
    expect(focusListener).toBeTypeOf('function');

    unmount();
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', visibilityListener);
    expect(removeWindow).toHaveBeenCalledWith('focus', focusListener);
  });
});

describe('useInitialLoading', () => {
  it('is true while the first load runs and false once it has finished', () => {
    const { result, rerender } = renderHook(({ loading }) => useInitialLoading(loading), {
      initialProps: { loading: true },
    });
    expect(result.current).toBe(true);
    rerender({ loading: false });
    expect(result.current).toBe(false);
  });

  it('stays false when a later refetch raises loading again', () => {
    const { result, rerender } = renderHook(({ loading }) => useInitialLoading(loading), {
      initialProps: { loading: true },
    });
    rerender({ loading: false });
    rerender({ loading: true });
    expect(result.current).toBe(false);
    rerender({ loading: false });
    expect(result.current).toBe(false);
  });
});
