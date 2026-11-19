import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONVERSATION = 'conv_0123456789abcdef0123456789abcdef';

// The tab session id is read once and kept in the module, so each test starts from a fresh module.
async function load(): Promise<typeof import('./ui-request-context')> {
  vi.resetModules();
  return import('./ui-request-context');
}

async function headersOf(path: string, context?: typeof import('./ui-request-context')): Promise<Headers> {
  const { uiRequestContext } = context ?? await load();
  window.history.pushState({}, '', path);
  return new Headers(uiRequestContext('/api/tasks', { headers: {} }).init?.headers);
}

describe('client correlation headers', () => {
  beforeEach(() => { sessionStorage.clear(); });
  afterEach(() => { window.history.pushState({}, '', '/'); });

  it('sends one random per-tab session id on every API request, stable within the tab', async () => {
    const context = await load();
    const first = (await headersOf('/today', context)).get('X-Bob-Client-Session');
    expect(first).toMatch(UUID);
    expect((await headersOf('/calendar', context)).get('X-Bob-Client-Session')).toBe(first);
    expect(sessionStorage.getItem('bob.client-session')).toBe(first);
    // A new tab (fresh module, empty sessionStorage) is a new session.
    sessionStorage.clear();
    expect((await load()).clientSessionId()).not.toBe(first);
  });

  it('keeps the id after the first read without touching sessionStorage again', async () => {
    const context = await load();
    const first = context.clientSessionId();
    const read = vi.spyOn(Storage.prototype, 'getItem');
    expect(context.clientSessionId()).toBe(first);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it('replaces a malformed stored session id instead of sending it', async () => {
    sessionStorage.setItem('bob.client-session', 'not-a-uuid');
    expect((await headersOf('/today')).get('X-Bob-Client-Session')).toMatch(UUID);
  });

  it('sends the open conversation, canonical, only while one is open', async () => {
    const context = await load();
    expect((await headersOf(`/c/${CONVERSATION}`, context)).get('X-Bob-Conversation')).toBe(CONVERSATION);
    expect((await headersOf('/c/cnv_0123456789abcdef0123456789abcdef', context)).get('X-Bob-Conversation')).toBe(CONVERSATION);
    expect((await headersOf(`/spaces/spc_1/threads/${CONVERSATION}`, context)).get('X-Bob-Conversation')).toBe(CONVERSATION);
    expect((await headersOf('/today', context)).has('X-Bob-Conversation')).toBe(false);
  });

  it('never invents a conversation from a path that is not one', async () => {
    const { openConversationId } = await load();
    expect(openConversationId('/c/not-an-id')).toBeNull();
    expect(openConversationId('/memory')).toBeNull();
  });
});
