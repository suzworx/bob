import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { spaceKindLabel, type Space } from '@/features/spaces/use-spaces';
import { SPACE_SECTIONS, type SpaceSection } from '../../app/routes';
import { SpaceHeader } from './space-header';

// Phone is Astryx's mobile breakpoint; jsdom has no layout, so the test sets it.
const shell = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@astryxdesign/core/AppShell', async (original) => {
  const actual = await original<typeof import('@astryxdesign/core/AppShell')>();
  return { ...actual, useAppShellMobile: () => ({ ...actual.useAppShellMobile(), isMobile: shell.isMobile }) };
});
// jsdom loads no StyleX, so stand in a marker for VisuallyHidden.
vi.mock('@astryxdesign/core/VisuallyHidden', () => ({
  VisuallyHidden: ({ children }: { children: ReactNode }) => <div data-testid="visually-hidden">{children}</div>,
}));

// In SPACE_SECTIONS order, so a section and its visible tab stay paired.
const TAB_LABELS = ['Threads', 'Tasks', 'Notes', 'Agenda', 'Members', 'Apps'];

const MEMBERS = [
  { user_id: 'u-self-0123456789', role: 'owner', joined_at: 1, display_name: 'Sam', handle: 'sam', email: null },
  { user_id: 'u-riley-0123456789', role: 'member', joined_at: 2, display_name: null, handle: 'riley', email: null },
];

const SPACE: Space = {
  id: 's1',
  kind: 'group',
  name: 'Home',
  role: 'owner',
  membership_revision: 1,
  created_at: 0,
  updated_at: 0,
  members: MEMBERS,
};

function renderHeader(overrides: Partial<Parameters<typeof SpaceHeader>[0]> = {}): {
  onSelectSection: ReturnType<typeof vi.fn>;
} {
  const onSelectSection = vi.fn();
  render(
    <Theme theme={neutralTheme}>
      <SpaceHeader
        space={SPACE}
        section="threads"
        onSelectSection={onSelectSection}
        onRename={vi.fn().mockResolvedValue(true)}
        onArchive={vi.fn()}
        {...overrides}
      />
    </Theme>,
  );
  return { onSelectSection };
}

afterEach(() => {
  cleanup();
});

