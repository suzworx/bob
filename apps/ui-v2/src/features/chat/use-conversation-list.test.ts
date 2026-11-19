import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { fetchConversations, useConversationList } from './use-conversation-list';

type Row = { id: string; title: string; createdAt: number; updatedAt: number };

const row = (id: string, title: string): Row => ({ id, title, createdAt: 1, updatedAt: 1 });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[];

function record(input: RequestInfo | URL, init?: RequestInit): Call {
  const headers = new Headers(init?.headers);
  const call = {
    url: String(input),
    method: (init?.method ?? 'GET').toUpperCase(),
    headers: Object.fromEntries(headers.entries()),
    body: init?.body,
  };
  calls.push(call);
  return call;
}

// Every request is answered at once by `handler`.
function stubFetch(handler: (call: Call) => Response): void {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(record(input, init))));
}

// Every request waits until the test answers it, so responses can arrive in any order.
const waiting = new Map<string, Array<(response: Response) => void>>();

function holdRequests(): void {
  calls = [];
  waiting.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          const { url } = record(input, init);
          waiting.set(url, [...(waiting.get(url) ?? []), resolve]);
        }),
    ),
  );
}

async function answer(url: string, rows: Row[] | number): Promise<void> {
  await waitFor(() => expect(waiting.get(url)?.length ?? 0).toBeGreaterThan(0));
  const resolve = waiting.get(url)?.shift();
  resolve?.(typeof rows === 'number' ? new Response(null, { status: rows }) : json({ conversations: rows }));
}

// Lets an answer already given finish being applied (or dropped).
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const titles = (list: { conversations: Row[] }): string[] => list.conversations.map((c) => c.title);

