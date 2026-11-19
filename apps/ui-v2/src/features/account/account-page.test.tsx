import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as supabaseClient from '@/lib/auth/supabase-client';
import { browserTimeZone } from '@/lib/auth/use-session';
import { SettingsPage as AccountPage, settingsTarget } from './account-page';

// Sections other domains own are covered by their own tests; stubs keep this one on the page shape.
vi.mock('@/features/notifications/notification-settings', () => ({ NotificationSettingsSection: () => <p>Notification settings section</p> }));
vi.mock('@/features/memory/delete-all-memories', () => ({ DeleteAllMemoriesSection: () => <p>Delete all memories section</p> }));
vi.mock('@/features/usage/usage-section', () => ({ UsageSection: () => <p>Usage section</p> }));

// The phone layout follows the AppShell breakpoint; the phone cases flip this flag.
const phone = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@astryxdesign/core/AppShell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@astryxdesign/core/AppShell')>();
  return { ...actual, useAppShellMobile: () => ({ ...actual.useAppShellMobile(), isMobile: phone.isMobile }) };
});
// Astryx hides its VisuallyHidden content with styles jsdom does not apply, so this stand-in
// marks the wrapper instead: the test asserts which heading sits inside it.
vi.mock('@astryxdesign/core/VisuallyHidden', () => ({
  VisuallyHidden: ({ children }: { children: ReactNode }) => <div data-testid="visually-hidden">{children}</div>,
}));

vi.mock('../../app/routes', () => ({
  navigateTo: vi.fn(),
  useLocationHash: () => window.location.hash,
}));

const mockUseSession = vi.hoisted(() => vi.fn());
const mockFetchWithAuth = vi.hoisted(() => vi.fn());
// Pinned so the host's zone (e.g. Asia/Calcutta alias) can't change the labels.
const mockBrowserTimeZone = vi.hoisted(() => vi.fn((): string => 'UTC'));
vi.mock('@/lib/auth/use-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/use-session')>();
  return {
    ...actual,
    browserTimeZone: mockBrowserTimeZone,
    useSession: mockUseSession,
    fetchWithAuth: mockFetchWithAuth,
  };
});

const mockNavigateTo = vi.mocked((await import('../../app/routes')).navigateTo);
const signOutEverywhere = vi.hoisted(() => vi.fn(async (): Promise<boolean> => true));

// jsdom has no modal <dialog>; the Astryx alert dialog calls showModal() on open.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};

type User = ReturnType<typeof userEvent.setup>;

const RENAMED_ZONE_LABELS: Readonly<Record<string, string>> = {
  'Asia/Calcutta': 'Asia/Kolkata (Asia/Calcutta)',
  'Europe/Kiev': 'Europe/Kyiv (Europe/Kiev)',
};

function browserTimeZoneLabel(): string {
  const zone = browserTimeZone();
  return (RENAMED_ZONE_LABELS[zone] ?? zone).replaceAll('_', ' ');
}

// Rows stay collapsed until Edit: Display name's Edit comes first, Time zone's second.
async function edit(user: User, row: 'name' | 'zone'): Promise<void> {
  const buttons = await screen.findAllByRole('button', { name: 'Edit' });
  await user.click(buttons[row === 'name' ? 0 : 1]);
}

async function editZone(user: User): Promise<HTMLElement> {
  await edit(user, 'zone');
  const zone = await screen.findByRole('combobox', { name: 'Your time zone' });
  // The current zone shows as a token; clicking enters edit mode, which refills
  // the input with its label on the next frame -- wait for that before typing.
  fireEvent.click(zone);
  await waitFor(() => expect((zone as HTMLInputElement).value).toBe(browserTimeZoneLabel()));
  return zone;
}

function mockSupabaseSetup(client: SupabaseClient): void {
  vi.spyOn(supabaseClient, 'getSupabaseSetup').mockResolvedValue({
    status: 'ready',
    client,
    devSignIn: false,
  });
}

function createMockSupabaseClient(overrides?: {
  updateUser?: () => PromiseLike<{ error: unknown }>;
  resetPasswordForEmail?: () => PromiseLike<{ error: unknown }>;
  refreshSession?: () => PromiseLike<{ error: unknown }>;
}): SupabaseClient {
  return {
    auth: {
      updateUser: overrides?.updateUser ?? vi.fn().mockResolvedValue({ error: null }),
      refreshSession: overrides?.refreshSession ?? vi.fn().mockResolvedValue({ error: null }),
      resetPasswordForEmail: overrides?.resetPasswordForEmail ?? vi.fn().mockResolvedValue({ error: null }),
    },
  } as unknown as SupabaseClient;
}

