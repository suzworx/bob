import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readUiActionCatalog, readUiListenerCatalog } from '../../../scripts/generate-ui-action-catalog';
import { routeFromPath, SPACE_SECTIONS } from '@/app/routes';
import actions from './ui-action-catalog.json';
import routes from './ui-route-catalog.json';
import endpoints from './ui-endpoint-catalog.json';
import listeners from './ui-listener-catalog.json';
import { uiRoute } from './ui-routes';
import { currentView, requestCategory } from './ui-events';

describe('UI instrumentation coverage gate', () => {
  it('classifies team review requests without recording the plan, installation or campaign', () => {
    const base = '/api/bob-apps/marketing/installations';
    for (const [method, suffix] of [['GET', '/review'], ['POST', '/review/approve']]) {
      const category = requestCategory(`${base}/private-installation/campaigns/private-campaign${suffix}?note=private-feedback`, { method });
      expect(category).toMatchObject({
        area: 'productivity',
        endpoint: `${base}/:installationId/campaigns/:campaignId${suffix}`,
      });
      expect(JSON.stringify(category)).not.toContain('private-');
    }
  });
  it('bounds app routes and requests without exporting app identifiers or query values', () => {
    history.replaceState(null, '', '/apps/private-app?title=private-title');
    expect(currentView()).toMatchObject({ page: 'apps', route: '/apps/:appId' });
    expect(JSON.stringify(currentView())).not.toContain('private-');
    history.replaceState(null, '', '/');
    const category = requestCategory('/api/bob-apps/private-app/refresh?private-query');
    expect(category).toMatchObject({ area: 'productivity', endpoint: '/api/bob-apps/:id/refresh' });
    expect(JSON.stringify(category)).not.toContain('private-');
    history.replaceState(null, '', '/spaces/private-space/apps?title=private-title#private-fragment');
    expect(currentView()).toMatchObject({ page: 'spaces', route: '/spaces/:spaceId/apps' });
    expect(JSON.stringify(currentView())).not.toContain('private-');
    history.replaceState(null, '', '/');
    const conversation = requestCategory('/api/bob-apps/private-app/conversation?private-query', { method: 'POST' });
    expect(conversation).toMatchObject({ area: 'productivity', endpoint: '/api/bob-apps/:id/conversation' });
    expect(JSON.stringify(conversation)).not.toContain('private-');
  });
  it('bounds group page and invitation classifications without exporting secrets', () => {
    for (const [path, route] of [['/groups/private-group', '/groups/:chatId'], ['/join-chat/private-token', '/join-chat/:token']]) {
      history.replaceState(null, '', path);
      const view = currentView();
      expect(view).toMatchObject({ page: 'chat', route });
      expect(JSON.stringify(view)).not.toContain('private-');
    }
    history.replaceState(null, '', '/');
    const category = requestCategory('/api/group-chats/invitations/private-token?secret=private-query');
    expect(category).toMatchObject({ area: 'conversations', endpoint: '/api/group-chats/invitations/:token' });
    expect(JSON.stringify(category)).not.toContain('private-');
  });
  it('covers every current callback site and gives the server the identical fixed allowlist', () => {
    const root = resolve('src');
    expect(readUiActionCatalog(root)).toEqual(actions);
    expect(new Set(actions.map(({ id }) => id)).size).toBe(actions.length);
    expect(actions.every(({ id }) => id.length <= 200 && /^[a-z0-9.-]+$/.test(id))).toBe(true);
    const server = JSON.parse(readFileSync(resolve('../api/src/platform/observability/ui-action-catalog.json'), 'utf8')) as unknown;
    expect(server).toEqual(actions);
    expect(readUiListenerCatalog(root)).toEqual(listeners);
  });

  it('covers named routes, every space section, detail/create routes and legacy targets without identifiers', () => {
    expect(JSON.parse(readFileSync(resolve('../api/src/platform/observability/ui-route-catalog.json'), 'utf8'))).toEqual(routes);
    const source = readFileSync(resolve('src/app/routes.ts'), 'utf8');
    const named = [...source.matchAll(/'([^']+)': \{ kind:/g)].map((match) => match[1]);
    const expected = ['/', '/apps/private-app', '/c/private-id', '/spaces', '/spaces/private-space', '/spaces/private-space/threads/new',
      '/groups/private-group', '/join-chat/private-token', '/spaces/private-space/threads/private-thread', '/devices/private-device', '/invite/private-token', ...named,
      ...SPACE_SECTIONS.map((section) => `/spaces/private-space/${section}`)];
    for (const path of expected) {
      expect(uiRoute(path)).not.toBe('other');
      expect(uiRoute(path)).not.toContain('private-');
      expect(routeFromPath(path)).toHaveProperty('kind');
    }
    expect(new Set(expected.map(uiRoute))).toEqual(new Set(routes.filter((route) => route !== 'other')));
    expect(uiRoute('/private-unregistered')).toBe('other');
  });

  it('reports the /conversations URLs (IDS) under the catalog\'s threads templates', () => {
    expect(uiRoute('/spaces/spc_1/conversations')).toBe('/spaces/:spaceId/threads');
    expect(uiRoute('/spaces/spc_1/conversations/new')).toBe('/spaces/:spaceId/threads/new');
    expect(uiRoute('/spaces/spc_1/conversations/conv_1')).toBe('/spaces/:spaceId/threads/:threadId');
  });

  it('keeps every registered API endpoint in both catalogs and normalizes eligible browser requests', () => {
    const registered = JSON.parse(readFileSync(resolve('../api/tests/fixtures/http-route-inventory.json'), 'utf8')) as Array<{ method: string; path: string }>;
    expect(endpoints).toEqual(registered.filter(({ path }) => path.startsWith('/api/')));
    expect(JSON.parse(readFileSync(resolve('../api/src/platform/observability/ui-endpoint-catalog.json'), 'utf8'))).toEqual(endpoints);
    for (const { method, path } of endpoints) {
      const actual = requestCategory(path.replace(/:[A-Za-z]+/g, 'private-id'), { method });
      if (path.startsWith('/api/telemetry')) expect(actual).toBeNull();
      else expect(actual?.endpoint).toBe(path);
    }
  });

  it('normalizes tools and timeline scopes without recording account, conversation, date or run values', () => {
    expect(uiRoute('/tools?conversationId=private-conversation&integrationId=private-account#private')).toBe('/tools');
    expect(uiRoute('/timeline?day=2026-10-23')).toBe('/timeline');
    for (const [path, method, endpoint] of [
      ['/api/tools?integrationId=private-account&conversationId=private-chat', 'GET', '/api/tools'],
      ['/api/tools/preferences', 'PATCH', '/api/tools/preferences'],
      ['/api/timeline?day=2026-10-23', 'GET', '/api/timeline'],
      ['/api/routines/timeline?cursor=private-cursor', 'GET', '/api/routines/timeline'],
      ['/api/routines/private-routine/runs/private-run', 'GET', '/api/routines/:id/runs/:runId'],
    ]) {
      const category = requestCategory(path ?? '', { method });
      expect(category?.endpoint).toBe(endpoint);
      expect(JSON.stringify(category)).not.toContain('private-');
    }
  });
});
