// Not a router: a handful of fixed paths plus `/c/<id>`, `/invite/<token>` and
// the `/spaces/...` family. These helpers read and write them so a reload
// restores the open surface.

import { useSyncExternalStore } from 'react';
import { GOOGLE_CALLBACK_KEYS } from '@/features/integrations/google-accounts-api';
import { prefixedId, uuidOf, type UrlIdKind } from '../lib/ids';

export const SPACE_SECTIONS = ['threads', 'tasks', 'notes', 'agenda', 'members', 'apps'] as const;
export type SpaceSection = (typeof SPACE_SECTIONS)[number];

/** The URL names the threads section /conversations; /threads is its old name. */
const CONVERSATIONS_SEGMENT = 'conversations';

/**
 * The thread segment that opens the create-thread form: `/spaces/<id>/conversations/new`.
 * It is a threadId like any other, so the landing redirect (which only fires
 * with no thread in the URL) leaves it alone and Back returns to where you were.
 */
export const NEW_THREAD = 'new';

function sectionFromSegment(segment: string | undefined): SpaceSection | null {
  if (segment === CONVERSATIONS_SEGMENT) return 'threads';
  return segment !== undefined && (SPACE_SECTIONS as readonly string[]).includes(segment) ? (segment as SpaceSection) : null;
}

/**
 * IDS (2026-10-06): a URL shows the prefixed id (spc_/conv_/dev_ + 32 hex) while
 * the API still takes the stored id, so every id is converted here, at the one
 * place URLs are built and read, and callers only ever see stored ids. Where the
 * id sits says how it is stored: spaces, devices and space conversations as a
 * dashed uuid, a personal conversation as `cnv_<dashed uuid>`. Every legacy form
 * (bare or undashed uuid, `thr_<uuid>`, `cnv_<uuid>`) still parses. An id the
 * prefixed form would not lead back to exactly (no uuid behind it, or a bare uuid
 * under /c) stays in the URL as it is.
 */
type IdSlot = 'space' | 'spaceConversation' | 'personalConversation' | 'device';

const SLOT_KIND = {
  space: 'space',
  spaceConversation: 'conversation',
  personalConversation: 'conversation',
  device: 'device',
} as const satisfies Record<IdSlot, UrlIdKind>;

/** The stored (API) id for a URL segment in this slot. */
function apiId(slot: IdSlot, segment: string): string {
  const uuid = uuidOf(SLOT_KIND[slot], segment);
  if (uuid === null) return segment;
  if (slot !== 'personalConversation') return uuid;
  // Only conv_ names a personal conversation by its uuid; cnv_<uuid> is already the stored id.
  return segment.startsWith('conv_') ? `cnv_${uuid}` : segment;
}

/** The URL segment for a stored id in this slot. */
function urlId(slot: IdSlot, stored: string): string {
  const prefixed = prefixedId(SLOT_KIND[slot], stored);
  const id = prefixed !== null && apiId(slot, prefixed) === stored ? prefixed : stored;
  return encodeURIComponent(id);
}

export type AppRoute =
  | { kind: 'groupChat'; chatId: string }
  | { kind: 'groupChatInvite'; token: string }
  | { kind: 'chat'; conversationId: string | null }
  | { kind: 'spaces'; spaceId: string | null; section: SpaceSection; threadId: string | null }
  | { kind: 'today' }
  | { kind: 'calendar' }
  | { kind: 'memory' }
  | { kind: 'admin' }
  | { kind: 'devices'; deviceId: string | null }
  // The pair dialog over the device list: /devices/pair.
  | { kind: 'pair' }
  | { kind: 'invite'; token: string }
  | { kind: 'reset' }
  // One page, its sections deep-linked by hash (#profile, #appearance, #usage ...).
  | { kind: 'settings' }
  | { kind: 'insights'; category: 'future' | 'reflections' | 'past' }
  | { kind: 'routines' }
  | { kind: 'timeline' }
  | { kind: 'tools' }
  | { kind: 'apps'; appId: string | null }
  // Connected accounts (Google: Gmail and calendars), its own rail destination.
  | { kind: 'integrations' };

