import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));

import { MemoryPage } from './memory-page';
import type { Memory } from './memory-api';

const TWO_HOURS_AGO = Date.now() - 2 * 3_600_000;

const MEMORY: Memory = {
  id: 'mem_1',
  kind: 'fact',
  content: 'User is vegetarian.',
  confidence: 0.9,
  sensitive: false,
  source: { conversation_id: 'cnv_1', message_id: 'msg_1', surface: 'web_text' },
  superseded_by: null,
  created_at: TWO_HOURS_AGO,
  updated_at: TWO_HOURS_AGO,
};
const WIFE: Memory = { ...MEMORY, id: 'mem_2', content: "User's wife is Sam Example.", confidence: 0.4 };
const TEA: Memory = {
  ...MEMORY,
  id: 'mem_3',
  kind: 'preference',
  content: 'User prefers tea over coffee.',
  source: { conversation_id: null, message_id: null, surface: 'web_voice' },
};
const OLD: Memory = { ...MEMORY, id: 'mem_4', content: 'User eats fish.', superseded_by: 'mem_1' };
const INTENT: Memory = { ...MEMORY, id: 'mem_5', kind: 'intent', content: 'User wants directions home.' };
const TODO: Memory = { ...MEMORY, id: 'mem_6', kind: 'action_item', content: 'Call the dentist' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Handler = (init?: RequestInit) => Response | Promise<Response>;

// Routes each request by "METHOD url"; anything unlisted fails the request.
function serve(handlers: Record<string, Handler>): void {
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    const handler = handlers[`${init?.method ?? 'GET'} ${url}`];
    if (!handler) throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    return handler(init);
  });
}

function listing(memories: Memory[], next: string | null = null): Record<string, Handler> {
  return { 'GET /api/memories': () => json(200, { memories, next_cursor: next }) };
}

// jsdom has no modal <dialog>; the Astryx alert dialog calls showModal() on open.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};

async function openMenu(label: string): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: `Actions for ${label}` }));
}

