import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShellMobileContext } from '@astryxdesign/core/AppShell';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

async function landing(brand: 'bob'): Promise<ReturnType<typeof vi.fn>> {
  // The Today glance reads the calendar's data; an unreachable server shows no glance.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
  window.history.replaceState(null, '', `/?brand=${brand}`);
  vi.resetModules();
  const { ChatLanding } = await import('./chat-landing');
  const onPrompt = vi.fn();
  render(<ChatLanding userName="Sam" composer={<textarea aria-label="Message" />} onPrompt={onPrompt} />);
  return onPrompt;
}

it('welcomes Bob users with the approved artwork through Avatar and one modest page heading', async () => {
  await landing('bob');
  const avatar = screen.getByRole('img', { name: 'Bob waving hello' });
  expect(avatar.querySelector('img')?.getAttribute('src')).toBe('/brand/bob/bob-playful.webp');
  const headings = screen.getAllByRole('heading');
  expect(headings).toHaveLength(1);
  expect(headings[0]?.textContent).toBe('Where should we start?');
  expect(screen.getByText('Hi, Sam').tagName).toBe('P');
});

it('puts the composer before three prompt chips that fill rather than send', async () => {
  const onPrompt = await landing('bob');
  const box = screen.getByRole('textbox', { name: 'Message' });
  const chip = screen.getByRole('button', { name: 'Plan my week' });
  expect(box.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getAllByRole('button', { name: /^(Plan my week|What's on today\?|Remember something)$/ })).toHaveLength(3);
  await userEvent.setup().click(chip);
  expect(onPrompt).toHaveBeenCalledExactlyOnceWith('Plan my week using my tasks and events.');
});

describe('collaborate action', () => {
  const shell = { isMobile: false, isMobileNavOpen: false, toggleMobileNav() {}, openMobileNav() {}, closeMobileNav() {}, isMobileNavEnabled: false, hasAutoToggle: true };

  async function renderLanding(isMobile: boolean): Promise<HTMLElement> {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    const { ChatLanding } = await import('./chat-landing');
    render(
      <AppShellMobileContext value={{ ...shell, isMobile }}>
        <ChatLanding userName="Sam" composer={<textarea aria-label="Message" />} onPrompt={vi.fn()} headerAction={<button type="button">Collaborate</button>} />
      </AppShellMobileContext>,
    );
    return screen.getByRole('button', { name: 'Collaborate' });
  }

  it('floats in the header on desktop', async () => {
    expect((await renderLanding(false)).closest('.astryx-layout-header')).not.toBeNull();
  });

  it('keeps the chips in the content block with the greeting and docks only the composer on a phone', async () => {
    await renderLanding(true);
    const chip = screen.getByRole('button', { name: 'Plan my week' });
    expect(chip.closest('.astryx-layout-footer')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message' }).closest('.astryx-layout-footer')).not.toBeNull();
  });

  it('sits in the flow beside the greeting on a phone, not alone in a header row', async () => {
    const button = await renderLanding(true);
    expect(button.closest('.astryx-layout-header')).toBeNull();
  });
});
