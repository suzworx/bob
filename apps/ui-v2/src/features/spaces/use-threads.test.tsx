import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  useThreads,
  waitForInvocation,
  INVOCATION_POLL_ATTEMPTS,
  INVOCATION_POLL_DELAY_MS,
  type Thread,
  type ThreadMessage,
  type ThreadInvocation,
} from './use-threads';
import { createQueryClient, threadKeys } from '../../lib/query-client';

const sessionState = vi.hoisted(() => ({ accountId: 'account-a' as string | null }));

vi.mock('../../lib/auth/use-session', () => ({
  fetchWithAuth: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  useSession: () => ({
    status: sessionState.accountId === null ? 'signed-out' : 'signed-in',
    session: sessionState.accountId === null ? null : { user: { id: sessionState.accountId } },
    unavailable: null,
    signOut: async () => undefined,
    signOutEverywhere: async () => undefined,
  }),
}));

const SPACE_ID = 'space-1';
const THREAD_ID = 'thread-1';

const THREAD: Thread = {
  id: THREAD_ID,
  space_id: SPACE_ID,
  title: 'Dinner plans',
  created_by: 'u1',
  archived_at: null,
  last_sequence: 1,
  unread_count: 0,
  created_at: 1756100000000,
  updated_at: 1756100000000,
};

const MSG: ThreadMessage = {
  id: 'm1',
  thread_id: THREAD_ID,
  space_id: SPACE_ID,
  author_user_id: 'u1',
  body: 'Hello',
  reply_to_message_id: null,
  sequence: 0,
  client_message_id: 'c1',
  revision: 1,
  tombstoned_at: null,
  tombstoned_by: null,
  created_at: 1756100000000,
  updated_at: 1756100000000,
  origin: 'web_text',
};

