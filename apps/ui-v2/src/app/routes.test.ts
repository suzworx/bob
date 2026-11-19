import { describe, expect, it } from 'vitest';
import { afterEach } from 'vitest';
import {
  conversationIdFromLocation,
  conversationPath,
  devicePath,
  groupChatPath,
  groupChatInvitePath,
  legacyRedirect,
  navigateTo,
  NEW_THREAD,
  replaceLegacyLocation,
  resourcePath,
  routeFromPath,
  spacePath,
} from './routes';

it('restores each Insights category and the routines destination directly from its URL', () => {
  for (const category of ['future', 'reflections', 'past']) {
    expect(routeFromPath(`/insights/${category}`)).toEqual({ kind: 'insights', category });
  }
  expect(routeFromPath('/insights')).toEqual({ kind: 'insights', category: 'future' });
  expect(routeFromPath('/routines')).toEqual({ kind: 'routines' });
  expect(routeFromPath('/timeline')).toEqual({ kind: 'timeline' });
  expect(routeFromPath('/tools')).toEqual({ kind: 'tools' });
});

it('opens an API shared-app link with its raw space UUID and selected app intact', () => {
  const spaceId = '11111111-1111-4111-8111-111111111111';
  const appId = '22222222-2222-4222-8222-222222222222';
  const link = new URL(`/spaces/${spaceId}/apps?app=${appId}`, 'https://app.heybob.xyz');
  expect(routeFromPath(link.pathname)).toEqual({ kind: 'spaces', spaceId, section: 'apps', threadId: null });
  expect(link.searchParams.get('app')).toBe(appId);
});

describe('conversationIdFromLocation', () => {
  it('reads the id from /c/<id>', () => {
    expect(conversationIdFromLocation('/c/abc')).toBe('abc');
  });

  it('decodes a percent-encoded id', () => {
    expect(conversationIdFromLocation('/c/a%20b')).toBe('a b');
  });

  it('returns null for malformed percent-encoding instead of throwing', () => {
    expect(conversationIdFromLocation('/c/%')).toBeNull();
  });

  it('returns null for the root', () => {
    expect(conversationIdFromLocation('/')).toBeNull();
  });

  it('returns null for a path with more than one segment after /c/', () => {
    expect(conversationIdFromLocation('/c/a/b')).toBeNull();
  });
});

describe('conversationPath', () => {
  it('is / for a new chat', () => {
    expect(conversationPath(null)).toBe('/');
  });

  it('encodes the id into /c/<id>', () => {
    expect(conversationPath('a b')).toBe('/c/a%20b');
  });
});

describe('routeFromPath', () => {
  it.each([
    ['/today', 'today'],
    ['/calendar', 'calendar'],
    ['/memory', 'memory'],
    ['/devices/pair', 'pair'],
    ['/reset', 'reset'],
    ['/settings', 'settings'],
    ['/integrations', 'integrations'],
    ['/admin', 'admin'],
  ])('maps %s to the %s route', (path, kind) => {
    expect(routeFromPath(path)).toEqual({ kind });
  });

  it('maps /devices to the device list and /devices/<id> to that device', () => {
    expect(routeFromPath('/devices')).toEqual({ kind: 'devices', deviceId: null });
    expect(routeFromPath('/devices/dev_1')).toEqual({ kind: 'devices', deviceId: 'dev_1' });
    expect(routeFromPath('/devices/a%20b')).toEqual({ kind: 'devices', deviceId: 'a b' });
  });

  it('treats malformed percent-encoding in a device id as the list', () => {
    expect(routeFromPath('/devices/%')).toEqual({ kind: 'devices', deviceId: null });
  });

  it('builds /devices and /devices/<id>, round-tripping through routeFromPath', () => {
    expect(devicePath(null)).toBe('/devices');
    expect(devicePath('a b')).toBe('/devices/a%20b');
    expect(routeFromPath(devicePath('a b'))).toEqual({ kind: 'devices', deviceId: 'a b' });
  });

  it('maps /invite/<token> to an invite carrying the token', () => {
    expect(routeFromPath('/invite/abc')).toEqual({ kind: 'invite', token: 'abc' });
  });

  it('decodes a percent-encoded invite token', () => {
    expect(routeFromPath('/invite/a%20b')).toEqual({ kind: 'invite', token: 'a b' });
  });

  it('falls back to the chat for malformed percent-encoding in an invite token', () => {
    expect(routeFromPath('/invite/%')).toEqual({ kind: 'chat', conversationId: null });
  });

  it('falls back to the chat for /invite without a token or with extra segments', () => {
    expect(routeFromPath('/invite')).toEqual({ kind: 'chat', conversationId: null });
    expect(routeFromPath('/invite/')).toEqual({ kind: 'chat', conversationId: null });
    expect(routeFromPath('/invite/a/b')).toEqual({ kind: 'chat', conversationId: null });
  });

  it('maps /c/<id> to the chat with that conversation', () => {
    expect(routeFromPath('/c/abc')).toEqual({ kind: 'chat', conversationId: 'abc' });
  });

  it('maps the root to a new chat', () => {
    expect(routeFromPath('/')).toEqual({ kind: 'chat', conversationId: null });
  });

  it('maps anything else to a new chat', () => {
    expect(routeFromPath('/nowhere')).toEqual({ kind: 'chat', conversationId: null });
    expect(routeFromPath('/family/extra')).toEqual({ kind: 'chat', conversationId: null });
  });
});