export function conversationIdFromLocation(pathname: string = window.location.pathname): string | null {
  const match = pathname.match(/^\/c\/([^/]+)$/);
  if (!match?.[1]) return null;
  // A hand-typed or truncated URL such as /c/% is not valid percent-encoding.
  try {
    return apiId('personalConversation', decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

export function conversationPath(id: string | null): string {
  return id ? `/c/${urlId('personalConversation', id)}` : '/';
}

export function spacePath(
  spaceId?: string | null,
  section?: SpaceSection,
  threadId?: string | null,
): string {
  if (!spaceId) return '/spaces';
  const base = `/spaces/${urlId('space', spaceId)}`;
  if (section === undefined) return base;
  if (section !== 'threads') return `${base}/${section}`;
  const list = `${base}/${CONVERSATIONS_SEGMENT}`;
  return threadId ? `${list}/${urlId('spaceConversation', threadId)}` : list;
}

export function appPath(appId: string | null, spaceId?: string | null): string {
  if (spaceId) return `${spacePath(spaceId, 'apps')}${appId ? `?app=${encodeURIComponent(appId)}` : ''}`;
  return appId ? `/apps/${encodeURIComponent(appId)}` : '/apps';
}

export function groupChatPath(id: string): string {
  return `/groups/${urlId('spaceConversation', id)}`;
}

export function groupChatInvitePath(token: string): string {
  return `/join-chat/${encodeURIComponent(token)}`;
}

export function devicePath(id: string | null): string {
  return id ? `/devices/${urlId('device', id)}` : '/devices';
}

export type ResourceKind = 'task' | 'event' | 'note' | 'reminder';

// Where each kind of item lives inside its space: events and reminders are
// both on the agenda.
const RESOURCE_SECTIONS = {
  task: 'tasks',
  event: 'agenda',
  note: 'notes',
  reminder: 'agenda',
} as const satisfies Record<ResourceKind, SpaceSection>;

/** The space section that holds an item a tool created or changed. */
export function resourcePath(spaceId: string, kind: ResourceKind): string {
  return spacePath(spaceId, RESOURCE_SECTIONS[kind]);
}

/**
 * Pages that became a section of another (2026-10 redesign): the old path, the
 * new path and the hash it lands on. The query string is kept, because the
 * Google consent flow returns to /connectors or /gmail with its `state` and a
 * pairing link carries ?code=.
 */
const MOVED_PAGES: Record<string, { path: string; hash: string }> = {
  '/account': { path: '/settings', hash: '#profile' },
  '/usage': { path: '/settings', hash: '#usage' },
  '/connectors': { path: '/integrations', hash: '' },
  '/gmail': { path: '/integrations', hash: '' },
  '/pair': { path: '/devices/pair', hash: '' },
  '/metrics': { path: '/admin', hash: '#monitoring' },
  '/admin/monitoring': { path: '/admin', hash: '#monitoring' },
};

// The Google consent flow's registered callback is /settings, so a return
// there (any hash) goes on to /integrations, query kept.
function isGoogleReturn(search: string): boolean {
  const params = new URLSearchParams(search);
  return GOOGLE_CALLBACK_KEYS.some((key) => params.has(key));
}

/**
 * Old links keep working: /family and /family/... map to /spaces, the moved
 * pages above to their new home, and stored ids to prefixed ones. Returns the
 * full target (path, query, hash) an old one maps to, else null. (/today is a
 * page again, #870.)
 */
export function legacyRedirect(pathname: string, search = '', hash = ''): string | null {
  if (pathname === '/settings' && (hash === '#accounts' || isGoogleReturn(search))) return `/integrations${search}`;
  const moved = MOVED_PAGES[pathname];
  if (moved) return `${moved.path}${search}${moved.hash || hash}`;
  const path = pathname === '/family' || pathname.startsWith('/family/') ? `/spaces${pathname.slice('/family'.length)}` : pathname;
  const target = canonicalPath(path);
  return target === pathname ? null : `${target}${search}${hash}`;
}

/**
 * Replaces an old URL in the address bar with its new one, in place (no
 * history entry). Returns whether it did. The shell calls it before its first
 * read of the path, so a page never mounts on the old URL first.
 */
export function replaceLegacyLocation(): boolean {
  const { pathname, search, hash } = window.location;
  const target = legacyRedirect(pathname, search, hash);
  if (target === null) return false;
  window.history.replaceState(null, '', target);
  return true;
}

/** The same place with prefixed ids and /conversations: how emailed and bookmarked uuid and /threads links land. */
function canonicalPath(pathname: string): string {
  const route = routeFromPath(pathname);
  if (route.kind === 'chat' && route.conversationId !== null) return conversationPath(route.conversationId);
  if (route.kind === 'devices' && route.deviceId !== null) return devicePath(route.deviceId);
  if (route.kind !== 'spaces' || route.spaceId === null) return pathname;
  const hasSection = sectionFromSegment(pathname.split('/')[3]) !== null;
  return spacePath(route.spaceId, hasSection ? route.section : undefined, route.threadId);
}

// pushState fires no popstate, so the app's own routechange event is dispatched
// for anything subscribed through subscribeToRoute. `path` may carry a query
// and a hash (/settings#appearance); an old path goes straight to its new home,
// and a move that only changes the hash also fires hashchange, as a link would.
export function navigateTo(path: string): void {
  const next = new URL(path, window.location.href);
  const target = legacyRedirect(next.pathname, next.search, next.hash) ?? `${next.pathname}${next.search}${next.hash}`;
  const { pathname, search, hash } = window.location;
  if (`${pathname}${search}${hash}` === target) return;
  window.history.pushState(null, '', target);
  window.dispatchEvent(new Event('bob:routechange'));
  if (new URL(target, window.location.href).hash !== hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function subscribeToRoute(callback: () => void): () => void {
  window.addEventListener('popstate', callback);
  window.addEventListener('bob:routechange', callback);
  return () => {
    window.removeEventListener('popstate', callback);
    window.removeEventListener('bob:routechange', callback);
  };
}

const NAMED_ROUTES = {
  '/today': { kind: 'today' },
  '/calendar': { kind: 'calendar' },
  '/memory': { kind: 'memory' },
  '/admin': { kind: 'admin' },
  '/devices': { kind: 'devices', deviceId: null },
  '/devices/pair': { kind: 'pair' },
  '/reset': { kind: 'reset' },
  '/settings': { kind: 'settings' },
  '/integrations': { kind: 'integrations' },
  '/insights': { kind: 'insights', category: 'future' },
  '/insights/future': { kind: 'insights', category: 'future' },
  '/insights/reflections': { kind: 'insights', category: 'reflections' },
  '/insights/past': { kind: 'insights', category: 'past' },
  '/routines': { kind: 'routines' },
  '/timeline': { kind: 'timeline' },
  '/tools': { kind: 'tools' },
  '/apps': { kind: 'apps', appId: null },
} as const satisfies Record<string, AppRoute>;

// A hand-typed or truncated segment such as /spaces/% is not valid
// percent-encoding; treat it (and anything after it) as absent rather than throw.
function decodeSegment(segment: string): string | null {
  if (segment === '') return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function spacesRouteFromSegments(segments: string[]): AppRoute {
  const rawSpaceId = segments[0] !== undefined ? decodeSegment(segments[0]) : null;
  if (rawSpaceId === null) return { kind: 'spaces', spaceId: null, section: 'threads', threadId: null };
  const spaceId = apiId('space', rawSpaceId);

  const section = sectionFromSegment(segments[1]);
  if (section === null) return { kind: 'spaces', spaceId, section: 'threads', threadId: null };

  if (section === 'threads') {
    const rawThreadId = segments[2] !== undefined ? decodeSegment(segments[2]) : null;
    const threadId = rawThreadId === null ? null : apiId('spaceConversation', rawThreadId);
    return { kind: 'spaces', spaceId, section: 'threads', threadId };
  }

  return { kind: 'spaces', spaceId, section, threadId: null };
}

function groupRouteFromPath(pathname: string): AppRoute | null {
  const group = pathname.match(/^\/(groups|join-chat)\/([^/]+)$/);
  if (group?.[2]) {
    const segment = decodeSegment(group[2]);
    if (segment !== null) return group[1] === 'groups'
      ? { kind: 'groupChat', chatId: apiId('spaceConversation', segment) }
      : { kind: 'groupChatInvite', token: segment };
  }
  return null;
}

// Anything that is not a named surface or an invitation is the chat, as v1.
export function routeFromPath(pathname: string): AppRoute {
  // An old path reads as its new home, so it renders right even before the URL is replaced.
  const moved = MOVED_PAGES[pathname];
  const named = (NAMED_ROUTES as Record<string, AppRoute | undefined>)[moved ? moved.path : pathname];
  if (named) return named;
  if (pathname === '/spaces' || pathname.startsWith('/spaces/')) {
    const parts = pathname === '/spaces' ? [] : pathname.slice('/spaces/'.length).split('/');
    return spacesRouteFromSegments(parts);
  }
  const group = groupRouteFromPath(pathname);
  if (group) return group;
  const app = pathname.match(/^\/apps\/([^/]+)$/);
  if (app?.[1]) return { kind: 'apps', appId: decodeSegment(app[1]) };
  const device = pathname.match(/^\/devices\/([^/]+)$/);
  if (device?.[1]) {
    const deviceId = decodeSegment(device[1]);
    return { kind: 'devices', deviceId: deviceId === null ? null : apiId('device', deviceId) };
  }
  const invite = pathname.match(/^\/invite\/([^/]+)$/);
  if (invite?.[1]) {
    // A hand-typed or truncated token such as /invite/% is not valid percent-encoding.
    try {
      return { kind: 'invite', token: decodeURIComponent(invite[1]) };
    } catch {
      return { kind: 'chat', conversationId: null };
    }
  }
  return { kind: 'chat', conversationId: conversationIdFromLocation(pathname) };
}

export function useLocationPath(): string {
  return useSyncExternalStore(subscribeToRoute, () => window.location.pathname);
}

/** The hash of the current URL ('' or '#section'), for pages with deep-linked sections. A fragment link fires popstate, which this hears. */
export function useLocationHash(): string {
  return useSyncExternalStore(subscribeToRoute, () => window.location.hash);
}

/** Query-only navigation also changes scoped views such as Tools. */
export function useLocationSearch(): string {
  return useSyncExternalStore(subscribeToRoute, () => window.location.search);
}
