import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotesPanel } from './notes-panel';
import { resetDrafts } from '../chat/drafts';
import type { NoteRevision, NoteSummary } from '@/features/productivity/use-notes';
import { SpacesProvider, type Space } from '@/features/spaces/use-spaces';
import { SPACE_GUTTER } from '../spaces/space-header';

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

// The panel reads the caller's id from the session; fetchWithAuth is the
// plain global fetch so the tests stub the network in one place.
vi.mock('@/lib/auth/use-session', () => ({
  useSession: () => ({ session: { user: { id: 'u-self' } } }),
  fetchWithAuth: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

type Member = Space['members'][number];

const SAM: Member = {
  user_id: 'u-self',
  role: 'owner',
  joined_at: 1,
  display_name: 'Sam',
  handle: 'sam',
  email: null,
};
const RILEY: Member = {
  user_id: 'u-riley',
  role: 'member',
  joined_at: 2,
  display_name: 'Riley',
  handle: 'riley',
  email: null,
};

const SPACE: Space = {
  id: 'spc_1',
  kind: 'group',
  name: 'Test Family',
  role: 'owner',
  membership_revision: 1,
  members: [SAM, RILEY],
  created_at: 1756100000000,
  updated_at: 1756100000000,
};

function note(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: 'n1',
    space_id: 'spc_1',
    title: 'Groceries',
    body: 'Milk',
    pinned: false,
    revision: 1,
    created_by: 'u-self',
    updated_by: 'u-self',
    ai_assisted: false,
    trashed_at: null,
    created_at: 1756100000000,
    updated_at: 1756100000000,
    ...overrides,
  };
}

function revision(overrides: Partial<NoteRevision> = {}): NoteRevision {
  return {
    id: 'r1',
    note_id: 'n1',
    revision: 1,
    title: 'Groceries',
    body: 'Milk',
    editor_user_id: 'u-self',
    ai_assisted: false,
    created_at: 1756100000000,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Handler = (init?: RequestInit) => Response | Promise<Response>;

// Routes are keyed "METHOD /path" (no query string). Everything the panel
// mounts has a default, so a test overrides only what it exercises; an
// unrouted call fails loudly.
function stubFetch(overrides: Record<string, Handler> = {}): ReturnType<typeof vi.fn> {
  const routes: Record<string, Handler> = {
    'GET /api/spaces/spc_1/notes': () => json({ notes: [] }),
    ...overrides,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`;
    const route = routes[key];
    if (!route) throw new Error(`unrouted request: ${key}`);
    return route(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, method: string, path: string): unknown[][] {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input).split('?')[0] === path && ((init as RequestInit | undefined)?.method ?? 'GET') === method,
  );
}

function patchBody(fetchMock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const [, init] = callsTo(fetchMock, 'PATCH', '/api/notes/n1')[index] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function isDisabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true';
}

beforeEach(() => {
  resetDrafts();
});

// jsdom has no modal <dialog>; the Astryx dialog calls showModal() on open.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};

type User = ReturnType<typeof userEvent.setup>;

// Every note and list action lives in a menu whose items exist only while open.
async function menuAction(user: User, menu: string, action: string | RegExp): Promise<void> {
  await user.click(await screen.findByRole('button', { name: menu }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
}

// Search shows up only once a space has more than five notes.
function manyNotes(extra: NoteSummary[] = []): NoteSummary[] {
  return [
    ...extra,
    ...Array.from({ length: 6 }, (_, index) => note({ id: `n_fill${index}`, title: `Filler ${index}`, body: '' })),
  ];
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

describe('NotesPanel list', () => {
  it('re-applies the space gutter on its root Section, so its content starts where the space name starts', async () => {
    stubFetch();
    render(<NotesPanel space={SPACE} />);
    await screen.findByRole('textbox', { name: 'New note title' });
    expect(screen.getByRole('region', { name: 'Notes' })).toBeTruthy();
    expect(rootSectionPadding('Notes')).toBe(SPACE_GUTTER);
  });

  it('has no panel heading, and names the Notes landmark for a screen reader', async () => {
    stubFetch();
    render(<NotesPanel space={SPACE} />);
    await screen.findByRole('textbox', { name: 'New note title' });
    expect(screen.queryByRole('heading', { name: 'Notes' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Notes' })).toBeTruthy();
  });

  it('shows a pinned note before a newer unpinned one, marked with one pin', async () => {
    const older = note({ id: 'n_pin', title: 'Pinned note', pinned: true, updated_at: 1000 });
    const newer = note({ id: 'n_new', title: 'New note', pinned: false, updated_at: 2000 });
    stubFetch({ 'GET /api/spaces/spc_1/notes': () => json({ notes: [newer, older] }) });
    render(<NotesPanel space={SPACE} />);
    const list = await screen.findByRole('list', { name: 'Note list' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0].textContent).toContain('Pinned note');
    expect(items[1].textContent).toContain('New note');
    expect(items.filter((item) => item.textContent?.includes('Pinned ·'))).toHaveLength(1);
  });

  it('makes the add row the empty state: no list, no search, no hint pointing elsewhere', async () => {
    stubFetch();
    render(<NotesPanel space={SPACE} />);
    expect(await screen.findByRole('textbox', { name: 'New note title' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading notes' })).toBeNull());
    expect(screen.queryByRole('list', { name: 'Note list' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Search notes' })).toBeNull();
  });

  it('shows search only once there are more than five notes', async () => {
    stubFetch({ 'GET /api/spaces/spc_1/notes': () => json({ notes: manyNotes().slice(0, 5) }) });
    const { unmount } = render(<NotesPanel space={SPACE} />);
    await screen.findByRole('list', { name: 'Note list' });
    expect(screen.queryByRole('textbox', { name: 'Search notes' })).toBeNull();
    unmount();
    stubFetch({ 'GET /api/spaces/spc_1/notes': () => json({ notes: manyNotes() }) });
    render(<NotesPanel space={SPACE} />);
    expect(await screen.findByRole('textbox', { name: 'Search notes' })).toBeTruthy();
  });

  it('gives each note row one menu: Pin, then Move to trash last', async () => {
    stubFetch({ 'GET /api/spaces/spc_1/notes': () => json({ notes: [note()] }) });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByRole('button', { name: 'Actions for Groceries' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Pin', 'Move to trash']);
  });

  it('shows a load error with Retry', async () => {
    let calls = 0;
    stubFetch({
      'GET /api/spaces/spc_1/notes': () => {
        calls += 1;
        return calls === 1 ? json({}, 500) : json({ notes: [note()] });
      },
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Notes could not be loaded.');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Groceries')).toBeTruthy();
  });
});

describe('NotesPanel deep link', () => {
  it('opens and scrolls to the focused note once loaded', async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    stubFetch({ 'GET /api/spaces/spc_1/notes': () => json({ notes: [note(), note({ id: 'n2', title: 'Chores', body: 'Vacuum' })] }) });
    render(<NotesPanel space={SPACE} focusNoteId="n2" />);
    const title = await screen.findByRole('textbox', { name: 'Note title' });
    expect((title as HTMLInputElement).value).toBe('Chores');
    expect(scrolled).toHaveBeenCalledTimes(1);
  });
});

describe('NotesPanel create', () => {
  it('adds a note by POST and opens it in the editor', async () => {
    const created = note({ id: 'n_new', title: 'Trip plan', body: '' });
    const fetchMock = stubFetch({ 'POST /api/spaces/spc_1/notes': () => json(created, 201) });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    const input = await screen.findByPlaceholderText('New note');
    await user.type(input, 'Trip plan');
    await user.keyboard('{Enter}');
    const [, init] = callsTo(fetchMock, 'POST', '/api/spaces/spc_1/notes')[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ title: 'Trip plan' });
    const titleField = await screen.findByRole('textbox', { name: 'Note title' });
    expect((titleField as HTMLInputElement).value).toBe('Trip plan');
  });

  it('sends one POST for two rapid Enter presses while the create is in flight', async () => {
    let release: (response: Response) => void = () => undefined;
    const fetchMock = stubFetch({
      'POST /api/spaces/spc_1/notes': () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    const input = await screen.findByRole('textbox', { name: 'New note title' });
    await user.type(input, 'Trip plan');
    await user.keyboard('{Enter}{Enter}');

    const posts = () => callsTo(fetchMock, 'POST', '/api/spaces/spc_1/notes');
    expect(posts()).toHaveLength(1);

    release(json(note({ id: 'n_new', title: 'Trip plan' }), 201));
    await screen.findByRole('textbox', { name: 'Note title' });
    expect(posts()).toHaveLength(1);
  });
});

describe('NotesPanel editor save', () => {
  it('saves an edit with the note revision and shows Saved, disabled until changed', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk', revision: 1 });
    const fetchMock = stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: [existing] }),
      'PATCH /api/notes/n1': () => json({ ...existing, body: 'Milk, eggs', revision: 2 }),
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    const bodyField = await screen.findByRole('textbox', { name: 'Note body' });
    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(isDisabled(saveButton)).toBe(true);
    await user.type(bodyField, ', eggs');
    expect(isDisabled(saveButton)).toBe(false);
    await user.click(saveButton);
    expect(patchBody(fetchMock)).toEqual({ revision: 1, title: 'Groceries', body: 'Milk, eggs' });
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('shows a save error and keeps the typed text when the PATCH fails', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk', revision: 1 });
    stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: [existing] }),
      'PATCH /api/notes/n1': () => json({}, 500),
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    const bodyField = await screen.findByRole('textbox', { name: 'Note body' });
    await user.type(bodyField, ', eggs');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The note could not be saved.')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Note body' }) as HTMLTextAreaElement).value).toBe('Milk, eggs');
  });
});

describe('NotesPanel conflict', () => {
  it('shows the conflict banner, keeps the user text, and retries with the new revision', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk', revision: 1 });
    const latest = note({ id: 'n1', title: 'Groceries (edited)', body: 'Bread', revision: 2 });
    let patchCount = 0;
    const fetchMock = stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: [existing] }),
      'GET /api/notes/n1': () => json(latest),
      'PATCH /api/notes/n1': () => {
        patchCount += 1;
        if (patchCount === 1) return json({ error: { code: 'conflict', current_revision: 2 } }, 409);
        return json({ ...latest, body: 'Milk, eggs', revision: 3 });
      },
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    const bodyField = await screen.findByRole('textbox', { name: 'Note body' });
    await user.type(bodyField, ', eggs');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Someone saved this note while you were editing');
    expect((screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value).toBe('Groceries');
    expect((screen.getByRole('textbox', { name: 'Note body' }) as HTMLTextAreaElement).value).toBe('Milk, eggs');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(patchBody(fetchMock, 1)).toEqual({ revision: 2, title: 'Groceries', body: 'Milk, eggs' });
  });
});

describe('NotesPanel pin', () => {
  it('pins and unpins a note', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk', pinned: false });
    const fetchMock = stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: [existing] }),
      'PUT /api/notes/n1/pin': () => json({ ...existing, pinned: true }),
      'DELETE /api/notes/n1/pin': () => json({ ...existing, pinned: false }),
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await menuAction(user, 'Actions for Groceries', 'Pin');
    expect(await screen.findByText(/^Pinned ·/)).toBeTruthy();
    expect(callsTo(fetchMock, 'PUT', '/api/notes/n1/pin')).toHaveLength(1);

    await user.click(await screen.findByText('Groceries'));
    await menuAction(user, 'Note actions', 'Unpin');
    await waitFor(() => expect(screen.queryByText(/^Pinned ·/)).toBeNull());
    expect(callsTo(fetchMock, 'DELETE', '/api/notes/n1/pin')).toHaveLength(1);
  });
});

describe('NotesPanel close', () => {
  it('hides the Note editor region after Close note', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk' });
    stubFetch({ 'GET /api/spaces/spc_1/notes': () => json({ notes: [existing] }) });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    expect(await screen.findByRole('region', { name: 'Note editor' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close note' }));
    expect(screen.queryByRole('region', { name: 'Note editor' })).toBeNull();
  });
});

describe('NotesPanel drafts', () => {
  it('restores unsaved text after closing and reopening, and saves it with the original revision', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk', revision: 1 });
    const fetchMock = stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: [existing] }),
      'PATCH /api/notes/n1': () => json({ ...existing, body: 'Milk, eggs', revision: 2 }),
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    const bodyField = await screen.findByRole('textbox', { name: 'Note body' });
    await user.type(bodyField, ', eggs');
    await user.click(screen.getByRole('button', { name: 'Close note' }));
    expect(screen.queryByRole('region', { name: 'Note editor' })).toBeNull();

    await user.click(screen.getByText('Groceries'));
    expect(await screen.findByText('Your unsaved changes were restored.')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Note body' }) as HTMLTextAreaElement).value).toBe('Milk, eggs');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(patchBody(fetchMock)).toEqual({ revision: 1, title: 'Groceries', body: 'Milk, eggs' });
  });

  it('keeps an unsaved draft across a full unmount and remount', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk', revision: 1 });
    stubFetch({ 'GET /api/spaces/spc_1/notes': () => json({ notes: [existing] }) });
    const user = userEvent.setup();
    const { unmount } = render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    const bodyField = await screen.findByRole('textbox', { name: 'Note body' });
    await user.type(bodyField, ', eggs');
    unmount();

    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    const reopened = await screen.findByRole('textbox', { name: 'Note body' });
    expect((reopened as HTMLTextAreaElement).value).toBe('Milk, eggs');
  });

  it('sends the draft revision on save and surfaces a conflict against a note that moved on', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk', revision: 1 });
    const moved = note({ id: 'n1', title: 'Groceries', body: 'Bread', revision: 2 });
    const user = userEvent.setup();
    stubFetch({ 'GET /api/spaces/spc_1/notes': () => json({ notes: [existing] }) });
    const { unmount } = render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    const bodyField = await screen.findByRole('textbox', { name: 'Note body' });
    await user.type(bodyField, ', eggs');
    unmount();

    const fetchMock = stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: [moved] }),
      'GET /api/notes/n1': () => json(moved),
      'PATCH /api/notes/n1': () => json({ error: { code: 'conflict', current_revision: 2 } }, 409),
    });
    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(patchBody(fetchMock)).toEqual({ revision: 1, title: 'Groceries', body: 'Milk, eggs' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Someone saved this note while you were editing');
    expect((screen.getByRole('textbox', { name: 'Note body' }) as HTMLTextAreaElement).value).toBe('Milk, eggs');
  });

  it('Discard changes restores the saved text and clears the draft', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk', revision: 1 });
    stubFetch({ 'GET /api/spaces/spc_1/notes': () => json({ notes: [existing] }) });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    const bodyField = await screen.findByRole('textbox', { name: 'Note body' });
    await user.type(bodyField, ', eggs');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect((screen.getByRole('textbox', { name: 'Note body' }) as HTMLTextAreaElement).value).toBe('Milk');

    await user.click(screen.getByRole('button', { name: 'Close note' }));
    await user.click(screen.getByText('Groceries'));
    expect(screen.queryByText('Your unsaved changes were restored.')).toBeNull();
  });

  it('shows no restored notice after reopening a note that was just saved', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk', revision: 1 });
    stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: [existing] }),
      'PATCH /api/notes/n1': () => json({ ...existing, body: 'Milk, eggs', revision: 2 }),
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    const bodyField = await screen.findByRole('textbox', { name: 'Note body' });
    await user.type(bodyField, ', eggs');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    await user.click(screen.getByRole('button', { name: 'Close note' }));
    await user.click(screen.getByText('Groceries'));
    expect(screen.queryByText('Your unsaved changes were restored.')).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Note body' }) as HTMLTextAreaElement).value).toBe('Milk, eggs');
  });
});

// Trash is reached from the list's own menu, not a top-level switch.
async function clickTrashTab(user: User): Promise<void> {
  await menuAction(user, 'Notes options', /^Trash \(\d+\)$/);
}

describe('NotesPanel trash', () => {
  it('moves a note to trash with no dialog, closes the editor, and the toast Undo restores it', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk' });
    const other = note({ id: 'n2', title: 'Chores', body: 'Vacuum' });
    const fetchMock = stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: [existing, other] }),
      'DELETE /api/notes/n1': () => new Response(null, { status: 204 }),
      'POST /api/notes/n1/restore': () => json({ ...existing, trashed_at: null }),
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    await menuAction(user, 'Note actions', 'Move to trash');

    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Note editor' })).toBeNull());
    expect((await screen.findAllByText('Moved Groceries to trash')).length).toBeGreaterThan(0);
    const list = await screen.findByRole('list', { name: 'Note list' });
    expect(within(list).queryByText('Groceries')).toBeNull();
    expect(callsTo(fetchMock, 'DELETE', '/api/notes/n1')).toHaveLength(1);

    // The toast viewport is a manual popover jsdom never shows; hidden opts in.
    await user.click(screen.getByRole('button', { name: 'Undo', hidden: true }));
    expect(callsTo(fetchMock, 'POST', '/api/notes/n1/restore')).toHaveLength(1);
    const listAfter = await screen.findByRole('list', { name: 'Note list' });
    expect(within(listAfter).getByText('Groceries')).toBeTruthy();
  });

  it('shows a trashed note only in the Trash segment and restores it from there', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk' });
    const trashedNote = note({
      id: 'n2',
      title: 'Old list',
      body: 'x',
      trashed_at: 1756100005000,
      updated_at: 1756100002000,
    });
    const fetchMock = stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: [existing, trashedNote] }),
      'POST /api/notes/n2/restore': () => json({ ...trashedNote, trashed_at: null }),
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    const list = await screen.findByRole('list', { name: 'Note list' });
    expect(within(list).queryByText('Old list')).toBeNull();

    await clickTrashTab(user);
    const trashList = await screen.findByRole('list', { name: 'Trashed notes' });
    expect(within(trashList).getByText('Old list')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'New note title' })).toBeNull();

    await menuAction(user, 'Actions for Old list', 'Restore');
    expect(callsTo(fetchMock, 'POST', '/api/notes/n2/restore')).toHaveLength(1);
    expect(await screen.findByText('Trash is empty')).toBeTruthy();
  });

  it('shows the trash error and keeps the note in the list when the DELETE fails', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk' });
    stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: [existing] }),
      'DELETE /api/notes/n1': () => json({}, 500),
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await menuAction(user, 'Actions for Groceries', 'Move to trash');
    expect((await screen.findAllByText('The note could not be moved to trash.')).length).toBeGreaterThan(0);
    const list = await screen.findByRole('list', { name: 'Note list' });
    expect(within(list).getByText('Groceries')).toBeTruthy();
  });
});

describe('NotesPanel search', () => {
  it('searches as you type, shows only the match under Search results, and opens it in the editor', async () => {
    const found = note({ id: 'n2', title: 'Trip plan', body: 'Pack bags' });
    const fetchMock = stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: manyNotes([note()]) }),
      'GET /api/spaces/spc_1/notes/search': () => json({ notes: [found] }),
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    const search = await screen.findByRole('textbox', { name: 'Search notes' });
    await user.type(search, 'trip');

    expect(await screen.findByText('1 note found')).toBeTruthy();
    const searchCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/notes/search'));
    // One request for the settled query, not one per key.
    expect(searchCalls).toHaveLength(1);
    expect(String(searchCalls[0][0])).toBe('/api/spaces/spc_1/notes/search?q=trip');
    const list = await screen.findByRole('list', { name: 'Search results' });
    expect(within(list).getByText('Trip plan')).toBeTruthy();
    expect(within(list).queryByText('Groceries')).toBeNull();

    await user.click(within(list).getByText('Trip plan'));
    const titleField = await screen.findByRole('textbox', { name: 'Note title' });
    expect((titleField as HTMLInputElement).value).toBe('Trip plan');
  });

  it('shows "No notes match." for an empty result set', async () => {
    stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: manyNotes() }),
      'GET /api/spaces/spc_1/notes/search': () => json({ notes: [] }),
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.type(await screen.findByRole('textbox', { name: 'Search notes' }), 'zzz');
    expect(await screen.findByText('No notes match.')).toBeTruthy();
  });

  it('shows a search failure as an alert with Retry on a 500', async () => {
    let calls = 0;
    stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: manyNotes() }),
      'GET /api/spaces/spc_1/notes/search': () => {
        calls += 1;
        return calls === 1 ? json({}, 500) : json({ notes: [] });
      },
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.type(await screen.findByRole('textbox', { name: 'Search notes' }), 'zzz');
    const alerts = await screen.findAllByRole('alert');
    await waitFor(() => expect(alerts.concat(screen.queryAllByRole('alert')).some((a) => a.textContent?.includes('Search failed. Try again.'))).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No notes match.')).toBeTruthy();
  });

  it('sends no search request for a blank query', async () => {
    const fetchMock = stubFetch({ 'GET /api/spaces/spc_1/notes': () => json({ notes: manyNotes() }) });
    render(<NotesPanel space={SPACE} />);
    const search = await screen.findByRole('textbox', { name: 'Search notes' });
    // Fake timers from here, so the search delay passes without waiting on the clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.change(search, { target: { value: '   ' } });
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/notes/search'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies only the latest query result when an older query resolves after it', async () => {
    const milkNote = note({ id: 'n_milk', title: 'Milk list', body: '2% milk' });
    const tripNote = note({ id: 'n_trip', title: 'Trip plan', body: 'Pack bags' });
    let resolveTrip: (response: Response) => void = () => undefined;
    let resolveMilk: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url === '/api/spaces/spc_1/notes?trashed=true') return json({ notes: manyNotes() });
      if (method === 'GET' && url === '/api/spaces/spc_1/notes/search?q=trip') {
        return new Promise<Response>((resolve) => {
          resolveTrip = resolve;
        });
      }
      if (method === 'GET' && url === '/api/spaces/spc_1/notes/search?q=milk') {
        return new Promise<Response>((resolve) => {
          resolveMilk = resolve;
        });
      }
      throw new Error(`unrouted request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    const search = await screen.findByRole('textbox', { name: 'Search notes' });
    await user.type(search, 'trip');
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('q=trip'))).toBe(true));
    await user.clear(search);
    await user.type(search, 'milk');
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('q=milk'))).toBe(true));

    resolveMilk(json({ notes: [milkNote] }));
    expect(await screen.findByText('Milk list')).toBeTruthy();

    // The stale reply is fully read (the same promise the panel awaits) and
    // the event loop has turned once, so any state it could set has landed.
    const tripReply = json({ notes: [tripNote] });
    const readBody = tripReply.json.bind(tripReply);
    let tripRead: Promise<unknown> | null = null;
    tripReply.json = () => (tripRead = readBody());
    resolveTrip(tripReply);
    await waitFor(() => expect(tripRead).not.toBeNull());
    await act(async () => {
      await tripRead;
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(screen.queryByText('Trip plan')).toBeNull();
    expect(screen.getByText('Milk list')).toBeTruthy();
  });

  it('brings back the full Note list when the query is cleared', async () => {
    const found = note({ id: 'n2', title: 'Trip plan', body: 'Pack bags' });
    stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: manyNotes([note()]) }),
      'GET /api/spaces/spc_1/notes/search': () => json({ notes: [found] }),
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    const search = await screen.findByRole('textbox', { name: 'Search notes' });
    await user.type(search, 'trip');
    await screen.findByRole('list', { name: 'Search results' });

    await user.clear(search);
    expect(screen.queryByRole('list', { name: 'Search results' })).toBeNull();
    const list = await screen.findByRole('list', { name: 'Note list' });
    expect(within(list).getByText('Groceries')).toBeTruthy();
  });
});