describe('routeFromPath: /spaces', () => {
  it('maps /spaces to the default spaces route', () => {
    expect(routeFromPath('/spaces')).toEqual({ kind: 'spaces', spaceId: null, section: 'threads', threadId: null });
  });

  it('maps /spaces/<space> to that space, threads, no thread', () => {
    expect(routeFromPath('/spaces/spc_1')).toEqual({
      kind: 'spaces',
      spaceId: 'spc_1',
      section: 'threads',
      threadId: null,
    });
  });

  it('maps /spaces/<space>/<section> to that section', () => {
    expect(routeFromPath('/spaces/spc_1/tasks')).toEqual({
      kind: 'spaces',
      spaceId: 'spc_1',
      section: 'tasks',
      threadId: null,
    });
  });

  it('maps /spaces/<space>/threads/<thread> to that thread', () => {
    expect(routeFromPath('/spaces/spc_1/threads/t1')).toEqual({
      kind: 'spaces',
      spaceId: 'spc_1',
      section: 'threads',
      threadId: 't1',
    });
  });

  it('maps /spaces/<space>/threads/new to the create-thread form, which the landing redirect leaves alone', () => {
    expect(spacePath('spc_1', 'threads', NEW_THREAD)).toBe('/spaces/spc_1/conversations/new');
    expect(routeFromPath('/spaces/spc_1/threads/new')).toEqual({
      kind: 'spaces',
      spaceId: 'spc_1',
      section: 'threads',
      threadId: NEW_THREAD,
    });
  });

  it('falls back to threads for a section not in SPACE_SECTIONS, still Spaces rather than chat', () => {
    expect(routeFromPath('/spaces/spc_1/nope')).toEqual({
      kind: 'spaces',
      spaceId: 'spc_1',
      section: 'threads',
      threadId: null,
    });
  });

  it('ignores a fourth segment under a non-threads section', () => {
    expect(routeFromPath('/spaces/spc_1/tasks/extra')).toEqual({
      kind: 'spaces',
      spaceId: 'spc_1',
      section: 'tasks',
      threadId: null,
    });
  });

  it('ignores everything after the fourth segment', () => {
    expect(routeFromPath('/spaces/spc_1/threads/t1/extra')).toEqual({
      kind: 'spaces',
      spaceId: 'spc_1',
      section: 'threads',
      threadId: 't1',
    });
  });

  it('decodes a percent-encoded space id and thread id', () => {
    expect(routeFromPath('/spaces/a%20b/threads/c%20d')).toEqual({
      kind: 'spaces',
      spaceId: 'a b',
      section: 'threads',
      threadId: 'c d',
    });
  });

  it('treats malformed percent-encoding in the space id as absent, along with everything after it', () => {
    expect(routeFromPath('/spaces/%')).toEqual({ kind: 'spaces', spaceId: null, section: 'threads', threadId: null });
    expect(routeFromPath('/spaces/%/tasks')).toEqual({
      kind: 'spaces',
      spaceId: null,
      section: 'threads',
      threadId: null,
    });
  });

  it('treats an empty space id segment as absent', () => {
    expect(routeFromPath('/spaces//tasks')).toEqual({
      kind: 'spaces',
      spaceId: null,
      section: 'threads',
      threadId: null,
    });
  });

  it('treats a trailing slash as an absent section', () => {
    expect(routeFromPath('/spaces/pot/')).toEqual({
      kind: 'spaces',
      spaceId: 'pot',
      section: 'threads',
      threadId: null,
    });
  });
});

