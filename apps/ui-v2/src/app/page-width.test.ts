import { createElement } from 'react';
import { render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const shell = vi.hoisted(() => ({ isMobile: false }));
// The size the last desktop button was asked for, so a test can see it.
const button = vi.hoisted(() => ({ size: undefined as string | undefined }));

vi.mock('@astryxdesign/core/AppShell', () => ({
  useAppShellMobile: () => ({ isMobile: shell.isMobile }),
}));
// A marker stands in for the visually hidden wrapper, so the test sees whether the h1 sits in it.
vi.mock('@astryxdesign/core/VisuallyHidden', () => ({
  VisuallyHidden: ({ children }: { children: unknown }) => createElement('div', { 'data-testid': 'hidden' }, children as never),
}));
// Records the size each desktop button is given, then renders the real button.
vi.mock('@astryxdesign/core/Button', async (original) => {
  const actual = await original<typeof import('@astryxdesign/core/Button')>();
  return {
    ...actual,
    Button: (props: { size?: string }) => {
      button.size = props.size;
      return createElement(actual.Button, props as never);
    },
  };
});

import { PAGE_PADDING, PHONE_PAGE_PADDING, PageAction, PageTitle, usePagePadding } from './page-width';

describe('usePagePadding', () => {
  it('gives a phone the tighter token than desktop', () => {
    shell.isMobile = true;
    const phone = renderHook(() => usePagePadding()).result.current;
    shell.isMobile = false;
    const desktop = renderHook(() => usePagePadding()).result.current;
    expect(phone).toBe(PHONE_PAGE_PADDING);
    expect(desktop).toBe(PAGE_PADDING);
    expect(phone).toBeLessThan(desktop);
  });
});

describe('PageTitle', () => {
  it('keeps the h1 for assistive tech but hides it visually on a phone', () => {
    shell.isMobile = true;
    render(createElement(PageTitle, null, 'Spaces'));
    const heading = screen.getByRole('heading', { level: 1, name: 'Spaces' });
    expect(heading.closest('[data-testid="hidden"]')).not.toBeNull();
  });

  it('shows the h1 as is on desktop', () => {
    shell.isMobile = false;
    render(createElement(PageTitle, null, 'Spaces'));
    const heading = screen.getByRole('heading', { level: 1, name: 'Spaces' });
    expect(heading.closest('[data-testid="hidden"]')).toBeNull();
  });
});

describe('PageAction', () => {
  it('is one named button on both phone and desktop', () => {
    for (const isMobile of [true, false]) {
      shell.isMobile = isMobile;
      const { unmount } = render(createElement(PageAction, { label: 'Add memory', icon: null, onClick: () => {} }));
      expect(screen.getByRole('button', { name: 'Add memory' })).toBeTruthy();
      unmount();
    }
  });

  it('renders the small desktop button where the page asks for small', () => {
    shell.isMobile = false;
    render(createElement(PageAction, { label: 'Add memory', icon: null, size: 'sm', onClick: () => {} }));
    expect(button.size).toBe('sm');
  });

  it('keeps the default desktop size where the page asks for none', () => {
    shell.isMobile = false;
    render(createElement(PageAction, { label: 'Create with Bob', icon: null, onClick: () => {} }));
    expect(button.size).toBeUndefined();
  });
});