const SERVER_MSG: ThreadMessage = {
  ...MSG,
  id: 'server-id',
  body: 'posted',
  sequence: 1,
  client_message_id: 'web-1',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  sessionState.accountId = 'account-a';
  queryClient = createQueryClient();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useThreads', () => {
  it('loads threads: state moves loading -> ready, and empty for an empty list', async () => {
    let release!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { release = resolve; }),
    );
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('loading'));
    await act(async () => { release(json(200, { threads: [THREAD] })); });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));
    expect(result.current.threads).toEqual([THREAD]);

    fetchMock.mockResolvedValueOnce(json(200, { threads: [] }));
    const empty = renderHook(() => useThreads('space-2'), { wrapper });
    await waitFor(() => expect(empty.result.current.threadsState).toBe('empty'));
    expect(empty.result.current.threads).toEqual([]);
  });

  it('yields failed for a failed fetch without throwing out of the hook', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { error: { code: 'forbidden' } }));
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('failed'));
    expect(result.current.error).toBeTruthy();
  });

  it('dedupes: two components mounting the same hook cause one fetch', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    const first = renderHook(() => useThreads(SPACE_ID), { wrapper });
    const second = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(first.result.current.threadsState).toBe('ready'));
    await waitFor(() => expect(second.result.current.threadsState).toBe('ready'));
    const calls = fetchMock.mock.calls.filter(
      ([input]) => input === `/api/spaces/${SPACE_ID}/threads`,
    );
    expect(calls).toHaveLength(1);
  });

  it('refresh() invalidates and refetches', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    await act(async () => { await result.current.refresh(); });
    const calls = fetchMock.mock.calls.filter(
      ([input]) => input === `/api/spaces/${SPACE_ID}/threads`,
    );
    expect(calls).toHaveLength(2);
  });

  it('bob:thread-message refetches the open thread and its list', async () => {
    const DEVICE_MSG: ThreadMessage = { ...MSG, id: 'm-device', author_user_id: null, body: 'From the Cardputer', sequence: 1 };
    let messages: ThreadMessage[] = [MSG];
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `/api/spaces/${SPACE_ID}/threads`) return json(200, { threads: [THREAD] });
      if (url.startsWith(`/api/threads/${THREAD_ID}/messages`)) return json(200, { messages, next_cursor: null });
      return json(204, {});
    });
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await act(async () => { await result.current.openThread(THREAD_ID); });
    await waitFor(() => expect(result.current.messages).toEqual([MSG]));
    const listCalls = (): number =>
      fetchMock.mock.calls.filter(([input]) => input === `/api/spaces/${SPACE_ID}/threads`).length;
    const before = listCalls();
    messages = [MSG, DEVICE_MSG];
    act(() => {
      window.dispatchEvent(new CustomEvent('bob:thread-message', { detail: { threadId: THREAD_ID, spaceId: SPACE_ID } }));
    });
    await waitFor(() => expect(result.current.messages).toEqual([MSG, DEVICE_MSG]));
    await waitFor(() => expect(listCalls()).toBe(before + 1));
  });

  it('postMessage appends optimistically then reconciles with the server row', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    fetchMock.mockResolvedValueOnce(json(200, { messages: [MSG], next_cursor: null }));
    fetchMock.mockResolvedValueOnce(json(200, { thread_id: THREAD_ID, last_read_sequence: 1 }));
    let release!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { release = resolve; }),
    );
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));
    await act(async () => { await result.current.openThread(THREAD_ID); });
    await waitFor(() => expect(result.current.messagesState).toBe('ready'));
    expect(result.current.messages).toEqual([MSG]);

    let post!: Promise<ThreadMessage>;
    await act(async () => { post = result.current.postMessage('posted'); });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.messages[1].id).toMatch(/^pending-/);
    expect(result.current.messages[1].body).toBe('posted');

    await act(async () => {
      release(json(201, SERVER_MSG));
      await post;
    });
    await waitFor(() => expect(result.current.messages[1].id).toBe('server-id'));
    expect(result.current.messages).toHaveLength(2);
  });

  it('fetches every page of a thread and exposes all messages in order', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    const PAGE_1 = [MSG, { ...MSG, id: 'm2', sequence: 1 }];
    const PAGE_2 = [{ ...MSG, id: 'm3', sequence: 2 }];
    let secondPageUrl: string | null = null;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PUT') return json(200, { thread_id: THREAD_ID, last_read_sequence: 2 });
      if (url.includes('cursor=')) {
        secondPageUrl = url;
        return json(200, { messages: PAGE_2, next_cursor: null });
      }
      return json(200, { messages: PAGE_1, next_cursor: 'c1' });
    });

    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));
    await act(async () => { await result.current.openThread(THREAD_ID); });
    await waitFor(() => expect(result.current.messagesState).toBe('ready'));

    expect(result.current.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(secondPageUrl).toContain('cursor=c1');
  });

  it('marks read with no body when the whole thread loads before the page cap', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    let readInit: RequestInit | undefined;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        readInit = init;
        return json(200, { thread_id: THREAD_ID, last_read_sequence: 0 });
      }
      return json(200, { messages: [MSG], next_cursor: null });
    });
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));
    await act(async () => { await result.current.openThread(THREAD_ID); });
    await waitFor(() => expect(result.current.messagesState).toBe('ready'));

    await waitFor(() => expect(readInit).toBeDefined());
    expect(readInit?.body).toBeUndefined();
  });

  it('a capped thread marks read only up to the last message actually loaded', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    let readBody: unknown;
    let page = 0;
    // Every page reports more to fetch, so the loop only stops on the
    // MESSAGES_MAX_PAGES (25) guard, never on next_cursor === null.
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        readBody = init.body === undefined ? undefined : JSON.parse(String(init.body));
        return json(200, { thread_id: THREAD_ID, last_read_sequence: 0 });
      }
      const sequence = page;
      page += 1;
      return json(200, { messages: [{ ...MSG, id: `m${sequence}`, sequence }], next_cursor: 'more' });
    });
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));
    await act(async () => { await result.current.openThread(THREAD_ID); });
    await waitFor(() => expect(result.current.messagesState).toBe('ready'));

    expect(result.current.messages).toHaveLength(25);
    const lastLoaded = result.current.messages[result.current.messages.length - 1];
    await waitFor(() => expect(readBody).toEqual({ last_read_sequence: lastLoaded.sequence }));
  });

  it('rolls the optimistic message back and rethrows when the post fails', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    fetchMock.mockResolvedValueOnce(json(200, { messages: [MSG], next_cursor: null }));
    fetchMock.mockResolvedValueOnce(json(200, { thread_id: THREAD_ID, last_read_sequence: 1 }));
    let release!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { release = resolve; }),
    );
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));
    await act(async () => { await result.current.openThread(THREAD_ID); });
    await waitFor(() => expect(result.current.messagesState).toBe('ready'));

    let post!: Promise<ThreadMessage>;
    await act(async () => { post = result.current.postMessage('doomed'); });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    await act(async () => {
      release(json(500, { error: { code: 'store_error' } }));
      await expect(post).rejects.toThrow('post_failed');
    });
    await waitFor(() => expect(result.current.messages).toEqual([MSG]));
  });

  it('does not retry a 4xx response', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { error: { code: 'forbidden' } }));
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('failed'));
    const calls = fetchMock.mock.calls.filter(
      ([input]) => input === `/api/spaces/${SPACE_ID}/threads`,
    );
    expect(calls).toHaveLength(1);
  });

  it('renameThread updates the cached title and keeps unread_count', async () => {
    const UNREAD_THREAD: Thread = { ...THREAD, unread_count: 3 };
    fetchMock.mockResolvedValueOnce(json(200, { threads: [UNREAD_THREAD] }));
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));

    const renamed = { ...UNREAD_THREAD, title: 'Weekly shop', unread_count: 0 };
    fetchMock.mockResolvedValueOnce(json(200, renamed));
    let returned!: Thread;
    await act(async () => { returned = await result.current.renameThread(THREAD_ID, 'Weekly shop'); });

    expect(returned).toEqual(renamed);
    await waitFor(() =>
      expect(result.current.threads[0]).toEqual({ ...renamed, unread_count: UNREAD_THREAD.unread_count }),
    );
  });

  it('renameThread throws rename_failed on a 500 and leaves the cache unchanged', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));

    fetchMock.mockResolvedValueOnce(json(500, { error: { code: 'store_error' } }));
    await expect(result.current.renameThread(THREAD_ID, 'Weekly shop')).rejects.toThrow('rename_failed');
    expect(result.current.threads).toEqual([THREAD]);
  });

  it('archiveThread removes the thread and sets activeThreadId to null', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    fetchMock.mockResolvedValueOnce(json(200, { messages: [MSG], next_cursor: null }));
    fetchMock.mockResolvedValueOnce(json(200, { thread_id: THREAD_ID, last_read_sequence: 1 }));
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));
    await act(async () => { await result.current.openThread(THREAD_ID); });
    await waitFor(() => expect(result.current.activeThreadId).toBe(THREAD_ID));

    fetchMock.mockResolvedValueOnce(json(200, {}));
    await act(async () => { await result.current.archiveThread(THREAD_ID); });

    await waitFor(() => expect(result.current.threads).toEqual([]));
    expect(result.current.activeThreadId).toBeNull();
  });

  it('archiveThread throws archive_failed on a 500', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));

    fetchMock.mockResolvedValueOnce(json(500, { error: { code: 'store_error' } }));
    await expect(result.current.archiveThread(THREAD_ID)).rejects.toThrow('archive_failed');
    expect(result.current.threads).toEqual([THREAD]);
  });

  it('editMessage replaces the cached message with the PATCH response', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    fetchMock.mockResolvedValueOnce(json(200, { messages: [MSG], next_cursor: null }));
    fetchMock.mockResolvedValueOnce(json(200, { thread_id: THREAD_ID, last_read_sequence: 1 }));
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));
    await act(async () => { await result.current.openThread(THREAD_ID); });
    await waitFor(() => expect(result.current.messagesState).toBe('ready'));

    const edited = { ...MSG, body: 'Hello there', revision: 2 };
    fetchMock.mockResolvedValueOnce(json(200, edited));
    let returned!: ThreadMessage;
    await act(async () => { returned = await result.current.editMessage(MSG.id, 'Hello there'); });

    expect(returned).toEqual(edited);
    await waitFor(() => expect(result.current.messages).toEqual([edited]));
  });

  it('editMessage throws edit_failed on a 500 and leaves the cache unchanged', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    fetchMock.mockResolvedValueOnce(json(200, { messages: [MSG], next_cursor: null }));
    fetchMock.mockResolvedValueOnce(json(200, { thread_id: THREAD_ID, last_read_sequence: 1 }));
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));
    await act(async () => { await result.current.openThread(THREAD_ID); });
    await waitFor(() => expect(result.current.messagesState).toBe('ready'));

    fetchMock.mockResolvedValueOnce(json(500, { error: { code: 'store_error' } }));
    await expect(result.current.editMessage(MSG.id, 'Hello there')).rejects.toThrow('edit_failed');
    expect(result.current.messages).toEqual([MSG]);
  });

  it('deleteMessage replaces the cached message with the tombstoned row', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    fetchMock.mockResolvedValueOnce(json(200, { messages: [MSG], next_cursor: null }));
    fetchMock.mockResolvedValueOnce(json(200, { thread_id: THREAD_ID, last_read_sequence: 1 }));
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));
    await act(async () => { await result.current.openThread(THREAD_ID); });
    await waitFor(() => expect(result.current.messagesState).toBe('ready'));

    const tombstoned = { ...MSG, body: '', tombstoned_at: 1756100000001, tombstoned_by: MSG.author_user_id };
    fetchMock.mockResolvedValueOnce(json(200, tombstoned));
    let returned!: ThreadMessage;
    await act(async () => { returned = await result.current.deleteMessage(MSG.id); });

    expect(returned).toEqual(tombstoned);
    await waitFor(() => expect(result.current.messages).toEqual([tombstoned]));
  });

  it('deleteMessage throws delete_failed on a 500 and leaves the cache unchanged', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    fetchMock.mockResolvedValueOnce(json(200, { messages: [MSG], next_cursor: null }));
    fetchMock.mockResolvedValueOnce(json(200, { thread_id: THREAD_ID, last_read_sequence: 1 }));
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));
    await act(async () => { await result.current.openThread(THREAD_ID); });
    await waitFor(() => expect(result.current.messagesState).toBe('ready'));

    fetchMock.mockResolvedValueOnce(json(500, { error: { code: 'store_error' } }));
    await expect(result.current.deleteMessage(MSG.id)).rejects.toThrow('delete_failed');
    expect(result.current.messages).toEqual([MSG]);
  });

  it('produces different query keys for different account ids', () => {
    expect(threadKeys.list('account-a', SPACE_ID)).not.toEqual(
      threadKeys.list('account-b', SPACE_ID),
    );
    expect(threadKeys.messages('account-a', THREAD_ID)).not.toEqual(
      threadKeys.messages('account-b', THREAD_ID),
    );
  });

  it('does not serve account A cached threads to account B for the same space', async () => {
    const THREAD_A: Thread = { ...THREAD, unread_count: 7 };
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD_A] }));
    const { result, rerender } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));
    expect(result.current.threads).toEqual([THREAD_A]);

    let release!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { release = resolve; }),
    );
    sessionState.accountId = 'account-b';
    rerender();
    await waitFor(() => expect(result.current.threadsState).toBe('loading'));
    expect(result.current.threads).toEqual([]);
    await act(async () => { release(json(200, { threads: [] })); });
  });

  it('does not fetch while there is no signed-in account', async () => {
    sessionState.accountId = null;
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('idle'));
    const calls = fetchMock.mock.calls.filter(
      ([input]) => input === `/api/spaces/${SPACE_ID}/threads`,
    );
    expect(calls).toHaveLength(0);
  });

  it('clears the previous account cached threads when the account changes', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    const { result, rerender } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));
    expect(queryClient.getQueryData(threadKeys.list('account-a', SPACE_ID))).toEqual([THREAD]);

    fetchMock.mockResolvedValueOnce(json(200, { threads: [] }));
    sessionState.accountId = 'account-b';
    rerender();
    await waitFor(() =>
      expect(queryClient.getQueryData(threadKeys.list('account-a', SPACE_ID))).toBeUndefined(),
    );
  });

  it('does not clear the cache when re-rendering with an unchanged account', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    const { result, rerender } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));

    rerender();
    await act(async () => { await Promise.resolve(); });
    expect(queryClient.getQueryData(threadKeys.list('account-a', SPACE_ID))).toEqual([THREAD]);
    const calls = fetchMock.mock.calls.filter(
      ([input]) => input === `/api/spaces/${SPACE_ID}/threads`,
    );
    expect(calls).toHaveLength(1);
  });

  // A PR review on #174 found this: the composer stays enabled while history is
  // still loading, so a send could cancel the initial GET, snapshot an empty
  // cache, and replace a whole thread with one message.
  it('does not wipe thread history when a post starts before the initial load lands', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    // Hold the initial messages GET open so the post begins with nothing cached.
    let releaseMessages!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { releaseMessages = resolve; }),
    );
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));
    act(() => { void result.current.openThread(THREAD_ID); });
    await waitFor(() => expect(result.current.messagesState).toBe('loading'));

    // read-marker, the POST, then the refetch onSettled triggers.
    fetchMock.mockResolvedValue(json(200, { messages: [MSG, SERVER_MSG], next_cursor: null }));
    let post!: Promise<ThreadMessage>;
    await act(async () => { post = result.current.postMessage('early'); });
    await act(async () => {
      releaseMessages(json(200, { messages: [MSG], next_cursor: null }));
      await post.catch(() => undefined);
    });

    // The history that arrived is still there -- the thread did not collapse to
    // the single message that was sent mid-load.
    await waitFor(() => {
      expect(result.current.messages.some((m) => m.id === MSG.id)).toBe(true);
    });
  });

  it('does not evict cached messages when a post fails with nothing snapshotted', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { threads: [THREAD] }));
    let releaseMessages!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { releaseMessages = resolve; }),
    );
    const { result } = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(result.current.threadsState).toBe('ready'));
    act(() => { void result.current.openThread(THREAD_ID); });
    await waitFor(() => expect(result.current.messagesState).toBe('loading'));

    // Only the message POST fails. Blanket-failing every later fetch would also
    // reject the unawaited read-marker call and surface as an unhandled rejection.
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/messages') && init?.method === 'POST'
        ? json(500, { error: { code: 'store_error' } })
        : json(200, { messages: [MSG], next_cursor: null }),
    );
    // Attach the rejection handler at creation: the POST fails synchronously
    // here, so a handler attached later races the rejection.
    let postError: unknown = null;
    await act(async () => {
      const settled = result.current
        .postMessage('doomed')
        .then(() => null as unknown, (error: unknown) => error);
      releaseMessages(json(200, { messages: [MSG], next_cursor: null }));
      postError = await settled;
    });
    expect((postError as Error | null)?.message).toBe('post_failed');

    // onError must not "restore" a snapshot it never took.
    await waitFor(() => {
      expect(result.current.messages.some((m) => m.id === MSG.id)).toBe(true);
    });
  });
});

