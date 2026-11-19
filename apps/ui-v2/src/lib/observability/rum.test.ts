import { beforeEach, describe, expect, it, vi } from 'vitest';

const rum = vi.hoisted(() => ({
  init: vi.fn(),
  setUser: vi.fn(),
  clearUser: vi.fn(),
  setGlobalContextProperty: vi.fn(),
  removeGlobalContextProperty: vi.fn(),
  startSessionReplayRecording: vi.fn(),
}));
const logs = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('@openobserve/browser-rum', () => ({ openobserveRum: rum }));
vi.mock('@openobserve/browser-logs', () => ({ openobserveLogs: logs }));

import { endRum, resetRumForTests, startRum } from './rum';

const config = { clientToken: 'pub_ingest_token', site: 'watch2.heybob.xyz', org: 'default', service: 'bob-web' as const, env: 'production' as const, version: 'abc1234' };
const ids = { userId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222', conversationId: null };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetRumForTests();
  history.replaceState(null, '', '/');
});

describe('startRum', () => {
  it('exports bounded views and drops resource, error and log payloads across navigation', () => {
    startRum(config, ids);
    const filter = rum.init.mock.calls[0]?.[0].beforeSend as (event: object) => boolean;
    const logFilter = logs.init.mock.calls[0]?.[0].beforeSend as (event: object) => boolean;
    for (const path of ['/join-chat/private-token', '/invite/private-token', '/groups/private-id']) {
      const event = { type: 'view', view: { url: `https://example.test${path}?secret=private-query`, name: 'private-token', referrer: 'https://example.test/private-referrer', performance: { lcp: { resource_url: 'https://example.test/private-image' } } } };
      expect(filter(event)).toBe(true);
      expect(JSON.stringify(event)).not.toContain('private-');
      expect(JSON.stringify(event)).not.toContain('https://');
      expect(event.view.url).toBe(path.startsWith('/groups') ? '/groups/:chatId' : path.startsWith('/join-chat') ? '/join-chat/:token' : '/invite/:token');
    }
    expect(filter({ type: 'resource', resource: { url: '/api/group-chats/invitations/private-token' } })).toBe(false);
    history.replaceState(null, '', '/join-chat/private-token');
    expect(filter({ type: 'error', error: { message: 'private-token', stack: 'private-token' } })).toBe(false);
    expect(logFilter({ message: 'private-token', view: { url: '/join-chat/private-token' } })).toBe(false);
    history.replaceState(null, '', '/');
    expect(filter({ type: 'error', view: { url: '/', referrer: '/join-chat/private-token' }, error: { message: 'private-token' } })).toBe(false);
    expect(logFilter({ message: 'request failed: /api/invitations/private-token' })).toBe(false);
    expect(logFilter({ message: 'request failed: %2Fapi%2Fgroup-chats%2Finvitations%2Fprivate-token' })).toBe(false);
    expect(filter({ type: 'resource', view: { url: '/join-chat/private-token' }, resource: { url: '/api/config' } })).toBe(false);
  });
  it('retains unrelated monitoring before and after SPA invitation navigation', () => {
    startRum(config, ids);
    const filter = rum.init.mock.calls[0]?.[0].beforeSend as (event: object) => boolean;
    const logFilter = logs.init.mock.calls[0]?.[0].beforeSend as (event: object) => boolean;
    for (const path of ['/', '/join-chat/private-token', '/settings']) {
      history.replaceState(null, '', path);
      for (const type of ['resource', 'error', 'action', 'long_task']) {
        const event = { type, view: { url: 'https://example.test/settings', referrer: '' }, resource: { url: '/api/config', status_code: 200 }, error: { message: 'ordinary failure' } };
        expect(filter(event)).toBe(path !== '/join-chat/private-token');
        expect(event.resource).toEqual({ url: '/api/config', status_code: 200 });
        expect(event.error.message).toBe('ordinary failure');
      }
      expect(logFilter({ message: 'ordinary failure', view: { url: '/settings' } })).toBe(path !== '/join-chat/private-token');
    }
  });
  it('uses the frontend release for both SDKs when the API release differs', () => {
    vi.stubEnv('BOB_WEB_RELEASE', 'fedcba9');
    startRum(config, ids);
    expect(rum.init.mock.calls[0]?.[0]).toMatchObject({ version: 'fedcba9' });
    expect(logs.init.mock.calls[0]?.[0]).toMatchObject({ version: 'fedcba9' });
  });
  it('does nothing without config', () => {
    expect(() => startRum(undefined, ids)).not.toThrow();
    expect(rum.init).not.toHaveBeenCalled();
    expect(logs.init).not.toHaveBeenCalled();
  });

  it('initialises once with masked, replay-free, self-tracing-free options', () => {
    startRum(config, ids);
    startRum(config, ids);
    expect(rum.init).toHaveBeenCalledTimes(1);
    expect(rum.init).toHaveBeenCalledWith({
      beforeSend: expect.any(Function),
      applicationId: 'bob-web',
      clientToken: 'pub_ingest_token',
      site: 'watch2.heybob.xyz',
      organizationIdentifier: 'default',
      service: 'bob-web',
      env: 'production',
      version: 'abc1234',
      insecureHTTP: false,
      apiVersion: 'v1',
      trackResources: true,
      trackLongTasks: true,
      trackUserInteractions: true,
      defaultPrivacyLevel: 'mask',
      sessionSampleRate: 100,
      sessionReplaySampleRate: 0,
    });
    expect(rum.init.mock.calls[0]?.[0]).not.toHaveProperty('allowedTracingUrls');
    expect(rum.startSessionReplayRecording).not.toHaveBeenCalled();
  });

  it('forwards only console errors and uncaught errors to logs', () => {
    startRum(config, ids);
    expect(logs.init).toHaveBeenCalledTimes(1);
    expect(logs.init.mock.calls[0]?.[0]).toMatchObject({ forwardErrorsToLogs: true, forwardConsoleLogs: ['error'], clientToken: 'pub_ingest_token', organizationIdentifier: 'default', insecureHTTP: false });
  });

  it('sets the user id only and the tab session and conversation as global context', () => {
    startRum(config, { ...ids, conversationId: 'conversation_abc' });
    expect(rum.setUser).toHaveBeenCalledWith({ id: ids.userId });
    expect(rum.setGlobalContextProperty).toHaveBeenCalledWith('session_id', ids.sessionId);
    expect(rum.setGlobalContextProperty).toHaveBeenCalledWith('conversation_id', 'conversation_abc');
  });

  it('keeps conversation_id current and drops it when no conversation is open', () => {
    const handle = startRum(config, ids);
    handle.setConversation('conversation_next');
    expect(rum.setGlobalContextProperty).toHaveBeenLastCalledWith('conversation_id', 'conversation_next');
    handle.setConversation(null);
    expect(rum.removeGlobalContextProperty).toHaveBeenLastCalledWith('conversation_id');
  });

  it('clears the user on endRum', () => {
    startRum(config, ids);
    endRum();
    expect(rum.clearUser).toHaveBeenCalledTimes(1);
  });

  it('never throws when the SDK does', () => {
    rum.init.mockImplementationOnce(() => { throw new Error('sdk down'); });
    expect(() => startRum(config, ids).setConversation('conversation_x')).not.toThrow();
    rum.setUser.mockImplementationOnce(() => { throw new Error('sdk down'); });
    expect(() => { startRum(config, ids); endRum(); }).not.toThrow();
  });
});