describe('NotesPanel history', () => {
  const REV2 = revision({ id: 'r2', revision: 2, body: 'Milk, eggs', editor_user_id: 'u-self', created_at: 1756100002000 });
  const REV1 = revision({ id: 'r1', revision: 1, body: 'Milk', editor_user_id: 'u-riley', ai_assisted: true, created_at: 1756100001000 });

  it('lists revisions newest first with the editor name and an AI assisted token, and shows a picked one read-only', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk, eggs', revision: 2 });
    const fetchMock = stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: [existing] }),
      'GET /api/notes/n1/revisions': () => json({ revisions: [REV2, REV1] }),
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    await menuAction(user, 'Note actions', 'Show history');
    expect(callsTo(fetchMock, 'GET', '/api/notes/n1/revisions')).toHaveLength(1);

    const list = await screen.findByRole('list', { name: 'Version history' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0].textContent).toContain('Version 2');
    expect(items[1].textContent).toContain('Version 1');
    expect(items[1].textContent).toContain('Riley');
    expect(within(list).getByText('AI assisted')).toBeTruthy();

    await user.click(within(list).getByText('Version 1'));
    const bodyField = (await screen.findByRole('textbox', { name: 'Version 1 body' })) as HTMLTextAreaElement;
    expect(bodyField.value).toBe('Milk');
    expect(bodyField.readOnly).toBe(true);
  });

  it('shows a failure message when revisions fail to load', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk' });
    stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: [existing] }),
      'GET /api/notes/n1/revisions': () => json({}, 500),
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    await menuAction(user, 'Note actions', 'Show history');
    expect(await screen.findByText('History could not be loaded.')).toBeTruthy();
  });

  it('reloads history after a successful save while history is open', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk', revision: 1 });
    const fetchMock = stubFetch({
      'GET /api/spaces/spc_1/notes': () => json({ notes: [existing] }),
      'GET /api/notes/n1/revisions': () => json({ revisions: [REV1] }),
      'PATCH /api/notes/n1': () => json({ ...existing, body: 'Milk, eggs', revision: 2 }),
    });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    await menuAction(user, 'Note actions', 'Show history');
    await screen.findByRole('list', { name: 'Version history' });

    const bodyField = await screen.findByRole('textbox', { name: 'Note body' });
    await user.type(bodyField, ', eggs');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');

    expect(callsTo(fetchMock, 'GET', '/api/notes/n1/revisions')).toHaveLength(2);
  });

  it('shows who edited the note last in plain words, with no revision numbers', async () => {
    stubFetch({ 'GET /api/spaces/spc_1/notes': () => json({ notes: [note({ updated_by: 'u-riley', revision: 7 })] }) });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    const editor = await screen.findByRole('region', { name: 'Note editor' });
    expect(editor.textContent).toContain('Edited by Riley');
    expect(editor.textContent).not.toMatch(/Revision/);
  });

  it('has no restore button inside the Note editor region', async () => {
    const existing = note({ id: 'n1', title: 'Groceries', body: 'Milk' });
    stubFetch({ 'GET /api/spaces/spc_1/notes': () => json({ notes: [existing] }) });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByText('Groceries'));
    const editor = await screen.findByRole('region', { name: 'Note editor' });
    expect(within(editor).queryByRole('button', { name: /restore/i })).toBeNull();
  });
});