describe('spacePath', () => {
  it('is /spaces with no arguments', () => {
    expect(spacePath()).toBe('/spaces');
  });

  it('is /spaces/<space> for a space id alone', () => {
    expect(spacePath('spc_1')).toBe('/spaces/spc_1');
  });

  it('always writes an explicit section, the conversations list included', () => {
    expect(spacePath('spc_1', 'threads')).toBe('/spaces/spc_1/conversations');
    expect(spacePath('spc_1', 'tasks')).toBe('/spaces/spc_1/tasks');
  });

  it('is /spaces/<space>/conversations/<conversation> for a conversation', () => {
    expect(spacePath('spc_1', 'threads', 't1')).toBe('/spaces/spc_1/conversations/t1');
  });

  it('ignores a threadId given with a section other than threads', () => {
    expect(spacePath('spc_1', 'tasks', 't1')).toBe('/spaces/spc_1/tasks');
  });

  it('encodes the space id and thread id', () => {
    expect(spacePath('a b', 'threads', 'c d')).toBe('/spaces/a%20b/conversations/c%20d');
  });

  it('round-trips through routeFromPath for each shape', () => {
    expect(routeFromPath(spacePath())).toEqual({ kind: 'spaces', spaceId: null, section: 'threads', threadId: null });
    expect(routeFromPath(spacePath('spc_1'))).toEqual({
      kind: 'spaces',
      spaceId: 'spc_1',
      section: 'threads',
      threadId: null,
    });
    expect(routeFromPath(spacePath('spc_1', 'tasks'))).toEqual({
      kind: 'spaces',
      spaceId: 'spc_1',
      section: 'tasks',
      threadId: null,
    });
    expect(routeFromPath(spacePath('spc_1', 'threads', 't1'))).toEqual({
      kind: 'spaces',
      spaceId: 'spc_1',
      section: 'threads',
      threadId: 't1',
    });
  });
});

describe('legacyRedirect', () => {
  it('maps /family to /spaces', () => {
    expect(legacyRedirect('/family')).toBe('/spaces');
  });

  it('maps /family/<rest> to /spaces/<rest>, the rest passed through untouched', () => {
    expect(legacyRedirect('/family/abc/tasks')).toBe('/spaces/abc/tasks');
  });

  it('returns null for a path that is not an old one', () => {
    expect(legacyRedirect('/calendar')).toBeNull();
  });

  it('leaves /today alone: the Today page is back (#870)', () => {
    expect(legacyRedirect('/today')).toBeNull();
  });
});

describe('resourcePath', () => {
  it('opens each kind of item in the section of its space that lists it', () => {
    expect(resourcePath('spc_1', 'task')).toBe('/spaces/spc_1/tasks');
    expect(resourcePath('spc_1', 'note')).toBe('/spaces/spc_1/notes');
    expect(resourcePath('spc_1', 'event')).toBe('/spaces/spc_1/agenda');
    expect(resourcePath('spc_1', 'reminder')).toBe('/spaces/spc_1/agenda');
  });

  it('encodes the space id so the path round-trips', () => {
    expect(routeFromPath(resourcePath('a b', 'task'))).toEqual({
      kind: 'spaces',
      spaceId: 'a b',
      section: 'tasks',
      threadId: null,
    });
  });
});

// IDS (2026-10-06): URLs show type-prefixed ids (spc_/conv_/dev_ + 32 hex) and
// /conversations; the API still takes the stored ids, which routeFromPath returns.
const SPACE_UUID = '6f86817c-ea95-481d-8456-8e608d5db780';
const SPACE_URL = 'spc_6f86817cea95481d84568e608d5db780';
const CONV_UUID = '5baa4dd3-311c-4abb-adc1-0eecd0ea06ca';
const CONV_URL = 'conv_5baa4dd3311c4abbadc10eecd0ea06ca';
const PERSONAL_STORED = `cnv_${CONV_UUID}`;
const DEVICE_UUID = '0b1e7c2a-9f3d-4e5a-8b6c-7d8e9f0a1b2c';
const DEVICE_URL = 'dev_0b1e7c2a9f3d4e5a8b6c7d8e9f0a1b2c';