describe('SpaceHeader on a phone', () => {
  afterEach(() => {
    shell.isMobile = false;
  });

  function stubPhone(): void {
    shell.isMobile = true;
  }

  it('is one name row, with Tools moved into the one "..." menu', async () => {
    stubPhone();
    const user = userEvent.setup();
    renderHeader();
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tools' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Space actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Tools' })).toBeTruthy();
  });

  it('drops the kind chip and the member avatars from the row', () => {
    stubPhone();
    renderHeader();
    expect(screen.queryByText(spaceKindLabel(SPACE))).toBeNull();
    expect(screen.queryByRole('group', { name: 'Avatars' })).toBeNull();
  });

  it('shows only the thread bar while a thread is open', () => {
    stubPhone();
    renderHeader({ threadBar: <span>Thread bar</span> });
    expect(screen.getByText('Thread bar')).toBeTruthy();
    // The h1 stays for assistive tech, visually hidden; the tabs are gone.
    const title = screen.getByRole('heading', { level: 1, name: 'Home' });
    expect(title.closest('[data-testid="visually-hidden"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Notes' })).toBeNull();
  });

  it('keeps Tools, the avatars and the chip in the row on desktop', () => {
    renderHeader();
    expect(screen.getByRole('link', { name: 'Tools' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Avatars' })).toBeTruthy();
    expect(screen.getByText(spaceKindLabel(SPACE))).toBeTruthy();
  });
});

describe('SpaceHeader', () => {
  it('renders the available section tabs and marks exactly one of them selected', () => {
    // One route section drives the whole strip, so whichever section is open,
    // one tab is current and one tab carries the selected styling hook — never
    // two. (A second tab showing a filled pill is Astryx's own hover
    // background, which is not a selected state.)
    for (const section of SPACE_SECTIONS) {
      cleanup();
      renderHeader({ section });
      const tabs = TAB_LABELS.map((label) => screen.getByRole('button', { name: label }));
      expect(tabs).toHaveLength(6);
      expect(tabs.filter((tab) => tab.getAttribute('aria-current') === 'true')).toHaveLength(1);
      expect(tabs.filter((tab) => tab.getAttribute('data-selected') === 'selected')).toHaveLength(1);
      expect(
        screen.getByRole('button', { name: TAB_LABELS[SPACE_SECTIONS.indexOf(section)] }).getAttribute('aria-current'),
      ).toBe('true');
    }
  });

  it('calls onSelectSection with the clicked section', async () => {
    const { onSelectSection } = renderHeader({ section: 'threads' as SpaceSection });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Notes' }));
    expect(onSelectSection).toHaveBeenCalledWith('notes');
  });

  it('labels the kind with one neutral token: Shared, or Partner for a pair', () => {
    renderHeader();
    expect(screen.getByText('Shared')).toBeTruthy();
    cleanup();
    renderHeader({ space: { ...SPACE, kind: 'pair' } });
    expect(screen.getByText('Partner')).toBeTruthy();
  });

  it('shows no role chip: the role lives in Members', () => {
    renderHeader();
    expect(screen.queryByText('Owner')).toBeNull();
  });

  it('keeps one header line and puts an open thread on its own row under the tabs', () => {
    renderHeader({ threadBar: 'Groceries bar' });
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    expect(screen.getByText('Groceries bar')).toBeTruthy();
    expect(screen.getByRole('navigation').textContent).not.toContain('Groceries bar');
  });

  it('has no Threads or Members tab and no member avatars in Private', () => {
    renderHeader({ space: { ...SPACE, kind: 'private', name: 'Private' }, section: 'tasks' });
    expect(screen.queryByRole('button', { name: 'Threads' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Members' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Tasks' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Space actions' })).toBeNull();
  });

  it('mounts the menu only when opened: Invite, Rename, then Archive last for the owner', async () => {
    const onArchive = vi.fn();
    renderHeader({ onArchive, onInvite: vi.fn(), onLeave: vi.fn() });
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Space actions' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Invite people', 'Rename', 'Archive']);
    // Archive is reversible: no type-to-confirm dialog, the page archives with Undo.
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('offers a plain member Leave space and nothing to manage', async () => {
    const onLeave = vi.fn();
    renderHeader({ space: { ...SPACE, role: 'member' }, onLeave, onInvite: vi.fn() });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Space actions' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Leave space']);
    await user.click(screen.getByRole('menuitem', { name: 'Leave space' }));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('never renders a raw member user id', () => {
    renderHeader();
    for (const member of MEMBERS) {
      expect(document.body.textContent).not.toContain(member.user_id);
    }
  });
});

describe('SpaceHeader rename name limit', () => {
  // jsdom has no modal <dialog>; the Astryx dialog calls showModal() on open.
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });

  const isDisabled = (el: HTMLElement): boolean =>
    (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true';

  async function openRename(user: ReturnType<typeof userEvent.setup>): Promise<HTMLInputElement> {
    await user.click(await screen.findByRole('button', { name: 'Space actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    return (await screen.findByRole('textbox', { name: 'Space name' })) as HTMLInputElement;
  }

  it('#869 keeps a pasted 500-character name, shows the 60-character limit and blocks submit', async () => {
    const onRename = vi.fn<(id: string, name: string) => Promise<boolean>>().mockResolvedValue(true);
    renderHeader({ onRename });
    const user = userEvent.setup();
    const input = await openRename(user);
    const long = 'a'.repeat(500);
    await user.clear(input);
    await user.paste(long);
    expect(input.value).toBe(long);
    expect(screen.getByText(/60 characters/)).toBeTruthy();
    expect(isDisabled(screen.getByRole('button', { name: 'Save' }))).toBe(true);
    await user.keyboard('{Enter}');
    expect(onRename).not.toHaveBeenCalled();
  });

  it('#869 renames with the exact name once the draft is corrected to 60 characters', async () => {
    const onRename = vi.fn<(id: string, name: string) => Promise<boolean>>().mockResolvedValue(true);
    renderHeader({ onRename });
    const user = userEvent.setup();
    const input = await openRename(user);
    await user.clear(input);
    await user.paste('b'.repeat(500));
    await user.clear(input);
    const exact = 'c'.repeat(60);
    await user.paste(exact);
    expect(screen.queryByText(/60 characters/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onRename).toHaveBeenCalledWith('s1', exact);
  });

  // Restored from space-actions.test.tsx: a failed rename keeps the dialog and the typed name.
  it('keeps the dialog and the typed name, and shows the error, when rename resolves false', async () => {
    const onRename = vi.fn<(id: string, name: string) => Promise<boolean>>().mockResolvedValue(false);
    renderHeader({ onRename });
    const user = userEvent.setup();
    const input = await openRename(user);
    await user.clear(input);
    await user.type(input, '  Cabin  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onRename).toHaveBeenCalledWith('s1', 'Cabin');
    expect(await screen.findByText('The space could not be renamed.')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Space name' }) as HTMLInputElement).value).toBe('  Cabin  ');
  });
});