describe('askBob', () => {
  const REPLY: ThreadMessage = {
    ...MSG,
    id: 'reply-1',
    author_user_id: null,
    body: 'Answer',
    sequence: 1,
  };

  function invocation(
    state: ThreadInvocation['state'],
    overrides: Partial<ThreadInvocation> = {},
  ): ThreadInvocation {
    return {
      id: 'inv-1',
      thread_id: THREAD_ID,
      space_id: SPACE_ID,
      state,
      result_message_id: null,
      error_code: null,
      ...overrides,
    };
  }

  function routeFetch(
    handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
  ): void {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`;
      const handler = handlers[key];
      if (!handler) throw new Error(`unhandled fetch: ${key}`);
      return handler(init);
    });
  }

  async function readyThread(): Promise<ReturnType<typeof renderHook<ReturnType<typeof useThreads>, unknown>>> {
    const rendered = renderHook(() => useThreads(SPACE_ID), { wrapper });
    await waitFor(() => expect(rendered.result.current.threadsState).toBe('ready'));
    await act(async () => { await rendered.result.current.openThread(THREAD_ID); });
    await waitFor(() => expect(rendered.result.current.messagesState).toBe('ready'));
    return rendered;
  }

  it.each([undefined, null, 'campaign-1'])('forwards exact explicit app targeting %s without a client Core flag', async (campaignId) => {
    let body: unknown;
    routeFetch({
      [`GET /api/spaces/${SPACE_ID}/threads`]: () => json(200, { threads: [THREAD] }),
      [`GET /api/threads/${THREAD_ID}/messages`]: () => json(200, { messages: [MSG], next_cursor: null }),
      [`PUT /api/threads/${THREAD_ID}/read`]: () => json(200, { thread_id: THREAD_ID, last_read_sequence: 1 }),
      [`POST /api/threads/${THREAD_ID}/invocations`]: (init) => { body = JSON.parse(String(init?.body)); return json(202, { invocation_id: 'inv-1' }); },
      'GET /api/invocations/inv-1': () => json(200, invocation('completed')),
    });
    const { result } = await readyThread();
    const appBinding = { installationId: 'installation', mode: 'run' as const, ...(campaignId === undefined ? {} : { campaignId }) };
    await act(async () => { await result.current.askBob(MSG, appBinding); });
    expect(body).toEqual({ trigger_message_id: MSG.id, appBinding });
  });

  it('posts the trigger id, reads the invocation and refetches the messages', async () => {
    let messagesCall = 0;
    let postBody: unknown = null;
    routeFetch({
      [`GET /api/spaces/${SPACE_ID}/threads`]: () => json(200, { threads: [THREAD] }),
      [`GET /api/threads/${THREAD_ID}/messages`]: () => {
        messagesCall += 1;
        return messagesCall === 1
          ? json(200, { messages: [MSG], next_cursor: null })
          : json(200, { messages: [MSG, REPLY], next_cursor: null });
      },
      [`PUT /api/threads/${THREAD_ID}/read`]: () =>
        json(200, { thread_id: THREAD_ID, last_read_sequence: 1 }),
      [`POST /api/threads/${THREAD_ID}/invocations`]: (init) => {
        postBody = init?.body ? JSON.parse(String(init.body)) : null;
        return json(202, { invocation_id: 'inv-1' });
      },
      'GET /api/invocations/inv-1': () =>
        json(200, invocation('completed', { result_message_id: REPLY.id })),
    });

    const { result } = await readyThread();
    expect(result.current.messages).toEqual([MSG]);

    let outcome!: Awaited<ReturnType<typeof result.current.askBob>>;
    await act(async () => { outcome = await result.current.askBob(MSG); });

    expect(outcome).toBe('answered');
    expect(postBody).toEqual({ trigger_message_id: MSG.id });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.messages[1].author_user_id).toBeNull();
  });

  it('maps 409 to busy without reading an invocation', async () => {
    routeFetch({
      [`GET /api/spaces/${SPACE_ID}/threads`]: () => json(200, { threads: [THREAD] }),
      [`GET /api/threads/${THREAD_ID}/messages`]: () =>
        json(200, { messages: [MSG], next_cursor: null }),
      [`PUT /api/threads/${THREAD_ID}/read`]: () =>
        json(200, { thread_id: THREAD_ID, last_read_sequence: 1 }),
      [`POST /api/threads/${THREAD_ID}/invocations`]: () =>
        json(409, { error: { code: 'conflict' } }),
    });

    const { result } = await readyThread();
    let outcome!: Awaited<ReturnType<typeof result.current.askBob>>;
    await act(async () => { outcome = await result.current.askBob(MSG); });

    expect(outcome).toBe('busy');
    const invocationCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith('/api/invocations/'),
    );
    expect(invocationCalls).toHaveLength(0);
  });

  it.each([
    { state: 'failed' as const, expected: 'failed' as const },
    { state: 'cancelled' as const, expected: 'cancelled' as const },
  ])('maps $state invocation to $expected', async ({ state, expected }) => {
    routeFetch({
      [`GET /api/spaces/${SPACE_ID}/threads`]: () => json(200, { threads: [THREAD] }),
      [`GET /api/threads/${THREAD_ID}/messages`]: () =>
        json(200, { messages: [MSG], next_cursor: null }),
      [`PUT /api/threads/${THREAD_ID}/read`]: () =>
        json(200, { thread_id: THREAD_ID, last_read_sequence: 1 }),
      [`POST /api/threads/${THREAD_ID}/invocations`]: () => json(202, { invocation_id: 'inv-1' }),
      'GET /api/invocations/inv-1': () => json(200, invocation(state)),
    });

    const { result } = await readyThread();
    let outcome!: Awaited<ReturnType<typeof result.current.askBob>>;
    await act(async () => { outcome = await result.current.askBob(MSG); });

    expect(outcome).toBe(expected);
  });

  it('throws invocation_failed on a 500', async () => {
    routeFetch({
      [`GET /api/spaces/${SPACE_ID}/threads`]: () => json(200, { threads: [THREAD] }),
      [`GET /api/threads/${THREAD_ID}/messages`]: () =>
        json(200, { messages: [MSG], next_cursor: null }),
      [`PUT /api/threads/${THREAD_ID}/read`]: () =>
        json(200, { thread_id: THREAD_ID, last_read_sequence: 1 }),
      [`POST /api/threads/${THREAD_ID}/invocations`]: () =>
        json(500, { error: { code: 'store_error' } }),
    });

    const { result } = await readyThread();
    await act(async () => {
      await expect(result.current.askBob(MSG)).rejects.toThrow('invocation_failed');
    });
  });

  it('waitForInvocation polls until terminal', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, invocation('running')))
      .mockResolvedValueOnce(json(200, invocation('running')))
      .mockResolvedValueOnce(json(200, invocation('completed')));
    const sleep = vi.fn(async () => undefined);

    const result = await waitForInvocation('inv-1', sleep);

    expect(result).toEqual(invocation('completed'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(INVOCATION_POLL_DELAY_MS);
  });

  it('waitForInvocation gives up after the poll budget', async () => {
    fetchMock.mockImplementation(async () => json(200, invocation('running')));
    const sleep = vi.fn(async () => undefined);

    const result = await waitForInvocation('inv-1', sleep);

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(INVOCATION_POLL_ATTEMPTS);
  });
});