describe('prefixed ids in URLs', () => {
  it('builds space conversation URLs with spc_ and conv_ under /conversations', () => {
    expect(spacePath(SPACE_UUID)).toBe(`/spaces/${SPACE_URL}`);
    expect(spacePath(SPACE_UUID, 'threads')).toBe(`/spaces/${SPACE_URL}/conversations`);
    expect(spacePath(SPACE_UUID, 'threads', CONV_UUID)).toBe(`/spaces/${SPACE_URL}/conversations/${CONV_URL}`);
    expect(spacePath(SPACE_UUID, 'threads', NEW_THREAD)).toBe(`/spaces/${SPACE_URL}/conversations/new`);
    expect(resourcePath(SPACE_UUID, 'task')).toBe(`/spaces/${SPACE_URL}/tasks`);
  });

  it('builds a personal conversation URL with conv_', () => {
    expect(conversationPath(PERSONAL_STORED)).toBe(`/c/${CONV_URL}`);
  });

  it('builds a device URL with dev_', () => {
    expect(devicePath(DEVICE_UUID)).toBe(`/devices/${DEVICE_URL}`);
  });

  it('keeps an id it cannot map back exactly as it is', () => {
    // A bare uuid under /c is not how a personal conversation is stored (cnv_<uuid>),
    // so conv_ would lead back to a different id: the URL keeps the stored one.
    expect(conversationPath(CONV_UUID)).toBe(`/c/${CONV_UUID}`);
    expect(conversationPath('abcdefgh1234')).toBe('/c/abcdefgh1234');
  });

  it.each([
    [`/spaces/${SPACE_URL}/conversations/${CONV_URL}`],
    [`/spaces/${SPACE_UUID}/threads/${CONV_UUID}`],
    [`/spaces/${SPACE_UUID.replaceAll('-', '')}/conversations/thr_${CONV_UUID}`],
    [`/spaces/${SPACE_UUID.toUpperCase()}/threads/${CONV_UUID.toUpperCase()}`],
  ])('parses %s to the stored space and conversation ids', (path) => {
    expect(routeFromPath(path)).toEqual({ kind: 'spaces', spaceId: SPACE_UUID, section: 'threads', threadId: CONV_UUID });
  });

  it('parses the /conversations list and the legacy /threads list alike', () => {
    const list = { kind: 'spaces', spaceId: SPACE_UUID, section: 'threads', threadId: null };
    expect(routeFromPath(`/spaces/${SPACE_URL}/conversations`)).toEqual(list);
    expect(routeFromPath(`/spaces/${SPACE_UUID}/threads`)).toEqual(list);
  });

  it.each([[`/c/${CONV_URL}`], [`/c/${PERSONAL_STORED}`]])('parses %s to the stored personal id', (path) => {
    expect(routeFromPath(path)).toEqual({ kind: 'chat', conversationId: PERSONAL_STORED });
    expect(conversationIdFromLocation(path)).toBe(PERSONAL_STORED);
  });

  it.each([[`/devices/${DEVICE_URL}`], [`/devices/${DEVICE_UUID}`]])('parses %s to the stored device id', (path) => {
    expect(routeFromPath(path)).toEqual({ kind: 'devices', deviceId: DEVICE_UUID });
  });
});

describe('legacyRedirect: prefixed ids', () => {
  it('maps a uuid space conversation URL to the prefixed /conversations one', () => {
    expect(legacyRedirect(`/spaces/${SPACE_UUID}/threads/${CONV_UUID}`)).toBe(
      `/spaces/${SPACE_URL}/conversations/${CONV_URL}`,
    );
    expect(legacyRedirect(`/spaces/${SPACE_UUID}/threads`)).toBe(`/spaces/${SPACE_URL}/conversations`);
    expect(legacyRedirect(`/spaces/${SPACE_UUID}/tasks`)).toBe(`/spaces/${SPACE_URL}/tasks`);
    expect(legacyRedirect(`/spaces/${SPACE_UUID}`)).toBe(`/spaces/${SPACE_URL}`);
    expect(legacyRedirect(`/spaces/${SPACE_URL}/threads/new`)).toBe(`/spaces/${SPACE_URL}/conversations/new`);
  });

  it('maps /c/cnv_<uuid> and /devices/<uuid> to their prefixed forms', () => {
    expect(legacyRedirect(`/c/${PERSONAL_STORED}`)).toBe(`/c/${CONV_URL}`);
    expect(legacyRedirect(`/devices/${DEVICE_UUID}`)).toBe(`/devices/${DEVICE_URL}`);
  });

  it('maps an old /family/<uuid> link straight to the prefixed form', () => {
    expect(legacyRedirect(`/family/${SPACE_UUID}/threads/${CONV_UUID}`)).toBe(
      `/spaces/${SPACE_URL}/conversations/${CONV_URL}`,
    );
  });

  it('leaves canonical URLs and ids it cannot map alone', () => {
    expect(legacyRedirect(`/spaces/${SPACE_URL}/conversations/${CONV_URL}`)).toBeNull();
    expect(legacyRedirect(`/c/${CONV_URL}`)).toBeNull();
    expect(legacyRedirect(`/devices/${DEVICE_URL}`)).toBeNull();
    expect(legacyRedirect(`/c/${CONV_UUID}`)).toBeNull();
    expect(legacyRedirect('/spaces')).toBeNull();
    expect(legacyRedirect('/')).toBeNull();
  });
});

