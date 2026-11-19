import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import type { Space } from '@/features/spaces/use-spaces';
import { CreateSpaceDialog, parseInviteEmails } from './create-space-controls';

type OnCreate = (name: string) => Promise<Space | null>;

const CREATED: Space = {
  id: 's1',
  kind: 'group',
  name: 'Home',
  role: 'owner',
  membership_revision: 1,
  created_at: 0,
  updated_at: 0,
  members: [],
};

function renderDialog(onCreate: OnCreate, onClose = vi.fn(), onCreated = vi.fn()): void {
  render(
    <Theme theme={neutralTheme}>
      <CreateSpaceDialog onClose={onClose} onCreate={onCreate} onCreated={onCreated} />
    </Theme>,
  );
}

vi.mock('@/lib/auth/use-session', () => ({
  fetchWithAuth: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

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

afterEach(() => {
  cleanup();
});

describe('CreateSpaceDialog', () => {
  it('asks the name and optional invites, and no kind to pick', () => {
    renderDialog(vi.fn<OnCreate>());
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByRole('textbox', { name: /^Invite/ })).toBeTruthy();
  });

  it('creates with the name, then closes and hands back the new space', async () => {
    const onCreate = vi.fn<OnCreate>().mockResolvedValue(CREATED);
    const onClose = vi.fn();
    const onCreated = vi.fn();
    renderDialog(onCreate, onClose, onCreated);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Home');
    await user.click(screen.getByRole('button', { name: 'Create space' }));
    expect(onCreate).toHaveBeenCalledWith('Home');
    expect(onClose).toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith(CREATED, 0);
  });

  it('sends one member invitation per address after creating', async () => {
    const posts: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push([String(input), JSON.parse(String(init?.body))]);
      return new Response('{}', { status: 201 });
    }));
    const onCreated = vi.fn();
    renderDialog(vi.fn<OnCreate>().mockResolvedValue(CREATED), vi.fn(), onCreated);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Home');
    await user.type(screen.getByRole('textbox', { name: /^Invite/ }), 'a@example.com, B@example.com');
    await user.click(screen.getByRole('button', { name: 'Create space' }));
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(CREATED, 0));
    expect(posts).toEqual([
      ['/api/spaces/s1/invitations', { email: 'a@example.com', role: 'member' }],
      ['/api/spaces/s1/invitations', { email: 'b@example.com', role: 'member' }],
    ]);
    vi.unstubAllGlobals();
  });

  it('blocks Create while an invite address is not an address', async () => {
    renderDialog(vi.fn<OnCreate>());
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Home');
    await user.type(screen.getByRole('textbox', { name: /^Invite/ }), 'not-an-email');
    expect((screen.getByRole('button', { name: 'Create space' }) as HTMLButtonElement).disabled).toBe(true);
    expect(parseInviteEmails('a@b.co; c@d.io')).toEqual(['a@b.co', 'c@d.io']);
    expect(parseInviteEmails('')).toEqual([]);
  });

  it('does not create twice for a second rapid Enter', async () => {
    let release: (value: Space | null) => void = () => undefined;
    const onCreate = vi.fn<OnCreate>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderDialog(onCreate);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Home');
    await user.keyboard('{Enter}{Enter}');
    expect(onCreate).toHaveBeenCalledTimes(1);
    release(CREATED);
  });

  it('#869 keeps a pasted 500-character name, shows the 60-character limit and blocks submit', async () => {
    const onCreate = vi.fn<OnCreate>().mockResolvedValue(CREATED);
    renderDialog(onCreate);
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'Name' });
    const long = 'a'.repeat(500);
    await user.click(input);
    await user.paste(long);
    expect((input as HTMLInputElement).value).toBe(long);
    expect(screen.getByText(/60 characters/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Create space' }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard('{Enter}');
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('#869 creates with the exact name once the draft is corrected to 60 characters', async () => {
    const onCreate = vi.fn<OnCreate>().mockResolvedValue(CREATED);
    renderDialog(onCreate);
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'Name' });
    await user.click(input);
    await user.paste('b'.repeat(500));
    await user.clear(input);
    const exact = 'c'.repeat(60);
    await user.paste(exact);
    expect(screen.queryByText(/60 characters/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Create space' }));
    expect(onCreate).toHaveBeenCalledWith(exact);
  });

  it('shows the failure text and stays open when onCreate resolves null', async () => {
    const onCreate = vi.fn<OnCreate>().mockResolvedValue(null);
    const onClose = vi.fn();
    renderDialog(onCreate, onClose);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Home');
    await user.click(screen.getByRole('button', { name: 'Create space' }));
    expect(await screen.findByText('That could not be created.')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