function signedInAs(name?: string): void {
  mockUseSession.mockReturnValue({
    status: 'signed-in',
    session: {
      user: {
        email: 'ada@example.com',
        user_metadata: name === undefined ? {} : { name },
      },
    },
    unavailable: null,
    signOut: vi.fn(),
    signOutEverywhere,
  });
}

function signedInWithFullNameOnly(fullName: string): void {
  mockUseSession.mockReturnValue({
    status: 'signed-in',
    session: {
      user: {
        email: 'ada@example.com',
        user_metadata: { full_name: fullName },
      },
    },
    unavailable: null,
    signOut: vi.fn(),
    signOutEverywhere,
  });
}

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signOutEverywhere.mockResolvedValue(true);
    mockBrowserTimeZone.mockReturnValue('UTC');
    signedInAs('Ada');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockBrowserTimeZone.mockReset();
  });

  it('shows the page heading, the email, and the display name, prefilled once Edit is pressed', async () => {
    mockSupabaseSetup(createMockSupabaseClient());
    const user = userEvent.setup();
    render(<AccountPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    expect(screen.getByText('Ada')).toBeTruthy();
    await edit(user, 'name');
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Ada');
  });

  it('is one scrolling page: every section is on it at once, in order, each with its #hash id', async () => {
    mockSupabaseSetup(createMockSupabaseClient());
    const { container } = render(<AccountPage />);
    await screen.findAllByRole('button', { name: 'Edit' });
    const ids = [...container.querySelectorAll('section[id], [id]')]
      .map((el) => el.id)
      .filter((id) => ['profile', 'appearance', 'notifications', 'accounts', 'usage', 'security', 'data', 'delete'].includes(id));
    expect(ids).toEqual(['profile', 'appearance', 'notifications', 'usage', 'security', 'data', 'delete']);
    for (const name of ['Profile', 'Appearance', 'Notifications', 'Usage', 'Sign-in and security', 'Your data', 'Delete account']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeTruthy();
    }
    // No second rail, and the other domains' sections are mounted in place.
    expect(screen.queryByRole('list')).toBeNull();
    for (const text of ['Notification settings section', 'Usage section', 'Delete all memories section']) {
      expect(screen.getByText(text)).toBeTruthy();
    }
  });

  it('offers System, Light and Dark only: no theme pickers', async () => {
    mockSupabaseSetup(createMockSupabaseClient());
    render(<AccountPage />);
    const group = await screen.findByRole('radiogroup', { name: 'Appearance' });
    expect(within(group).getAllByRole('radio').map((radio) => radio.getAttribute('aria-label') ?? radio.textContent)).toHaveLength(3);
    expect(screen.queryByRole('combobox', { name: /theme/i })).toBeNull();
    expect(screen.queryByText(/Light theme|Dark theme/)).toBeNull();
  });

  it('scrolls to the section named by the hash on load', async () => {
    window.history.replaceState(null, '', '/settings#usage');
    const scrollIntoView = vi.fn();
    Object.assign(HTMLElement.prototype, { scrollIntoView });
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((run) => {
      run(0);
      return 0;
    });
    mockSupabaseSetup(createMockSupabaseClient());
    render(<AccountPage />);
    await screen.findAllByRole('button', { name: 'Edit' });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect((scrollIntoView.mock.contexts[0] as HTMLElement).id).toBe('usage');
    raf.mockRestore();
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    window.history.replaceState(null, '', '/');
  });

  it('has no Google accounts section: they live on Integrations, linked from Your data', async () => {
    mockSupabaseSetup(createMockSupabaseClient());
    const user = userEvent.setup();
    const { container } = render(<AccountPage />);
    await screen.findAllByRole('button', { name: 'Edit' });
    expect(container.querySelector('#accounts')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Connected accounts' })).toBeNull();
    expect(settingsTarget('#accounts')).toBeNull();
    expect(settingsTarget('#data')).toBe('data');
    await user.click(screen.getByRole('link', { name: 'Open Integrations' }));
    expect(mockNavigateTo).toHaveBeenCalledWith('/integrations');
  });

  it('shows no Save button until Edit is pressed on Display name, and Cancel collapses it again', async () => {
    mockSupabaseSetup(createMockSupabaseClient());
    const user = userEvent.setup();
    render(<AccountPage />);
    await screen.findAllByRole('button', { name: 'Edit' });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByLabelText('Display name')).toBeNull();
    await edit(user, 'name');
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('asks for confirmation before signing out everywhere', async () => {
    mockSupabaseSetup(createMockSupabaseClient());
    const user = userEvent.setup();
    render(<AccountPage />);
    await user.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
    expect(signOutEverywhere).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog', { name: 'Sign out everywhere?' });
    await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(signOutEverywhere).toHaveBeenCalledTimes(1));
  });

  it('says so, with Try again, when signing out everywhere fails', async () => {
    signOutEverywhere.mockResolvedValue(false);
    mockSupabaseSetup(createMockSupabaseClient());
    const user = userEvent.setup();
    render(<AccountPage />);
    await user.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Sign out everywhere?' });
    await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    expect(await screen.findByText('Other devices may still be signed in. Try again.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(signOutEverywhere).toHaveBeenCalledTimes(2));
  });

  it('shows the delete-account email field only after Delete account is pressed', async () => {
    mockSupabaseSetup(createMockSupabaseClient());
    const user = userEvent.setup();
    render(<AccountPage />);
    const remove = await screen.findByRole('button', { name: 'Delete account' });
    expect(screen.queryByLabelText('Type your email to confirm')).toBeNull();
    await user.click(remove);
    expect(screen.getByLabelText('Type your email to confirm')).toBeTruthy();
  });

  it('prefills the input from full_name when name is absent', async () => {
    signedInWithFullNameOnly('Ada L');
    mockSupabaseSetup(createMockSupabaseClient());
    const user = userEvent.setup();
    render(<AccountPage />);
    await edit(user, 'name');
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Ada L');
  });

  it('saves the trimmed name to both keys and confirms with a toast, not a banner', async () => {
    const updateUser = vi.fn().mockResolvedValue({ error: null });
    mockSupabaseSetup(createMockSupabaseClient({ updateUser }));
    const user = userEvent.setup();
    render(<AccountPage />);
    await edit(user, 'name');
    const input = screen.getByLabelText('Display name');
    await user.clear(input);
    await user.type(input, '  Ada Lovelace  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Name saved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(updateUser).toHaveBeenCalledWith({ data: { name: 'Ada Lovelace', full_name: 'Ada Lovelace' } });
  });

  it('shows a validation message and makes no call for an empty name', async () => {
    const updateUser = vi.fn().mockResolvedValue({ error: null });
    mockSupabaseSetup(createMockSupabaseClient({ updateUser }));
    const user = userEvent.setup();
    render(<AccountPage />);
    await edit(user, 'name');
    const input = screen.getByLabelText('Display name');
    await user.clear(input);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Display name must be 1 to 60 characters.')).toBeTruthy();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('shows a validation message and makes no call for a 61-character name', async () => {
    // Pre-existing data longer than the cap (from before it existed): the
    // draft is seeded from it unclamped, since the clamp only runs in onChange.
    signedInAs('a'.repeat(61));
    const updateUser = vi.fn().mockResolvedValue({ error: null });
    mockSupabaseSetup(createMockSupabaseClient({ updateUser }));
    const user = userEvent.setup();
    render(<AccountPage />);
    await edit(user, 'name');
    const input = screen.getByLabelText('Display name');
    // The Save button is disabled (draft equals the saved name), so Enter in
    // the field is what reaches the same save/validate path.
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Display name must be 1 to 60 characters.')).toBeTruthy();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('shows the neutral save error when updateUser resolves an error or rejects', async () => {
    const updateUser = vi.fn().mockResolvedValue({ error: new Error('nope') });
    mockSupabaseSetup(createMockSupabaseClient({ updateUser }));
    const user = userEvent.setup();
    render(<AccountPage />);
    await edit(user, 'name');
    const input = screen.getByLabelText('Display name');
    await user.type(input, ' Jr');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText("Your name couldn't be saved.")).toBeTruthy();

    updateUser.mockRejectedValue(new Error('network down'));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Your name couldn't be saved.")).toBeTruthy();
  });

  it('sends the reset email to the signed-in address and shows the notice', async () => {
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ error: null });
    mockSupabaseSetup(createMockSupabaseClient({ resetPasswordForEmail }));
    const user = userEvent.setup();
    render(<AccountPage />);
    await user.click(await screen.findByRole('button', { name: 'Email me a reset link' }));
    expect(resetPasswordForEmail).toHaveBeenCalledWith('ada@example.com', {
      redirectTo: `${window.location.origin}/reset`,
    });
    expect(await screen.findByText('Check your email for a reset link')).toBeTruthy();
  });

  it('shows the neutral reset error when resetPasswordForEmail fails', async () => {
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ error: new Error('nope') });
    mockSupabaseSetup(createMockSupabaseClient({ resetPasswordForEmail }));
    const user = userEvent.setup();
    render(<AccountPage />);
    await user.click(await screen.findByRole('button', { name: 'Email me a reset link' }));
    expect(await screen.findByText("The reset link couldn't be sent.")).toBeTruthy();
  });

  it('links to Devices from Your data, without the word Cardputer', async () => {
    mockSupabaseSetup(createMockSupabaseClient());
    const user = userEvent.setup();
    render(<AccountPage />);
    await user.click(await screen.findByRole('link', { name: 'Open Devices' }));
    expect(mockNavigateTo).toHaveBeenCalledWith('/devices');
    expect(screen.queryByText(/Cardputer/)).toBeNull();
  });

  it('hides the name input and reset button, and shows the note, without a client', async () => {
    vi.spyOn(supabaseClient, 'getSupabaseSetup').mockResolvedValue({
      status: 'unavailable',
      message: 'x',
      devSignIn: true,
    });
    render(<AccountPage />);
    expect(await screen.findByText("Your name and password can't be changed when you're signed in this way.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Email me a reset link' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Devices' })).toBeTruthy();
  });

  it('saves the chosen time zone to user_metadata and refreshes the session', async () => {
    const updateUser = vi.fn().mockResolvedValue({ error: null });
    const refreshSession = vi.fn().mockResolvedValue({ error: null });
    mockSupabaseSetup(createMockSupabaseClient({ updateUser, refreshSession }));
    const user = userEvent.setup();
    render(<AccountPage />);
    const zone = await editZone(user);
    fireEvent.change(zone, { target: { value: 'Tokyo' } });
    // The dropdown is a popover jsdom reports as hidden (Astryx's own tests query it the same way).
    await screen.findByRole('option', { name: /Asia\/Tokyo/, hidden: true });
    fireEvent.keyDown(zone, { key: 'Enter' });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Time zone saved')).toBeTruthy();
    expect(updateUser).toHaveBeenCalledWith({ data: { time_zone: 'Asia/Tokyo' } });
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it('shows the saved time zone, with nothing to save until it changes', async () => {
    mockUseSession.mockReturnValue({
      status: 'signed-in',
      session: { user: { email: 'ada@example.com', user_metadata: { name: 'Ada', time_zone: 'America/Los_Angeles' } } },
      unavailable: null,
      signOut: vi.fn(),
      signOutEverywhere,
    });
    mockSupabaseSetup(createMockSupabaseClient());
    const user = userEvent.setup();
    render(<AccountPage />);
    expect(await screen.findByText('America/Los Angeles')).toBeTruthy();
    await edit(user, 'zone');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Export my data downloads the server file under its own name', async () => {
    mockSupabaseSetup(createMockSupabaseClient());
    mockFetchWithAuth.mockResolvedValue(new Response('{"format":"bob.account-export"}', {
      status: 200,
      headers: { 'content-disposition': 'attachment; filename="bob-export-2026-09-26.json"' },
    }));
    const createObjectURL = vi.fn(() => 'blob:export');
    // jsdom has no object URLs; give the two statics the download path needs.
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    const user = userEvent.setup();
    render(<AccountPage />);
    await user.click(await screen.findByRole('button', { name: 'Export my data' }));
    expect(await screen.findByText('Your data was downloaded')).toBeTruthy();
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/account/export');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(downloads).toEqual(['bob-export-2026-09-26.json']);
  });

  it('Export my data explains the rate limit, and a failure, without downloading', async () => {
    mockSupabaseSetup(createMockSupabaseClient());
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mockFetchWithAuth.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    const user = userEvent.setup();
    render(<AccountPage />);
    const button = await screen.findByRole('button', { name: 'Export my data' });
    await user.click(button);
    expect(await screen.findByText('You just exported your data. Try again in a minute.')).toBeTruthy();

    mockFetchWithAuth.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await user.click(button);
    expect(await screen.findByText("Your data couldn't be exported.")).toBeTruthy();

    mockFetchWithAuth.mockRejectedValueOnce(new Error('network down'));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText("Your data couldn't be exported.")).toBeTruthy();
    expect(click).not.toHaveBeenCalled();
  });

  it('names the download after the brand when the server gives no file name', async () => {
    mockSupabaseSetup(createMockSupabaseClient());
    mockFetchWithAuth.mockResolvedValue(new Response('{}', { status: 200 }));
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:export'), revokeObjectURL: vi.fn() });
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    const user = userEvent.setup();
    render(<AccountPage />);
    await user.click(await screen.findByRole('button', { name: 'Export my data' }));
    await screen.findByText('Your data was downloaded');
    expect(downloads).toEqual(['bob-export.json']);
  });

  it('labels a browser zone that is a renamed alias with its canonical name and the alias', async () => {
    mockBrowserTimeZone.mockReturnValue('Asia/Calcutta');
    mockSupabaseSetup(createMockSupabaseClient());
    const user = userEvent.setup();
    render(<AccountPage />);
    await edit(user, 'zone');
    const zone = await screen.findByRole('combobox', { name: 'Your time zone' });
    fireEvent.click(zone);
    await waitFor(() => expect((zone as HTMLInputElement).value).toBe('Asia/Kolkata (Asia/Calcutta)'));
  });

  it.each([
    ['Kolkata', 'Asia/Kolkata (Asia/Calcutta)'],
    ['Calcutta', 'Asia/Kolkata (Asia/Calcutta)'],
    ['Kyiv', 'Europe/Kyiv (Europe/Kiev)'],
  ])('typing "%s" finds %s', async (query, label) => {
    mockSupabaseSetup(createMockSupabaseClient());
    const user = userEvent.setup();
    render(<AccountPage />);
    const zone = await editZone(user);
    fireEvent.change(zone, { target: { value: query } });
    expect(await screen.findByRole('option', { name: label, hidden: true })).toBeTruthy();
  });

  describe('on a phone', () => {
    beforeEach(() => {
      phone.isMobile = true;
    });
    afterEach(() => {
      phone.isMobile = false;
    });

    it('keeps the page h1 in the DOM but visually hidden, with the email as the one line under it', async () => {
      mockSupabaseSetup(createMockSupabaseClient());
      render(<AccountPage />);
      const heading = await screen.findByRole('heading', { level: 1, name: 'Settings' });
      expect(heading.closest('[data-testid="visually-hidden"]')).not.toBeNull();
      expect(screen.getByText('ada@example.com')).toBeTruthy();
    });

    it('groups the rows of a settings section in one labelled list card', async () => {
      mockSupabaseSetup(createMockSupabaseClient());
      render(<AccountPage />);
      const list = await screen.findByRole('list', { name: 'Appearance' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(1);
      expect(within(list).getByText('Theme')).toBeTruthy();
    });

    it('names the grouped card after its section heading, at outline level 2', async () => {
      mockSupabaseSetup(createMockSupabaseClient());
      render(<AccountPage />);
      const card = await screen.findByRole('list', { name: 'Profile' });
      expect(within(card).getByText('Display name')).toBeTruthy();
      expect(screen.getByRole('heading', { level: 2, name: 'Profile' })).toBeTruthy();
    });

    it('gives each settings section its own card, with its rows inside it and none shared', async () => {
      mockSupabaseSetup(createMockSupabaseClient());
      render(<AccountPage />);
      const profile = await screen.findByRole('list', { name: 'Profile' });
      const appearance = screen.getByRole('list', { name: 'Appearance' });
      const security = screen.getByRole('list', { name: 'Sign-in and security' });
      expect(new Set([profile, appearance, security]).size).toBe(3);
      expect(within(profile).getByText('Time zone')).toBeTruthy();
      expect(within(profile).queryByText('Theme')).toBeNull();
      expect(within(appearance).getByText('Theme')).toBeTruthy();
      expect(within(security).getByText('Password')).toBeTruthy();
      expect(within(security).queryByText('Theme')).toBeNull();
    });
  });

  it('keeps the section headings at level 2 on desktop', async () => {
    mockSupabaseSetup(createMockSupabaseClient());
    render(<AccountPage />);
    const heading = await screen.findByRole('heading', { level: 2, name: 'Profile' });
    expect(heading.tagName).toBe('H2');
  });

  it('keeps the page h1 visible on desktop', async () => {
    mockSupabaseSetup(createMockSupabaseClient());
    render(<AccountPage />);
    const heading = await screen.findByRole('heading', { level: 1, name: 'Settings' });
    expect(heading.closest('[data-testid="visually-hidden"]')).toBeNull();
  });
});