// Issue #142: a private note can be copied to a shared space, after a preview.
// The request carries only the destination and the chosen fields -- never the
// body text, the history or anything else about the private source.
describe('NotesPanel copy to another space', () => {
  const PRIVATE: Space = { ...SPACE, id: 'spc_priv', kind: 'private', name: 'Private', members: [SAM] };
  const secret = note({ id: 'n_priv', space_id: 'spc_priv', title: 'Trip ideas', body: 'private musing' });
  const routes = (extra: Record<string, Handler> = {}): Record<string, Handler> => ({
    'GET /api/spaces/spc_priv/notes': () => json({ notes: [secret] }),
    'GET /api/spaces': () => json({ spaces: [PRIVATE, SPACE].map(({ members: _m, ...summary }) => summary) }),
    'GET /api/spaces/spc_priv/members': () => json({ members: [SAM] }),
    'GET /api/spaces/spc_1/members': () => json({ members: [SAM, RILEY] }),
    ...extra,
  });

  async function openCopy(user: User): Promise<HTMLElement> {
    await menuAction(user, 'Actions for Trip ideas', 'Copy to another space');
    return screen.findByRole('dialog', { name: 'Copy to another space' });
  }

  it('previews exactly what is copied, then copies only the selected fields and confirms with a toast', async () => {
    const fetchMock = stubFetch(routes({ 'POST /api/notes/n_priv/publish': () => json(note({ id: 'n_copy' }), 201) }));
    const user = userEvent.setup();
    render(<SpacesProvider><NotesPanel space={PRIVATE} /></SpacesProvider>);
    await waitFor(() => expect(callsTo(fetchMock, 'GET', '/api/spaces/spc_1/members')).toHaveLength(1));
    const dialog = await openCopy(user);
    const preview = within(dialog).getByRole('group', { name: 'Copy preview' });
    expect(preview.textContent).toContain('Trip ideas');
    expect(preview.textContent).toContain('private musing');
    // The preview reads as text, not as fields that look editable.
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    await user.click(within(dialog).getByRole('switch', { name: 'Include the body' }));
    expect(preview.textContent).not.toContain('private musing');
    expect(callsTo(fetchMock, 'POST', '/api/notes/n_priv/publish')).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    expect((await screen.findAllByText('Copied to Test Family')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Copy to another space' })).toBeNull());
    const [[, init]] = callsTo(fetchMock, 'POST', '/api/notes/n_priv/publish') as [[string, RequestInit]];
    const sent = String(init.body);
    expect(JSON.parse(sent)).toEqual({ space_id: 'spc_1', fields: { title: true, body: false } });
    expect(sent).not.toContain('private musing');
  });

  it('reports a refused copy and leaves the dialog open', async () => {
    stubFetch(routes({ 'POST /api/notes/n_priv/publish': () => json({ error: { code: 'not_found' } }, 404) }));
    const user = userEvent.setup();
    render(<SpacesProvider><NotesPanel space={PRIVATE} /></SpacesProvider>);
    const dialog = await openCopy(user);
    await waitFor(() => expect(isDisabled(within(dialog).getByRole('button', { name: 'Copy' }))).toBe(false));
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    expect(await within(dialog).findByText('The copy could not be made.')).toBeTruthy();
  });

  it('offers no copy action on a note that already lives in a shared space', async () => {
    stubFetch({ 'GET /api/spaces/spc_1/notes': () => json({ notes: [note()] }) });
    const user = userEvent.setup();
    render(<NotesPanel space={SPACE} />);
    await user.click(await screen.findByRole('button', { name: 'Actions for Groceries' }));
    await screen.findAllByRole('menuitem');
    expect(screen.queryByRole('menuitem', { name: 'Copy to another space' })).toBeNull();
  });
});