// The 2026-10 redesign: one home per thing, and every old link lands there.
describe('moved pages', () => {
  it.each([
    ['/account', '', '/settings#profile'],
    ['/usage', '', '/settings#usage'],
    ['/connectors', '', '/integrations'],
    ['/gmail', '', '/integrations'],
    ['/pair', '', '/devices/pair'],
    ['/metrics', '', '/admin#monitoring'],
    ['/admin/monitoring', '', '/admin#monitoring'],
  ])('redirects %s%s to %s', (path, search, target) => {
    expect(legacyRedirect(path, search)).toBe(target);
  });

  it('keeps the query string: the Google consent return, a pairing code, the metrics lens', () => {
    expect(legacyRedirect('/connectors', '?state=s1&code=c1')).toBe('/integrations?state=s1&code=c1');
    expect(legacyRedirect('/gmail', '?state=s1')).toBe('/integrations?state=s1');
    expect(legacyRedirect('/pair', '?code=ABCD-2345')).toBe('/devices/pair?code=ABCD-2345');
    expect(legacyRedirect('/metrics', '?lens=ai&range=7d')).toBe('/admin?lens=ai&range=7d#monitoring');
  });

  it('reads an old path as its new home before the URL is replaced', () => {
    expect(routeFromPath('/account')).toEqual({ kind: 'settings' });
    expect(routeFromPath('/gmail')).toEqual({ kind: 'integrations' });
    expect(routeFromPath('/pair')).toEqual({ kind: 'pair' });
    expect(routeFromPath('/admin/monitoring')).toEqual({ kind: 'admin' });
  });

  it('sends /settings#accounts and a Google return on /settings (its registered callback) to /integrations, query kept', () => {
    expect(legacyRedirect('/settings', '', '#accounts')).toBe('/integrations');
    expect(legacyRedirect('/settings', '?state=s1', '#accounts')).toBe('/integrations?state=s1');
    expect(legacyRedirect('/settings', '?state=s1')).toBe('/integrations?state=s1');
    expect(legacyRedirect('/settings', '?error=access_denied&state=s1')).toBe('/integrations?error=access_denied&state=s1');
    expect(legacyRedirect('/settings', '', '#profile')).toBeNull();
  });

  it('leaves the new homes alone', () => {
    expect(legacyRedirect('/settings')).toBeNull();
    expect(legacyRedirect('/integrations', '?state=s1')).toBeNull();
    expect(legacyRedirect('/devices/pair')).toBeNull();
    expect(legacyRedirect('/admin')).toBeNull();
  });
});

describe('navigation with a hash', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('navigateTo keeps a hash and sends an old path to its new home', () => {
    navigateTo('/settings#appearance');
    expect(`${window.location.pathname}${window.location.hash}`).toBe('/settings#appearance');
    navigateTo('/usage');
    expect(`${window.location.pathname}${window.location.hash}`).toBe('/settings#usage');
  });

  it('announces a hash-only move as hashchange, so a page can scroll to its section', () => {
    window.history.replaceState(null, '', '/settings#profile');
    let changes = 0;
    const count = (): void => {
      changes += 1;
    };
    window.addEventListener('hashchange', count);
    try {
      navigateTo('/settings#accounts');
      navigateTo('/settings#accounts');
    } finally {
      window.removeEventListener('hashchange', count);
    }
    expect(changes).toBe(1);
  });

  it('replaceLegacyLocation rewrites the address bar in place, query kept', () => {
    window.history.replaceState(null, '', '/connectors?state=s1');
    const before = window.history.length;
    expect(replaceLegacyLocation()).toBe(true);
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/integrations?state=s1');
    expect(window.history.length).toBe(before);
    expect(replaceLegacyLocation()).toBe(false);
  });
});

it('round-trips group conversation and invitation routes without treating them as private chats', () => {
  const id = 'd7d7d7d7-1111-4111-8111-111111111111';
  expect(routeFromPath(groupChatPath(id))).toEqual({ kind: 'groupChat', chatId: id });
  expect(routeFromPath(groupChatInvitePath('synthetic-token'))).toEqual({ kind: 'groupChatInvite', token: 'synthetic-token' });
  expect(routeFromPath('/join-chat/%')).toEqual({ kind: 'chat', conversationId: null });
});