describe('useConversationList', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('loads the list on mount', async () => {
    stubFetch(() => json({ conversations: [row('c1', 'Trip plan')] }));
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(titles(result.current)).toEqual(['Trip plan']);
    expect(calls.map((call) => call.url)).toEqual(['/api/conversations']);
  });

  it('says empty for no conversations, and failed only for a bad response', async () => {
    let status = 200;
    let body: Row[] = [];
    stubFetch(() => (status === 200 ? json({ conversations: body }) : new Response(null, { status })));
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.state).toBe('empty'));
    expect(result.current.failure).toBe(false);

    status = 500;
    await act(() => result.current.reload());
    expect(result.current.state).toBe('failed');
    expect(result.current.failure).toBe(true);

    status = 200;
    body = [row('c1', 'Trip plan')];
    await act(() => result.current.reload());
    expect(result.current.state).toBe('ready');
    expect(result.current.failure).toBe(false);
  });

  it('keeps the newest load when a slower earlier one answers last, even with a failure', async () => {
    holdRequests();
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => void result.current.reload());
    await waitFor(() => expect(calls).toHaveLength(2));

    // The reload (sent last) answers first; the mount load's later answer is dropped.
    waiting.get('/api/conversations')?.pop()?.(json({ conversations: [row('c2', 'Newest')] }));
    await waitFor(() => expect(titles(result.current)).toEqual(['Newest']));
    await answer('/api/conversations', 500);
    await settle();
    expect(titles(result.current)).toEqual(['Newest']);
    expect(result.current.state).toBe('ready');
    expect(result.current.failure).toBe(false);
  });

  it('reload() ignores whatever it is handed, so an event handler can take it as is', async () => {
    stubFetch(() => json({ conversations: [] }));
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.state).toBe('empty'));
    expect(result.current.reload).toHaveLength(0);

    const asHandler = result.current.reload as unknown as (event: unknown) => Promise<void>;
    await act(() => asHandler({ type: 'click' }));
    expect(calls.map((call) => call.url)).toEqual(['/api/conversations', '/api/conversations']);
  });

  describe('fetchConversations', () => {
    it('encodes the query, adds archived=1 when asked, and passes the abort signal on', async () => {
      stubFetch(() => json({ conversations: [row('c1', 'Trip plan')] }));
      const controller = new AbortController();
      const signals: Array<AbortSignal | null | undefined> = [];
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        record(input, init);
        signals.push(init?.signal);
        return json({ conversations: [row('c1', 'Trip plan')] });
      });

      expect(titles({ conversations: await fetchConversations() })).toEqual(['Trip plan']);
      await fetchConversations({ query: 'a b&c', signal: controller.signal });
      await fetchConversations({ query: 'trip', archived: true });
      await fetchConversations({ archived: true });
      expect(calls.map((call) => call.url)).toEqual([
        '/api/conversations',
        '/api/conversations?q=a%20b%26c',
        '/api/conversations?q=trip&archived=1',
        '/api/conversations?archived=1',
      ]);
      expect(signals[1]).toBe(controller.signal);
    });

    it('rejects on a bad response', async () => {
      stubFetch(() => new Response(null, { status: 500 }));
      await expect(fetchConversations({ query: 'x' })).rejects.toThrow('list_failed');
    });
  });

  describe('rename', () => {
    const patches = (): Call[] => calls.filter((call) => call.method === 'PATCH');

    it('sends the trimmed title, with expectedUpdatedAt only when given', async () => {
      stubFetch((call) => (call.method === 'GET' ? json({ conversations: [] }) : json({})));
      const { result } = renderHook(() => useConversationList());
      await waitFor(() => expect(result.current.state).toBe('empty'));

      await result.current.rename('c1', '  New title  ', 42);
      expect(patches()[0]?.url).toBe('/api/conversations/c1');
      expect(JSON.parse(String(patches()[0]?.body))).toEqual({ title: 'New title', expectedUpdatedAt: 42 });

      await result.current.rename('c1', 'x'.repeat(200));
      expect(JSON.parse(String(patches()[1]?.body))).toEqual({ title: 'x'.repeat(200) });
    });

    it('rejects an empty or over-long title without asking the server', async () => {
      stubFetch(() => json({ conversations: [] }));
      const { result } = renderHook(() => useConversationList());
      await waitFor(() => expect(result.current.state).toBe('empty'));
      await expect(result.current.rename('c1', '   ')).rejects.toThrow('invalid_title');
      await expect(result.current.rename('c1', 'x'.repeat(201))).rejects.toThrow('invalid_title');
      expect(patches()).toHaveLength(0);
    });

    it('reads 409 as a conflict and any other failure as a failed rename', async () => {
      let status = 409;
      stubFetch((call) => (call.method === 'GET' ? json({ conversations: [] }) : new Response(null, { status })));
      const { result } = renderHook(() => useConversationList());
      await waitFor(() => expect(result.current.state).toBe('empty'));
      await expect(result.current.rename('c1', 'New')).rejects.toThrow('conflict');
      status = 500;
      await expect(result.current.rename('c1', 'New')).rejects.toThrow('rename_failed');
    });
  });

  describe('remove', () => {
    let status: number;
    const deletes = (): Call[] => calls.filter((call) => call.method === 'DELETE');

    async function mounted(): Promise<ReturnType<typeof renderHook<ReturnType<typeof useConversationList>, void>>> {
      status = 204;
      stubFetch((call) => (call.method === 'GET' ? json({ conversations: [] }) : new Response(null, { status })));
      const rendered = renderHook(() => useConversationList());
      await waitFor(() => expect(rendered.result.current.state).toBe('empty'));
      return rendered;
    }

    it('deletes, sending the expected version only when given', async () => {
      const { result } = await mounted();
      await result.current.remove('c1');
      await result.current.remove('c2', 42);
      expect(deletes().map((call) => call.url)).toEqual(['/api/conversations/c1', '/api/conversations/c2']);
      expect(deletes()[0]?.headers['x-bob-expected-updated-at']).toBeUndefined();
      expect(deletes()[1]?.headers['x-bob-expected-updated-at']).toBe('42');
    });

    it('treats a conversation that is already gone as deleted', async () => {
      const { result } = await mounted();
      status = 404;
      await expect(result.current.remove('c1')).resolves.toBeUndefined();
    });

    it('reads 409 as a conflict and any other failure as a failed delete', async () => {
      const { result } = await mounted();
      status = 409;
      await expect(result.current.remove('c1')).rejects.toThrow('conflict');
      status = 500;
      await expect(result.current.remove('c1')).rejects.toThrow('delete_failed');
    });
  });

  describe('archived option', () => {
    it('requests archived=1, on mount and on reload', async () => {
      stubFetch(() => json({ conversations: [] }));
      const { result } = renderHook(() => useConversationList({ archived: true }));
      await waitFor(() => expect(result.current.state).toBe('empty'));
      await act(() => result.current.reload());
      expect(calls.map((call) => call.url)).toEqual(['/api/conversations?archived=1', '/api/conversations?archived=1']);
    });
  });

  describe('setPinned / setArchived', () => {
    const patches = (): Call[] => calls.filter((call) => call.method === 'PATCH');

    it('PATCHes the flag with a json content-type', async () => {
      let status = 200;
      stubFetch((call) => (call.method === 'GET' ? json({ conversations: [] }) : new Response(null, { status })));
      const { result } = renderHook(() => useConversationList());
      await waitFor(() => expect(result.current.state).toBe('empty'));

      await result.current.setPinned('c1', true);
      expect(patches()[0]?.url).toBe('/api/conversations/c1');
      expect(patches()[0]?.headers['content-type']).toBe('application/json');
      expect(JSON.parse(String(patches()[0]?.body))).toEqual({ pinned: true });

      await result.current.setArchived('c1', false);
      expect(JSON.parse(String(patches()[1]?.body))).toEqual({ archived: false });
    });

    it('rejects on a non-2xx response', async () => {
      let status = 200;
      stubFetch((call) => (call.method === 'GET' ? json({ conversations: [] }) : new Response(null, { status })));
      const { result } = renderHook(() => useConversationList());
      await waitFor(() => expect(result.current.state).toBe('empty'));

      status = 503;
      await expect(result.current.setPinned('c1', true)).rejects.toThrow('pin_failed');
      status = 500;
      await expect(result.current.setArchived('c1', true)).rejects.toThrow('archive_failed');
    });
  });

  it('opens one conversation, and says so when it cannot', async () => {
    let status = 200;
    const detail = { id: 'c1', title: 'Trip plan', createdAt: 1, updatedAt: 1, messages: [] };
    stubFetch((call) => {
      if (call.url === '/api/conversations') return json({ conversations: [] });
      return status === 200 ? json(detail) : new Response(null, { status });
    });
    const { result } = renderHook(() => useConversationList());
    await waitFor(() => expect(result.current.state).toBe('empty'));
    await expect(result.current.openConversation('c1')).resolves.toEqual(detail);
    expect(calls.at(-1)?.url).toBe('/api/conversations/c1');
    status = 404;
    await expect(result.current.openConversation('c1')).rejects.toThrow('open_failed');
  });
});
