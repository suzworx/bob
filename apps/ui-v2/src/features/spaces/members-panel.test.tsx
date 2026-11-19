import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import type { Space, SpaceMember } from '@/features/spaces/use-spaces';
import { InviteForm, MembersPanel, type IssuedInvite } from './members-panel';
import { SPACE_GUTTER } from './space-header';

// Records every Section's props so a test can read the tab root's padding:
// jsdom computes no layout, and padding={0} makes a nested Section escape the
// page gutter and start 24px left of the space name.
const sectionProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@astryxdesign/core/Section', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@astryxdesign/core/Section')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    Section: (props: Parameters<typeof actual.Section>[0]) => {
      sectionProps.push(props as Record<string, unknown>);
      return createElement(actual.Section, props);
    },
  };
});

function rootSectionPadding(label: string): unknown {
  return sectionProps.filter((props) => props['aria-label'] === label).at(-1)?.padding;
}

// The panel reads the caller's own id from the session; fetchWithAuth is the
// plain global fetch so the tests stub the network in one place.
vi.mock('@/lib/auth/use-session', () => ({
  useSession: () => ({ session: { user: { id: 'u-self' } } }),
  fetchWithAuth: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

const EXPIRES = Date.UTC(2027, 0, 15, 12);

const MEMBERS = [
  { user_id: 'u-owner', role: 'owner', joined_at: 1, display_name: 'Olive' },
  { user_id: 'u-self', role: 'member', joined_at: 2, email: 'me@example.com' },
  { user_id: 'u-admin-0123456789', role: 'admin', joined_at: 3 },
];

// The name lookup (memberDisplayName) reads space.members, not the fetched
// MemberSummary list above: u-owner has a display_name, u-self has only a
// handle, and u-admin-0123456789 has neither, so it renders as "Someone".
const SPACE_MEMBERS: SpaceMember[] = [
  { user_id: 'u-owner', role: 'owner', joined_at: 1, display_name: 'Olive', handle: 'olive', email: null },
  { user_id: 'u-self', role: 'member', joined_at: 2, display_name: null, handle: 'self', email: 'me@example.com' },
  { user_id: 'u-admin-0123456789', role: 'admin', joined_at: 3, display_name: null, handle: '', email: null },
];

const INVITATION = {
  id: 'inv1',
  space_id: 's1',
  invited_email: 'pending@example.com',
  role: 'member',
  expires_at: EXPIRES,
  created_at: 1,
};

const OWNED = [
  { user_id: 'u-self', role: 'owner', joined_at: 1, display_name: 'Sam' },
  { user_id: 'u-riley', role: 'member', joined_at: 2, display_name: 'Riley' },
];

const OWNED_SPACE_MEMBERS: SpaceMember[] = [
  { user_id: 'u-self', role: 'owner', joined_at: 1, display_name: 'Sam', handle: 'sam', email: null },
  { user_id: 'u-riley', role: 'member', joined_at: 2, display_name: 'Riley', handle: 'riley', email: null },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Routes are keyed "METHOD /path"; an unrouted call fails loudly.
function stubFetch(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const route = routes[key];
    if (!route) throw new Error(`unrouted request: ${key}`);
    return route(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPanel(
  role: string,
  kind: Space['kind'] = 'group',
  onSpaceChanged?: () => void,
  members: SpaceMember[] = SPACE_MEMBERS,
  archivedAt: number | null = null,
  onLeave: (() => void) | undefined = () => undefined,
): void {
  const space: Space = {
    id: 's1',
    kind,
    name: 'Home',
    role,
    membership_revision: 1,
    created_at: 0,
    updated_at: 0,
    archived_at: archivedAt,
    members,
  };
  render(
    <Theme theme={neutralTheme} mode="system">
      <MembersPanel space={space} onSpaceChanged={onSpaceChanged} onLeave={onLeave} />
    </Theme>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// jsdom has no modal <dialog>; the Astryx alert dialog calls showModal() on open.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};

type User = ReturnType<typeof userEvent.setup>;

/** The labels in a member row's one MoreMenu (built only once it is open). */
async function memberActions(user: User, name: string): Promise<string[]> {
  await user.click(await screen.findByRole('button', { name: `Member actions for ${name}` }));
  const labels = screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');
  await user.keyboard('{Escape}');
  return labels;
}

async function chooseMemberAction(user: User, name: string, action: string): Promise<void> {
  await user.click(await screen.findByRole('button', { name: `Member actions for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
}

describe('MembersPanel', () => {
  it('re-applies the space gutter on its root Section, so its content starts where the space name starts', async () => {
    stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: MEMBERS }),
      'GET /api/spaces/s1/invitations': () => json({ invitations: [] }),
    });
    renderPanel('owner');
    await screen.findByRole('list', { name: 'Members' });
    expect(rootSectionPadding('Members')).toBe(SPACE_GUTTER);
  });

  it('lists members with an avatar, a name (never a raw id) and a role token each', async () => {
    stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: MEMBERS }),
      'GET /api/spaces/s1/invitations': () => json({ invitations: [] }),
    });
    renderPanel('owner');

    const list = await screen.findByRole('list', { name: 'Members' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getAllByText('Olive').length).toBeGreaterThan(0);
    expect(within(list).getByText('@self (you)')).toBeTruthy();
    expect(within(list).getAllByText('Someone').length).toBeGreaterThan(0);
    expect(list.textContent).not.toContain('u-owner');
    expect(list.textContent).not.toContain('u-admin-0123456789');
    expect(within(list).getByText('Owner')).toBeTruthy();
    expect(within(list).getByText('Member')).toBeTruthy();
    expect(within(list).getByText('Admin')).toBeTruthy();
    // Every row's actions sit in one menu: no inline action buttons.
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('mounts a row menu only when it is opened', async () => {
    stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: OWNED }),
      'GET /api/spaces/s1/invitations': () => json({ invitations: [] }),
    });
    renderPanel('owner', 'group', undefined, OWNED_SPACE_MEMBERS);
    await screen.findByRole('button', { name: 'Member actions for Riley' });
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    const user = userEvent.setup();
    expect(await memberActions(user, 'Riley')).toEqual(['Make admin', 'Make owner', 'Remove']);
  });

  it('shows a plain member no invite control and no Remove, but Leave space on their own row', async () => {
    stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: MEMBERS }),
      'GET /api/spaces/s1/invitations': () => json({ error: 'forbidden' }, 403),
    });
    renderPanel('member');
    const user = userEvent.setup();

    await screen.findByRole('list', { name: 'Members' });
    expect(screen.queryByRole('button', { name: 'Invite people' })).toBeNull();
    expect(screen.queryByText('Pending invitations')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Member actions for Olive' })).toBeNull();
    expect(await memberActions(user, '@self')).toEqual(['Leave space']);
  });

  it('puts Invite people above the members, and invites with the one-time link', async () => {
    const fetchMock = stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: MEMBERS }),
      'GET /api/spaces/s1/invitations': () => json({ invitations: [] }),
      'POST /api/spaces/s1/invitations': () => json({ invitation: INVITATION, token: 'tok123' }, 201),
    });
    renderPanel('owner');
    const user = userEvent.setup();

    const inviteButton = await screen.findByRole('button', { name: 'Invite people' });
    const list = screen.getByRole('list', { name: 'Members' });
    expect(inviteButton.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(inviteButton);
    await user.type(screen.getByRole('textbox', { name: 'Invite email' }), ' new@example.com ');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    expect(await screen.findByText(`${window.location.origin}/invite/tok123`)).toBeTruthy();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ email: 'new@example.com', role: 'member' });
    expect(screen.getByRole('list', { name: 'Pending invitations' })).toBeTruthy();
  });

  it('sends one invitation for two rapid Enter presses while the invite is in flight', async () => {
    let release: (response: Response) => void = () => undefined;
    const fetchMock = stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: MEMBERS }),
      'GET /api/spaces/s1/invitations': () => json({ invitations: [] }),
      'POST /api/spaces/s1/invitations': () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    renderPanel('owner');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Invite people' }));
    await user.type(screen.getByRole('textbox', { name: 'Invite email' }), 'new@example.com');
    await user.keyboard('{Enter}{Enter}');
    const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts()).toHaveLength(1);
    release(json({ invitation: INVITATION, token: 'tok123' }, 201));
    expect(await screen.findByText(`${window.location.origin}/invite/tok123`)).toBeTruthy();
    expect(posts()).toHaveLength(1);
  });

  it('opens the invite form at once when asked to (the header menu)', async () => {
    stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: MEMBERS }),
      'GET /api/spaces/s1/invitations': () => json({ invitations: [] }),
    });
    const space: Space = { id: 's1', kind: 'group', name: 'Home', role: 'owner', membership_revision: 1, created_at: 0, updated_at: 0, members: SPACE_MEMBERS };
    render(
      <Theme theme={neutralTheme} mode="system">
        <MembersPanel space={space} inviteOpen />
      </Theme>,
    );
    expect(await screen.findByRole('textbox', { name: 'Invite email' })).toBeTruthy();
  });

  // P1: revoke is reversible here: an Undo toast, and the DELETE only once it closes.
  it('revokes an invitation with an Undo toast; Undo keeps it and sends nothing', async () => {
    const fetchMock = stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: MEMBERS }),
      'GET /api/spaces/s1/invitations': () => json({ invitations: [INVITATION] }),
      'DELETE /api/invitations/inv1': () => new Response(null, { status: 204 }),
    });
    renderPanel('owner');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Invitation actions for pending@example.com' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Revoke invitation' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Pending invitations' })).toBeNull());
    expect((await screen.findAllByText('Invitation for pending@example.com revoked')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Undo', hidden: true }));
    expect(await screen.findByRole('list', { name: 'Pending invitations' })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('sends the revoke once the Undo toast closes without Undo', async () => {
    const fetchMock = stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: MEMBERS }),
      'GET /api/spaces/s1/invitations': () => json({ invitations: [INVITATION] }),
      'DELETE /api/invitations/inv1': () => new Response(null, { status: 204 }),
    });
    renderPanel('owner');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Invitation actions for pending@example.com' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Revoke invitation' }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    await waitFor(
      () => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url)).toEqual(['/api/invitations/inv1']),
      { timeout: 9000 },
    );
  }, 15000);

  // P0: removing someone is irreversible, so it is confirmed by name first.
  it('asks before removing a member, naming them and the space, and only then sends DELETE', async () => {
    const fetchMock = stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: OWNED }),
      'GET /api/spaces/s1/invitations': () => json({ invitations: [] }),
      'DELETE /api/spaces/s1/members/u-riley': () => json({}),
    });
    renderPanel('owner', 'group', undefined, OWNED_SPACE_MEMBERS);
    const user = userEvent.setup();
    const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');

    await chooseMemberAction(user, 'Riley', 'Remove');
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Riley from Home?' });
    expect(deletes()).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(deletes()).toHaveLength(0);

    await chooseMemberAction(user, 'Riley', 'Remove');
    const again = await screen.findByRole('alertdialog', { name: 'Remove Riley from Home?' });
    await user.click(within(again).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(deletes()[0]?.[0]).toBe('/api/spaces/s1/members/u-riley');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Member actions for Riley' })).toBeNull());
  });

  it('shows the members error state when the list cannot load', async () => {
    stubFetch({ 'GET /api/spaces/s1/members': () => json({ error: 'boom' }, 500) });
    renderPanel('owner');
    expect(await screen.findByText('Members could not be loaded.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Members' })).toBeNull();
  });
});

describe('MembersPanel refresh on focus', () => {
  const NEWCOMER = { user_id: 'u-new', role: 'member', joined_at: 4, display_name: 'Newcomer' };
  const NEWCOMER_SPACE_MEMBER: SpaceMember = {
    user_id: 'u-new',
    role: 'member',
    joined_at: 4,
    display_name: 'Newcomer',
    handle: 'newcomer',
    email: null,
  };
  const SPACE_MEMBERS_WITH_NEWCOMER = [...SPACE_MEMBERS, NEWCOMER_SPACE_MEMBER];

  function returnToTab(): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('refetches the members when the tab becomes visible again', async () => {
    let membersCalls = 0;
    stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: ++membersCalls === 1 ? MEMBERS : [...MEMBERS, NEWCOMER] }),
      'GET /api/spaces/s1/invitations': () => json({ invitations: [] }),
    });
    renderPanel('owner', 'group', undefined, SPACE_MEMBERS_WITH_NEWCOMER);

    await screen.findByRole('list', { name: 'Members' });
    expect(screen.queryAllByText('Newcomer')).toHaveLength(0);
    returnToTab();

    expect((await screen.findAllByText('Newcomer')).length).toBeGreaterThan(0);
    expect(membersCalls).toBe(2);
  });

  it('keeps the list, the one-time invite link and a typed email on screen while it refetches', async () => {
    let membersCalls = 0;
    let invitationCalls = 0;
    let releaseMembers: () => void = () => undefined;
    stubFetch({
      'GET /api/spaces/s1/members': () => {
        membersCalls += 1;
        if (membersCalls === 1) return json({ members: MEMBERS });
        return new Promise<Response>((resolve) => {
          releaseMembers = () => resolve(json({ members: [...MEMBERS, NEWCOMER] }));
        });
      },
      'GET /api/spaces/s1/invitations': () => {
        invitationCalls += 1;
        return json({ invitations: [] });
      },
      'POST /api/spaces/s1/invitations': () => json({ invitation: INVITATION, token: 'tok123' }, 201),
    });
    renderPanel('owner', 'group', undefined, SPACE_MEMBERS_WITH_NEWCOMER);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Invite people' }));
    await user.type(screen.getByRole('textbox', { name: 'Invite email' }), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    const link = `${window.location.origin}/invite/tok123`;
    expect(await screen.findByText(link)).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'Invite email' }), 'draft@example.com');

    returnToTab();
    await waitFor(() => expect(membersCalls).toBe(2));
    // The refetch is still in flight: nothing was swapped for a loading message.
    expect(screen.queryByText('Loading members…')).toBeNull();
    expect(screen.getByRole('list', { name: 'Members' })).toBeTruthy();
    expect(screen.getByText(link)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Invite email' }) as HTMLInputElement).value).toBe('draft@example.com');

    releaseMembers();
    expect((await screen.findAllByText('Newcomer')).length).toBeGreaterThan(0);
    await waitFor(() => expect(invitationCalls).toBe(2));
    expect(screen.getByText(link)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Invite email' }) as HTMLInputElement).value).toBe('draft@example.com');
  });
});

describe('MembersPanel ownership transfer', () => {
  it('lets the owner make Riley the owner after confirming, and calls onSpaceChanged once', async () => {
    const onSpaceChanged = vi.fn();
    const fetchMock = stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: OWNED }),
      'GET /api/spaces/s1/invitations': () => json({ invitations: [] }),
      'PUT /api/spaces/s1/owner': () => json({}),
    });
    renderPanel('owner', 'group', onSpaceChanged, OWNED_SPACE_MEMBERS);
    const user = userEvent.setup();

    await chooseMemberAction(user, 'Riley', 'Make owner');
    const dialog = await screen.findByRole('alertdialog', { name: 'Make Riley the owner?' });
    await user.click(within(dialog).getByRole('button', { name: 'Make owner' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ user_id: 'u-riley' });
    expect(onSpaceChanged).toHaveBeenCalledTimes(1);
  });

  it('offers Make owner only to the owner of a group, never on their own row', async () => {
    const user = userEvent.setup();
    stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: OWNED }),
      'GET /api/spaces/s1/invitations': () => json({ invitations: [] }),
    });
    renderPanel('admin', 'group', undefined, OWNED_SPACE_MEMBERS);
    expect(await memberActions(user, 'Riley')).not.toContain('Make owner');
    cleanup();

    stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: OWNED }),
      'GET /api/spaces/s1/invitations': () => json({ invitations: [] }),
    });
    renderPanel('owner', 'pair', undefined, OWNED_SPACE_MEMBERS);
    expect(await memberActions(user, 'Riley')).not.toContain('Make owner');
    cleanup();

    stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: OWNED }),
      'GET /api/spaces/s1/invitations': () => json({ invitations: [] }),
    });
    renderPanel('owner', 'group', undefined, OWNED_SPACE_MEMBERS);
    await screen.findByRole('list', { name: 'Members' });
    // The owner's own row has nothing to do: they cannot leave or demote themselves.
    expect(screen.queryByRole('button', { name: 'Member actions for Sam (you)' })).toBeNull();
  });

  it('shows the transfer error banner when the PUT fails', async () => {
    stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: OWNED }),
      'GET /api/spaces/s1/invitations': () => json({ invitations: [] }),
      'PUT /api/spaces/s1/owner': () => json({}, 500),
    });
    renderPanel('owner', 'group', undefined, OWNED_SPACE_MEMBERS);
    const user = userEvent.setup();

    await chooseMemberAction(user, 'Riley', 'Make owner');
    const dialog = await screen.findByRole('alertdialog', { name: 'Make Riley the owner?' });
    await user.click(within(dialog).getByRole('button', { name: 'Make owner' }));
    expect(await screen.findByText('Ownership could not be transferred.')).toBeTruthy();
  });
});

const ROLE_MEMBERS = [
  ...OWNED,
  { user_id: 'u-ava', role: 'admin', joined_at: 3, display_name: 'Ava' },
];

const ROLE_SPACE_MEMBERS: SpaceMember[] = [
  ...OWNED_SPACE_MEMBERS,
  { user_id: 'u-ava', role: 'admin', joined_at: 3, display_name: 'Ava', handle: 'ava', email: null },
];

// The members fixture is stateful: a successful PATCH changes the role the next
// GET returns, as the server would, so the refetch shows the new role.
function stubRoleRoutes(
  patch: () => Response | Promise<Response> | null = () => null,
): ReturnType<typeof vi.fn> {
  const current = ROLE_MEMBERS.map((member) => ({ ...member }));
  const apply = (userId: string) => async (init?: RequestInit): Promise<Response> => {
    const refused = await patch();
    if (refused !== null) return refused;
    const target = current.find((member) => member.user_id === userId);
    if (target) target.role = (JSON.parse(String(init?.body)) as { role: string }).role;
    return new Response(null, { status: 204 });
  };
  return stubFetch({
    'GET /api/spaces/s1/members': () => json({ members: current }),
    'GET /api/spaces/s1/invitations': () => json({ invitations: [] }),
    'PATCH /api/spaces/s1/members/u-riley': apply('u-riley'),
    'PATCH /api/spaces/s1/members/u-ava': apply('u-ava'),
  });
}

describe('MembersPanel member roles', () => {
  it('promotes and demotes through the row menu, refetching, and calls onSpaceChanged', async () => {
    const onSpaceChanged = vi.fn();
    const fetchMock = stubRoleRoutes();
    renderPanel('owner', 'group', onSpaceChanged, ROLE_SPACE_MEMBERS);
    const user = userEvent.setup();
    const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');

    await chooseMemberAction(user, 'Riley', 'Make admin');
    await waitFor(() => expect(onSpaceChanged).toHaveBeenCalledTimes(1));
    expect(patches()[0]?.[0]).toBe('/api/spaces/s1/members/u-riley');
    expect(JSON.parse(String(patches()[0]?.[1]?.body))).toEqual({ role: 'admin' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Member actions for Riley' }).getAttribute('aria-disabled') === 'true').toBe(false),
    );
    const rileyRow = screen.getByRole('button', { name: 'Member actions for Riley' }).closest('li') as HTMLElement;
    await waitFor(() => expect(within(rileyRow).getByText('Admin')).toBeTruthy());
    await chooseMemberAction(user, 'Riley', 'Make member');
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(JSON.parse(String(patches()[1]?.[1]?.body))).toEqual({ role: 'member' });
  });

  it('offers no role changes in an archived space, to an admin, or in a pair space', async () => {
    const user = userEvent.setup();
    for (const [role, kind, archivedAt] of [['owner', 'group', 1700000000000], ['admin', 'group', null], ['owner', 'pair', null]] as const) {
      stubRoleRoutes();
      renderPanel(role, kind, undefined, ROLE_SPACE_MEMBERS, archivedAt);
      const labels = await memberActions(user, 'Riley');
      expect(labels.filter((label) => /^Make (admin|member)$/.test(label))).toEqual([]);
      cleanup();
    }
  });

  it('shows a recoverable error when the change fails', async () => {
    stubRoleRoutes(() => json({}, 500));
    renderPanel('owner', 'group', undefined, ROLE_SPACE_MEMBERS);
    const user = userEvent.setup();
    await chooseMemberAction(user, 'Riley', 'Make admin');
    expect(await screen.findByText('That role could not be changed.')).toBeTruthy();
  });

  it('disables member action menus while a role request is pending', async () => {
    let release: (() => void) | undefined;
    const fetchMock = stubRoleRoutes(() => new Promise<Response>((resolve) => {
      release = () => resolve(new Response(null, { status: 204 }));
    }));
    renderPanel('owner', 'group', undefined, ROLE_SPACE_MEMBERS);
    const user = userEvent.setup();
    await chooseMemberAction(user, 'Riley', 'Make admin');
    for (const name of ['Riley', 'Ava']) {
      expect(screen.getByRole('button', { name: `Member actions for ${name}` }).getAttribute('aria-disabled') === 'true').toBe(true);
    }
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    await act(async () => { release?.(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Member actions for Ava' }).getAttribute('aria-disabled') === 'true').toBe(false));
  });
});

describe('MembersPanel leaving', () => {
  // P0: Leave goes through the page's confirm dialog, never straight to DELETE.
  it('hands your own row\'s Leave space to onLeave and sends nothing itself', async () => {
    const onLeave = vi.fn();
    const fetchMock = stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: MEMBERS }),
      'GET /api/spaces/s1/invitations': () => json({ error: 'forbidden' }, 403),
    });
    renderPanel('member', 'group', undefined, SPACE_MEMBERS, null, onLeave);
    const user = userEvent.setup();

    await chooseMemberAction(user, '@self', 'Leave space');
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('offers no Leave space in a private space', async () => {
    stubFetch({
      'GET /api/spaces/s1/members': () => json({ members: [{ ...OWNED[0], role: 'member' }] }),
      'GET /api/spaces/s1/invitations': () => json({ invitations: [] }),
    });
    renderPanel('member', 'private', undefined, [{ ...OWNED_SPACE_MEMBERS[0], role: 'member' }]);
    await screen.findByRole('list', { name: 'Members' });
    expect(screen.queryByRole('button', { name: /^Member actions/ })).toBeNull();
  });
});

describe('InviteForm', () => {
  async function inviteWith(result: string | IssuedInvite): Promise<void> {
    render(
      <Theme theme={neutralTheme} mode="system">
        <InviteForm onInvite={async () => result} onCancel={() => undefined} />
      </Theme>,
    );
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Invite email' }), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
  }

  it('says the invitation was emailed, and still offers the link to share', async () => {
    await inviteWith({ token: 'tok123', emailSent: true });

    expect(await screen.findByText('Invitation emailed to new@example.com.')).toBeTruthy();
    expect(screen.getByText(/Or share this link/)).toBeTruthy();
    expect(screen.getByText(`${window.location.origin}/invite/tok123`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(screen.queryByText(/shown once, save it now/)).toBeNull();
  });

  it('shows only the one-time link when the invitation was not emailed', async () => {
    await inviteWith({ token: 'tok123', emailSent: false });

    expect(await screen.findByText(/Invite link for new@example.com — shown once, save it now/)).toBeTruthy();
    expect(screen.getByText(`${window.location.origin}/invite/tok123`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(screen.queryByText(/Invitation emailed/)).toBeNull();
    expect(screen.queryByText(/Or share this link/)).toBeNull();
  });
});
