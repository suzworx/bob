import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installUiObservability } from './ui-observability';
import { observeUiAction } from './ui-actions';

describe('UI metadata instrumentation', () => {
  const fetcher = vi.fn<typeof fetch>();
  let stop: (() => void) | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    history.replaceState({}, '', '/');
    fetcher.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
  });
  afterEach(() => { stop?.(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.innerHTML = ''; });
  function start(): ReturnType<typeof installUiObservability> {
    const observer = installUiObservability(() => 'secret-token');
    stop = observer.dispose;
    return observer;
  }
  function batches(): unknown[] {
    return fetcher.mock.calls.filter(([url, init]) => url === '/api/telemetry' && init?.body)
      .flatMap(([, init]) => (JSON.parse(String(init?.body)) as { events: unknown[] }).events);
  }
  function details(): unknown[] {
    return batches().filter((event) => (event as { event: string }).event !== 'ui_metrics_window');
  }
  it('joins source actions and first-party requests while distinguishing normalized routes', async () => {
    start();
    history.pushState({}, '', '/spaces/private-space/tasks');
    window.dispatchEvent(new Event('bob:routechange'));
    const action = 'app.app.session-gate.button.back-to-home.click';
    await observeUiAction(action, () => fetch('/api/tasks/private-task'))();
    await vi.advanceTimersByTimeAsync(5000);
    const events = batches() as Array<Record<string, unknown>>;
    const interaction = events.find((event) => event.event === 'ui_action' && event.stage === 'start');
    expect(interaction).toMatchObject({ action, route: '/spaces/:spaceId/tasks' });
    expect(events).toContainEqual(expect.objectContaining({ event: 'ui_action', action_id: interaction?.action_id, stage: 'complete', outcome: 'resolved' }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'ui_request', action_id: interaction?.action_id, request_id: expect.any(String) }));
    const request = fetcher.mock.calls.find(([url]) => url === '/api/tasks/private-task');
    expect(new Headers(request?.[1]?.headers).get('X-Bob-Ui-Action-Id')).toBe(interaction?.action_id);
    expect(JSON.stringify(events)).not.toContain('private-');
  });
  it('reports failed sign-in callbacks through the restricted anonymous lane without account credentials', async () => {
    const observer = installUiObservability(() => null, { anonymous: true });
    stop = observer.dispose;
    const action = 'account.sign-in.dev-sign-in.button.dev-sign-in-local-only.click-action';
    await expect(observeUiAction(action, async () => { throw new Error('private-password'); })()).rejects.toThrow();
    observeUiAction('app.app.session-gate.button.back-to-home.click', () => undefined)();
    observer.render('mount', 10);
    await vi.advanceTimersByTimeAsync(5000);
    const calls = fetcher.mock.calls.filter(([url]) => url === '/api/telemetry/anonymous');
    expect(calls).toHaveLength(1);
    const [, init] = calls[0] ?? [];
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    const events = (JSON.parse(String(init?.body)) as { events: unknown[] }).events;
    expect(events).toContainEqual(expect.objectContaining({ event: 'ui_action', page: 'signin', action, stage: 'complete', outcome: 'error' }));
    expect(JSON.stringify(events)).not.toMatch(/private-password|back-to-home|ui_render/);
  });
  it('counts every text edit without exhausting the capacity for a submit callback', async () => {
    start();
    const edit = 'account.sign-in.ready-sign-in.text-input.email.change';
    const change = observeUiAction(edit, (_value: string) => undefined);
    for (let i = 0; i < 1000; i++) change('private-email-value');
    const action = 'app.app.session-gate.button.back-to-home.click';
    observeUiAction(action, () => undefined)();
    await vi.advanceTimersByTimeAsync(5000);
    expect(batches()).toContainEqual(expect.objectContaining({ event: 'ui_edit', action: edit, invocations: 1000, failed_invocations: 0, aborted_invocations: 0 }));
    expect(batches()).toContainEqual(expect.objectContaining({ event: 'ui_action', action, stage: 'complete' }));
    expect(JSON.stringify(batches())).not.toContain('private-email-value');
    expect(details()).toHaveLength(4);
  });
  it('summarizes keyboard and drag activity while preserving nested submit and request details', async () => {
    start();
    const keyboard = 'chat.composer.composer.chat-composer-input.send-images-on-enter.key-down';
    const drag = 'chat.composer.composer.chat-composer.can-attach.drag-over';
    const submit = observeUiAction('app.app.session-gate.button.back-to-home.click', () => fetch('/api/chat', { method: 'POST' }));
    const keydown = observeUiAction(keyboard, (send: boolean) => send ? submit() : undefined);
    const dragover = observeUiAction(drag, () => undefined);
    for (let i = 0; i < 1000; i++) { keydown(false); dragover(); }
    await keydown(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(batches()).toContainEqual(expect.objectContaining({ event: 'ui_activity', action: keyboard, invocations: 1001 }));
    expect(batches()).toContainEqual(expect.objectContaining({ event: 'ui_activity', action: drag, invocations: 1000 }));
    expect(batches()).toContainEqual(expect.objectContaining({ event: 'ui_action', action: 'app.app.session-gate.button.back-to-home.click', stage: 'complete' }));
    expect(batches()).toContainEqual(expect.objectContaining({ event: 'ui_request', endpoint: '/api/chat' }));
  });
  it.each(['missing', 'throwing'])('is a no-op when secure UUID generation is %s', (mode) => {
    vi.stubGlobal('crypto', mode === 'missing' ? {} : { randomUUID: () => { throw new Error('unavailable'); } });
    expect(() => start()).not.toThrow();
    expect(fetch).toBe(fetcher);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('disables collection without throwing if UUID generation fails during navigation', async () => {
    start();
    vi.stubGlobal('crypto', { randomUUID: () => { throw new Error('unavailable'); } });
    expect(() => window.dispatchEvent(new Event('popstate'))).not.toThrow();
    expect(fetch).toBe(fetcher);
    await vi.advanceTimersByTimeAsync(5000);
    expect(batches()).toHaveLength(0);
  });
  it('records only bounded categories and never URLs, DOM text, tokens, bodies or IDs', async () => {
    start();
    history.pushState({}, '', '/spaces/private-id?token=private-query');
    window.dispatchEvent(new Event('bob:routechange'));
    document.body.innerHTML = '<button id="private-id">private-text</button>';
    document.querySelector('button')?.click();
    await fetch('/api/spaces/private-id?token=private-query', { method: 'POST', body: 'private-body' });
    await vi.advanceTimersByTimeAsync(5000);
    const events = batches();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'ui_navigation', page: 'spaces' }),
      expect.objectContaining({ event: 'ui_interaction', target: 'button' }),
      expect.objectContaining({ event: 'ui_request', area: 'spaces', method: 'POST', status: 204, outcome: 'ok' }),
    ]));
    expect(JSON.stringify(events)).not.toMatch(/private-|secret-token|https?:/);
  });
  it('preserves Request input, options, response streaming, original failures and aborts', async () => {
    start();
    const request = new Request(`${location.origin}/api/chat`, { method: 'POST', body: 'secret' });
    const response = new Response('stream');
    fetcher.mockResolvedValueOnce(response);
    const result = await fetch(request);
    expect(result).toBe(response);
    expect(result.bodyUsed).toBe(false);
    expect(fetcher).toHaveBeenCalledWith(request, { headers: expect.any(Headers) });
    expect(request.bodyUsed).toBe(false);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has('X-Bob-Ui-Request-Id')).toBe(true);
    const error = new DOMException('private-error', 'AbortError');
    fetcher.mockRejectedValueOnce(error);
    await expect(fetch('/api/chat')).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(batches()).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'aborted', status: 0 })]));
  });
  it('excludes external fetches and its own transport without recursion', async () => {
    start();
    for (const path of ['/api/telemetry', '/api/telemetry/anonymous', 'https://external.test/api/chat']) await fetch(path);
    await vi.advanceTimersByTimeAsync(15000);
    expect(batches().filter((event) => (event as { event: string }).event === 'ui_request')).toHaveLength(0);
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/telemetry')).toHaveLength(2);
  });
  it('records public configuration and local sign-in requests using fixed endpoint labels only', async () => {
    start();
    await fetch('/api/public-config?private-secret');
    await fetch('/api/test-token', { method: 'POST', body: 'private-user-id' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(batches()).toContainEqual(expect.objectContaining({ event: 'ui_request', method: 'GET', endpoint: '/api/public-config' }));
    expect(batches()).toContainEqual(expect.objectContaining({ event: 'ui_request', method: 'POST', endpoint: '/api/test-token' }));
    expect(JSON.stringify(batches())).not.toContain('private-');
  });
  it('caps batches, rate and clears timers, listeners and pending events on disposal', async () => {
    const observer = start();
    for (let i = 0; i < 150; i++) observer.render('update', 1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(details()).toHaveLength(21);
    observer.render('update', 1);
    observer.dispose();
    expect(fetch).toBe(fetcher);
    window.dispatchEvent(new Event('popstate'));
    await vi.advanceTimersByTimeAsync(60000);
    expect(details()).toHaveLength(21);
  });
  it('keeps in-flight requests on their starting view and records network failures without error text', async () => {
    start();
    let finish: (response: Response) => void = () => undefined;
    fetcher.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = fetch('/api/conversations/secret');
    history.pushState({}, '', '/devices/private-device');
    window.dispatchEvent(new Event('popstate'));
    finish(new Response(null, { status: 503 }));
    await pending;
    fetcher.mockRejectedValueOnce(new Error('private-error'));
    await expect(fetch('/api/memory')).rejects.toThrow('private-error');
    await vi.advanceTimersByTimeAsync(5000);
    const events = batches() as Array<{ event: string; view_id: string; page: string; outcome?: string }>;
    expect(events[0]?.view_id).toBe(events.find((event) => event.event === 'ui_request')?.view_id);
    expect(events.find((event) => event.page === 'devices')?.view_id).not.toBe(events[0]?.view_id);
    expect(events.filter((event) => event.outcome === 'error')).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('private-');
  });
  it('limits accepted events to 100 per minute, resumes next minute and drops failed sends', async () => {
    const observer = start();
    for (let batch = 0; batch < 6; batch++) {
      for (let i = 0; i < 20; i++) document.dispatchEvent(new MouseEvent('click'));
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(details()).toHaveLength(100);
    await vi.advanceTimersByTimeAsync(30000);
    observer.render('update', 2);
    fetcher.mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(details()).toHaveLength(101);
    await vi.advanceTimersByTimeAsync(10000);
    expect(details()).toHaveLength(101);
  });
  it('flushes on hide and discards late requests and the queue after sign-out', async () => {
    const observer = start();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(details()).toHaveLength(1);
    let finish: (response: Response) => void = () => undefined;
    fetcher.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = fetch('/api/chat');
    observer.render('update', 1);
    observer.dispose();
    finish(new Response(null, { status: 204 }));
    await pending;
    await vi.advanceTimersByTimeAsync(10000);
    expect(details()).toHaveLength(1);
    vi.restoreAllMocks();
  });
  it('flushes on pagehide and contains synchronous transport and token failures', async () => {
    start();
    fetcher.mockImplementationOnce(() => { throw new Error('offline'); });
    expect(() => window.dispatchEvent(new Event('pagehide'))).not.toThrow();
    stop?.();
    const observer = installUiObservability(() => { throw new Error('unavailable'); });
    stop = observer.dispose;
    await expect(vi.advanceTimersByTimeAsync(5000)).resolves.toBeDefined();
    expect(details()).toHaveLength(1);
  });
  it.each([
    ['speech', 'voice'], ['transcribe', 'voice'], ['threads', 'conversations'],
    ['invocations', 'conversations'], ['tasks', 'productivity'], ['notes', 'productivity'],
    ['events', 'productivity'], ['reminders', 'productivity'], ['timers', 'productivity'],
  ])('categorizes /api/%s as %s', async (path, area) => {
    start();
    await fetch(`/api/${path}/private-id`);
    await vi.advanceTimersByTimeAsync(5000);
    expect(batches()).toContainEqual(expect.objectContaining({ event: 'ui_request', area }));
  });
});
