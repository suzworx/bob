import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useNotes,
  sortNotes,
  NOTES_LIST_ERROR,
  type NoteSummary,
  type NoteRevision,
} from './use-notes';

vi.mock('../../lib/auth/use-session', () => ({
  fetchWithAuth: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

const SPACE_ID = 'space-1';

function note(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: 'n1',
    space_id: SPACE_ID,
    title: 'Note',
    body: '',
    pinned: false,
    revision: 1,
    created_by: 'u1',
    updated_by: 'u1',
    ai_assisted: false,
    trashed_at: null,
    created_at: 1756100000000,
    updated_at: 1756100000000,
    ...overrides,
  };
}

const NOTE_A = note({ id: 'n1', title: 'Alpha', updated_at: 1756100000000 });
const NOTE_B = note({ id: 'n2', title: 'Beta', pinned: true, updated_at: 1756100001000 });
const NOTE_TRASHED = note({
  id: 'n3',
  title: 'Gone',
  trashed_at: 1756100002000,
  updated_at: 1756100002000,
});

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? undefined : { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useNotes', () => {
  it('loads the list and splits active/trashed with pinned-first, newest-first order', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { notes: [NOTE_A, NOTE_B, NOTE_TRASHED] }));
    const { result } = renderHook(() => useNotes(SPACE_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/spaces/${SPACE_ID}/notes?trashed=true`,
      undefined,
    );
    expect(result.current.notes).toEqual([NOTE_B, NOTE_A]);
    expect(result.current.trashed).toEqual([NOTE_TRASHED]);
    expect(result.current.error).toBeNull();
  });

  it('sets error on a failed list load and leaves loading false', async () => {
    fetchMock.mockResolvedValueOnce(json(500, { error: { code: 'store_error' } }));
    const { result } = renderHook(() => useNotes(SPACE_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(NOTES_LIST_ERROR);
    expect(result.current.notes).toEqual([]);
  });

  it('sortNotes copies rather than mutating its input', () => {
    const input = [NOTE_A, NOTE_B];
    const sorted = sortNotes(input);
    expect(sorted).not.toBe(input);
    expect(sorted).toEqual([NOTE_B, NOTE_A]);
    expect(input).toEqual([NOTE_A, NOTE_B]);
  });

  it('refetches the list when refreshKey changes', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { notes: [NOTE_A] }));
    const { result, rerender } = renderHook(({ key }: { key: number }) => useNotes(SPACE_ID, key), {
      initialProps: { key: 0 },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockResolvedValueOnce(json(200, { notes: [NOTE_A, NOTE_B] }));
    rerender({ key: 1 });
    await waitFor(() => expect(result.current.notes).toHaveLength(2));
    const calls = fetchMock.mock.calls.filter(
      ([input]) => input === `/api/spaces/${SPACE_ID}/notes?trashed=true`,
    );
    expect(calls).toHaveLength(2);
  });

  it('ignores a stale response for an old spaceId that resolves after the new one', async () => {
    let releaseFirst!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { releaseFirst = resolve; }),
    );
    const { result, rerender } = renderHook(({ id }: { id: string }) => useNotes(id), {
      initialProps: { id: 'space-1' },
    });

    let releaseSecond!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { releaseSecond = resolve; }),
    );
    rerender({ id: 'space-2' });

    releaseSecond(json(200, { notes: [NOTE_B] }));
    await waitFor(() => expect(result.current.notes).toEqual([NOTE_B]));
    releaseFirst(json(200, { notes: [NOTE_A] }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.notes).toEqual([NOTE_B]);
  });

  it('createNote posts a minimal body and adds the note to the list', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { notes: [] }));
    const { result } = renderHook(() => useNotes(SPACE_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const created = note({ id: 'n9', title: 'Trip plan' });
    fetchMock.mockResolvedValueOnce(json(201, created));
    let returned: NoteSummary | null = null;
    await act(async () => { returned = await result.current.createNote('Trip plan'); });
    expect(returned).toEqual(created);
    const call = fetchMock.mock.calls.find(([input]) => input === `/api/spaces/${SPACE_ID}/notes`);
    expect(call?.[1]?.body).toBe(JSON.stringify({ title: 'Trip plan' }));
    expect(result.current.notes).toContainEqual(created);
  });

  it('saveNote 200: PATCHes exactly {revision,title,body} and updates the list', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { notes: [NOTE_A] }));
    const { result } = renderHook(() => useNotes(SPACE_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const saved = { ...NOTE_A, title: 'T', body: 'B', revision: 2 };
    fetchMock.mockResolvedValueOnce(json(200, saved));
    await act(async () => {
      const outcome = await result.current.saveNote(NOTE_A.id, 1, { title: 'T', body: 'B' });
      expect(outcome).toEqual({ status: 'saved', note: saved });
    });
    const call = fetchMock.mock.calls.find(([input]) => input === `/api/notes/${NOTE_A.id}`);
    expect(call?.[1]?.body).toBe(JSON.stringify({ revision: 1, title: 'T', body: 'B' }));
    expect(result.current.notes.find((n) => n.id === NOTE_A.id)?.revision).toBe(2);
  });

  it('saveNote 409 then GET 200: conflict carries the fetched current note', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { notes: [NOTE_A] }));
    const { result } = renderHook(() => useNotes(SPACE_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const current = { ...NOTE_A, revision: 3 };
    fetchMock.mockResolvedValueOnce(
      json(409, { error: { code: 'conflict', message: 'stale', current_revision: 3 } }),
    );
    fetchMock.mockResolvedValueOnce(json(200, current));
    await act(async () => {
      const outcome = await result.current.saveNote(NOTE_A.id, 1, { title: 'T', body: 'B' });
      expect(outcome).toEqual({ status: 'conflict', current, currentRevision: 3 });
    });
    expect(result.current.notes.find((n) => n.id === NOTE_A.id)).toEqual(current);
  });

  it('saveNote 409 then GET 500: conflict with current null, revision from the 409 body', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { notes: [NOTE_A] }));
    const { result } = renderHook(() => useNotes(SPACE_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockResolvedValueOnce(
      json(409, { error: { code: 'conflict', message: 'stale', current_revision: 5 } }),
    );
    fetchMock.mockResolvedValueOnce(json(500, { error: { code: 'store_error' } }));
    await act(async () => {
      const outcome = await result.current.saveNote(NOTE_A.id, 1, { title: 'T', body: 'B' });
      expect(outcome).toEqual({ status: 'conflict', current: null, currentRevision: 5 });
    });
  });

  it('saveNote 500: failed, and the list is left unchanged', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { notes: [NOTE_A] }));
    const { result } = renderHook(() => useNotes(SPACE_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockResolvedValueOnce(json(500, { error: { code: 'store_error' } }));
    await act(async () => {
      const outcome = await result.current.saveNote(NOTE_A.id, 1, { title: 'T', body: 'B' });
      expect(outcome).toEqual({ status: 'failed' });
    });
    expect(result.current.notes).toEqual([NOTE_A]);
  });

  it('setPinned(true) PUTs the pin route and moves the note to the front', async () => {
    const first = note({ id: 'n1', title: 'First', updated_at: 1756100005000 });
    const second = note({ id: 'n2', title: 'Second', updated_at: 1756100000000 });
    fetchMock.mockResolvedValueOnce(json(200, { notes: [first, second] }));
    const { result } = renderHook(() => useNotes(SPACE_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notes[0]?.id).toBe('n1');

    const pinned = { ...second, pinned: true };
    fetchMock.mockResolvedValueOnce(json(200, pinned));
    let ok = false;
    await act(async () => { ok = await result.current.setPinned(second, true); });
    expect(ok).toBe(true);
    const call = fetchMock.mock.calls.find(([input]) => input === '/api/notes/n2/pin');
    expect(call?.[1]?.method).toBe('PUT');
    expect(result.current.notes[0]).toEqual(pinned);
  });

  it('setPinned(false) DELETEs the pin route', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { notes: [NOTE_B] }));
    const { result } = renderHook(() => useNotes(SPACE_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const unpinned = { ...NOTE_B, pinned: false };
    fetchMock.mockResolvedValueOnce(json(200, unpinned));
    await act(async () => { await result.current.setPinned(NOTE_B, false); });
    const call = fetchMock.mock.calls.find(([input]) => input === `/api/notes/${NOTE_B.id}/pin`);
    expect(call?.[1]?.method).toBe('DELETE');
  });

  it('trashNote moves the note from notes to trashed on a bodyless 204', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { notes: [NOTE_A] }));
    const { result } = renderHook(() => useNotes(SPACE_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    let ok = false;
    await act(async () => { ok = await result.current.trashNote(NOTE_A); });
    expect(ok).toBe(true);
    expect(result.current.notes).toEqual([]);
    expect(result.current.trashed).toHaveLength(1);
    expect(result.current.trashed[0]?.id).toBe(NOTE_A.id);
  });

  it('restoreNote POSTs /restore and moves the note back to notes', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { notes: [NOTE_TRASHED] }));
    const { result } = renderHook(() => useNotes(SPACE_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.trashed).toHaveLength(1);

    const restored = { ...NOTE_TRASHED, trashed_at: null };
    fetchMock.mockResolvedValueOnce(json(200, restored));
    let ok = false;
    await act(async () => { ok = await result.current.restoreNote(NOTE_TRASHED); });
    expect(ok).toBe(true);
    const call = fetchMock.mock.calls.find(
      ([input]) => input === `/api/notes/${NOTE_TRASHED.id}/restore`,
    );
    expect(call?.[1]?.method).toBe('POST');
    expect(result.current.trashed).toEqual([]);
    expect(result.current.notes).toEqual([restored]);
  });

  it('searchNotes GETs the encoded query and returns the notes', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { notes: [] }));
    const { result } = renderHook(() => useNotes(SPACE_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockResolvedValueOnce(json(200, { notes: [NOTE_A] }));
    let found: NoteSummary[] | null = null;
    await act(async () => { found = await result.current.searchNotes('trip plan'); });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/spaces/${SPACE_ID}/notes/search?q=trip%20plan`,
      undefined,
    );
    expect(found).toEqual([NOTE_A]);
  });

  it('searchNotes returns [] for a blank query with no fetch, and null on a 500', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { notes: [] }));
    const { result } = renderHook(() => useNotes(SPACE_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const callsBefore = fetchMock.mock.calls.length;

    let blank: NoteSummary[] | null = null;
    await act(async () => { blank = await result.current.searchNotes('   '); });
    expect(blank).toEqual([]);
    expect(fetchMock.mock.calls).toHaveLength(callsBefore);

    fetchMock.mockResolvedValueOnce(json(500, { error: { code: 'store_error' } }));
    let failed: NoteSummary[] | null = [];
    await act(async () => { failed = await result.current.searchNotes('x'); });
    expect(failed).toBeNull();
  });

  it('listRevisions returns the array, and null on a 404', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { notes: [] }));
    const { result } = renderHook(() => useNotes(SPACE_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const revisions: NoteRevision[] = [
      {
        id: 'r1',
        note_id: 'n1',
        revision: 1,
        title: 'Alpha',
        body: '',
        editor_user_id: 'u1',
        ai_assisted: false,
        created_at: 1756100000000,
      },
    ];
    fetchMock.mockResolvedValueOnce(json(200, { revisions }));
    let got: NoteRevision[] | null = null;
    await act(async () => { got = await result.current.listRevisions('n1'); });
    expect(got).toEqual(revisions);

    fetchMock.mockResolvedValueOnce(json(404, { error: { code: 'not_found' } }));
    let missing: NoteRevision[] | null = revisions;
    await act(async () => { missing = await result.current.listRevisions('nope'); });
    expect(missing).toBeNull();
  });
});