async function pick(label: string, item: string): Promise<void> {
  await openMenu(label);
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('MemoryPage list', () => {
  it('shows Skeleton rows while loading, with Add memory already available', async () => {
    serve(listing([MEMORY]));
    render(<MemoryPage />);
    expect(screen.getByRole('status', { name: 'Loading memories' })).toBeTruthy();
    expect(screen.queryByText(/Loading memories…/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Add memory' })).toBeTruthy();
    expect(await screen.findByText("You're vegetarian.")).toBeTruthy();
  });

  it('lists facts only: no action items, no intents, and never asks for /api/action-items', async () => {
    serve(listing([MEMORY, INTENT, TODO]));
    render(<MemoryPage />);
    expect(await screen.findByText("You're vegetarian.")).toBeTruthy();
    expect(screen.queryByText(/directions/)).toBeNull();
    expect(screen.queryByText('Call the dentist')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Action items' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Make it a task/ })).toBeNull();
    expect(fetchWithAuth.mock.calls.map(([url]) => url)).toEqual(['/api/memories']);
  });

  it('addresses the reader without changing what is stored', async () => {
    serve(listing([MEMORY, WIFE, TEA]));
    render(<MemoryPage />);
    expect(await screen.findByText("You're vegetarian.")).toBeTruthy();
    expect(screen.getByText('Your wife is Sam Example.')).toBeTruthy();
    expect(screen.getByText('You prefer tea over coffee.')).toBeTruthy();
    expect(screen.queryByText(/^User/)).toBeNull();
  });

  it('groups People, Preferences and Facts, and the tabs narrow to one group', async () => {
    serve(listing([MEMORY, WIFE, TEA]));
    render(<MemoryPage />);
    await screen.findByText("You're vegetarian.");
    for (const name of ['People', 'Preferences', 'Facts']) {
      expect(screen.getByRole('heading', { name, level: 2 })).toBeTruthy();
    }
    await userEvent.click(screen.getByRole('button', { name: 'People' }));
    expect(screen.getByText('Your wife is Sam Example.')).toBeTruthy();
    expect(screen.queryByText("You're vegetarian.")).toBeNull();
    expect(screen.queryByText('You prefer tea over coffee.')).toBeNull();
  });

  it('shows one meta line "Preference · 2 hours ago", and "Not sure" only on low confidence', async () => {
    serve(listing([WIFE, TEA]));
    render(<MemoryPage />);
    await screen.findByText('You prefer tea over coffee.');
    const lines = screen.getAllByText((_c, element) => element?.textContent === 'Preference · 2 hours ago');
    expect(lines.length).toBeGreaterThan(0);
    expect(screen.queryByText(/confident/)).toBeNull();
    expect(screen.queryByText(/typed|voice/)).toBeNull();
    expect(screen.getAllByText('Not sure')).toHaveLength(1);
  });

  it('folds older versions into a collapsed group', async () => {
    serve(listing([MEMORY, OLD]));
    render(<MemoryPage />);
    await userEvent.click(await screen.findByText('Older versions (1)'));
    expect(await screen.findByText('You eat fish.')).toBeTruthy();
  });

  it('shows more with the cursor and appends', async () => {
    serve({
      ...listing([MEMORY], 'cur 2'),
      'GET /api/memories?cursor=cur+2': () => json(200, { memories: [TEA], next_cursor: null }),
    });
    render(<MemoryPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('You prefer tea over coffee.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull());
  });

  it('keeps the list and says so under Show more when the next page fails', async () => {
    serve({ ...listing([MEMORY], 'cur_2'), 'GET /api/memories?cursor=cur_2': () => json(500, {}) });
    render(<MemoryPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText("Couldn't load more memories.")).toBeTruthy();
    expect(screen.getByText("You're vegetarian.")).toBeTruthy();
  });

  it('shows the empty state with one Add memory action', async () => {
    serve(listing([]));
    render(<MemoryPage />);
    expect(await screen.findByRole('heading', { name: 'Nothing remembered yet', level: 2 })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add memory' })).toHaveLength(2);
  });

  it('shows the load error inline with Retry, and Retry loads', async () => {
    let calls = 0;
    serve({ 'GET /api/memories': () => (++calls === 1 ? json(500, {}) : json(200, { memories: [MEMORY], next_cursor: null })) });
    render(<MemoryPage />);
    expect(await screen.findByText("Couldn't load your memories.")).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText("You're vegetarian.")).toBeTruthy();
    expect(screen.queryByText("Couldn't load your memories.")).toBeNull();
  });

  it('says plainly that memory is off for a 503, with no Add memory', async () => {
    serve({ 'GET /api/memories': () => json(503, { error: { code: 'memory_unavailable' } }) });
    render(<MemoryPage />);
    expect(await screen.findByRole('heading', { name: 'Memory is off', level: 2 })).toBeTruthy();
    expect(screen.getByText("Bob can't remember things on your account right now.")).toBeTruthy();
    expect(screen.queryByText(/server/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add memory' })).toBeNull();
  });

  it('has no Delete all on the page (it lives in Settings)', async () => {
    serve(listing([MEMORY]));
    render(<MemoryPage />);
    await screen.findByText("You're vegetarian.");
    expect(screen.queryByRole('button', { name: /Delete all/ })).toBeNull();
  });
});

describe('MemoryPage row menu', () => {
  it('mounts its items only once opened, in the order Edit, View conversation, Delete', async () => {
    serve(listing([MEMORY]));
    render(<MemoryPage />);
    await screen.findByText("You're vegetarian.");
    expect(screen.queryByRole('menuitem')).toBeNull();
    await openMenu("You're vegetarian.");
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Edit', 'View conversation', 'Delete']);
  });

  it('offers no View conversation when the memory has no source', async () => {
    serve(listing([TEA]));
    render(<MemoryPage />);
    await openMenu('You prefer tea over coffee.');
    await screen.findByRole('menuitem', { name: 'Edit' });
    expect(screen.queryByRole('menuitem', { name: 'View conversation' })).toBeNull();
  });

  it('opens the source conversation client-side', async () => {
    serve(listing([MEMORY]));
    render(<MemoryPage />);
    await pick("You're vegetarian.", 'View conversation');
    expect(window.location.pathname).toBe('/c/cnv_1');
  });

  it('asks before deleting with a dialog naming the memory; Cancel sends nothing', async () => {
    const remove = vi.fn(() => new Response(null, { status: 204 }));
    serve({ ...listing([MEMORY]), 'DELETE /api/memories/mem_1': remove });
    render(<MemoryPage />);
    await pick("You're vegetarian.", 'Delete');
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete “You\'re vegetarian.”?' });
    expect(within(dialog).getByText("Bob will forget this. This can't be undone.")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(remove).not.toHaveBeenCalled();
  });

  it('deletes after the dialog’s Delete and shows the empty state', async () => {
    const remove = vi.fn(() => new Response(null, { status: 204 }));
    serve({ ...listing([MEMORY]), 'DELETE /api/memories/mem_1': remove });
    render(<MemoryPage />);
    await pick("You're vegetarian.", 'Delete');
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('heading', { name: 'Nothing remembered yet', level: 2 })).toBeTruthy();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('puts the memory back in its place when the delete fails', async () => {
    serve({ ...listing([MEMORY, WIFE]), 'DELETE /api/memories/mem_1': () => json(500, {}) });
    render(<MemoryPage />);
    await pick("You're vegetarian.", 'Delete');
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByText("You're vegetarian.")).toBeTruthy());
  });

  it('edits in a dialog in the reader’s voice and stores the canonical voice', async () => {
    const patch = vi.fn((_init?: RequestInit) => json(200, { ...MEMORY, content: 'User is vegan.' }));
    serve({ ...listing([MEMORY]), 'PATCH /api/memories/mem_1': patch });
    render(<MemoryPage />);
    await pick("You're vegetarian.", 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit memory' });
    const field = within(dialog).getByRole('textbox', { name: 'What should Bob remember?' }) as HTMLTextAreaElement;
    expect(field.value).toBe("You're vegetarian.");
    await userEvent.clear(field);
    await userEvent.type(field, "You're vegan.");
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText("You're vegan.")).toBeTruthy();
    expect(patch.mock.calls[0]?.[0]?.body).toBe(JSON.stringify({ content: 'User is vegan.' }));
  });

  it('keeps the edit dialog open with the error on the field when saving fails', async () => {
    serve({ ...listing([MEMORY]), 'PATCH /api/memories/mem_1': () => json(500, {}) });
    render(<MemoryPage />);
    await pick("You're vegetarian.", 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit memory' });
    await userEvent.type(within(dialog).getByRole('textbox'), ' Mostly.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText("Couldn't save the change. Try again.")).toBeTruthy();
  });
});

describe('MemoryPage add', () => {
  async function openAddDialog(): Promise<HTMLElement> {
    const [add] = await screen.findAllByRole('button', { name: 'Add memory' });
    if (!add) throw new Error('Add memory button missing');
    await userEvent.click(add);
    return screen.findByRole('dialog', { name: 'Add a memory' });
  }

  it('offers only Fact and Preference', async () => {
    serve(listing([MEMORY]));
    render(<MemoryPage />);
    const dialog = await openAddDialog();
    expect(within(dialog).getAllByRole('radio').map((radio) => radio.getAttribute('aria-label') ?? radio.textContent)).toEqual([
      'Fact',
      'Preference',
    ]);
  });

  it('adds a preference and shows it', async () => {
    const added: Memory = { ...TEA, id: 'mem_new' };
    let posted = false;
    const post = vi.fn((_init?: RequestInit) => {
      posted = true;
      return json(201, added);
    });
    serve({
      'GET /api/memories': () => json(200, { memories: posted ? [added] : [], next_cursor: null }),
      'POST /api/memories': post,
    });
    render(<MemoryPage />);
    const dialog = await openAddDialog();
    await userEvent.type(within(dialog).getByRole('textbox'), 'I prefer tea over coffee');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Preference' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remember' }));
    expect(await screen.findByText('You prefer tea over coffee.')).toBeTruthy();
    expect(post.mock.calls[0]?.[0]?.body).toBe(JSON.stringify({ content: 'I prefer tea over coffee', kind: 'preference' }));
  });

  it('keeps Remember disabled while the field is empty', async () => {
    serve(listing([MEMORY]));
    render(<MemoryPage />);
    const dialog = await openAddDialog();
    const remember = within(dialog).getByRole('button', { name: 'Remember' });
    expect(remember.hasAttribute('disabled') || remember.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('keeps the dialog open with the secret message on a 422 secret_refused', async () => {
    serve({ ...listing([MEMORY]), 'POST /api/memories': () => json(422, { error: { code: 'secret_refused' } }) });
    render(<MemoryPage />);
    const dialog = await openAddDialog();
    await userEvent.type(within(dialog).getByRole('textbox'), 'hunter2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remember' }));
    expect(
      await within(dialog).findByText('That looks like a password, PIN or other secret. Bob never stores those.'),
    ).toBeTruthy();
  });
});

describe('MemoryPage search', () => {
  it('searches on the server and offers Clear search when nothing matches', async () => {
    serve({
      ...listing([MEMORY, TEA]),
      'GET /api/memories?q=tea': () => json(200, { memories: [TEA], next_cursor: null }),
      'GET /api/memories?q=zzz': () => json(200, { memories: [], next_cursor: null }),
    });
    render(<MemoryPage />);
    const input = await screen.findByRole('textbox', { name: 'Search memories' });
    await userEvent.type(input, 'tea');
    await waitFor(() => expect(screen.queryByText("You're vegetarian.")).toBeNull());
    expect(screen.getByText('You prefer tea over coffee.')).toBeTruthy();
    await userEvent.clear(input);
    await userEvent.type(input, 'zzz');
    expect(await screen.findByRole('heading', { name: 'No memories match “zzz”' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText("You're vegetarian.")).toBeTruthy();
    expect(screen.queryByText(/Only loaded memories/)).toBeNull();
  });
});

describe('MemoryPage refresh on focus', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('refetches when the tab becomes visible again, and keeps the list if that fails', async () => {
    let calls = 0;
    serve({
      'GET /api/memories': () =>
        ++calls === 1
          ? json(200, { memories: [MEMORY], next_cursor: null })
          : calls === 2
            ? json(200, { memories: [TEA, MEMORY], next_cursor: null })
            : json(500, {}),
    });
    render(<MemoryPage />);
    await screen.findByText("You're vegetarian.");
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await screen.findByText('You prefer tea over coffee.')).toBeTruthy();
    expect(screen.queryByText("Couldn't load your memories.")).toBeNull();
  });
});
