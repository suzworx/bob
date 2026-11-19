import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Space } from '@/features/spaces/use-spaces';
import { BobAppsPage } from './bob-apps-page';
import { starterApp } from './app-starters';
import type { BobApp } from './bob-apps-api';

const state = vi.hoisted(() => ({ app: null as BobApp | null, error: null as string | null }));
vi.mock('@/app/routes', async (original) => ({ ...await original<typeof import('@/app/routes')>(), routeFromPath: () => ({ kind: 'apps', appId: 'app' }), useLocationPath: () => '/apps/app', useLocationSearch: () => '?app=app' }));
vi.mock('@/lib/auth/use-session', () => ({ useSession: () => ({ session: { user: { id: 'owner' } } }) }));
vi.mock('@/features/spaces/use-spaces', () => ({ useSpaces: () => ({ spaces: [] }) }));
vi.mock('./use-marketing-catalog', () => ({ useMarketingCatalog: () => ({ data: { package: {}, installations: [] }, error: false, reload: vi.fn() }) }));
vi.mock('./use-bob-apps', () => ({ useBobApps: () => ({ apps: [], app: state.app, error: state.error, busy: false, nextCursor: null, load: vi.fn(), more: vi.fn(), perform: vi.fn() }) }));
vi.mock('./app-workspace', () => ({ AppWorkspace: ({ children }: { children: ReactNode }) => <>{children}<textarea role="combobox" aria-label="Message input" /></> }));
vi.mock('./app-refresh-api', async (original) => ({ ...await original<typeof import('./app-refresh-api')>(), getRefresh: vi.fn().mockResolvedValue({ enabled: false, config: null, nextRunAt: null, lastRefreshAt: null, lastError: null }), getRuns: vi.fn().mockResolvedValue([]) }));

beforeEach(() => {
  state.error = null;
  state.app = { id: 'app', installationId: 'installation', spaceId: null, canManage: true, revision: 3, lifecycle: 'active', createdAt: 1, updatedAt: 1, definition: starterApp('budget'), state: { items: [{ id: 'saved-row', values: { title: 'Saved lunch', amount: 12 } }] }, metrics: { items: 1, total: 12 }, pendingDefinition: null, canUndo: true };
});

it('offers the saved view as an image inside the one existing app menu with one composer', async () => {
  render(<BobAppsPage />);
  expect(await screen.findByText('Saved lunch')).toBeTruthy();
  expect(screen.getAllByRole('combobox', { name: 'Message input' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Share view as image' })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'App actions' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'App actions' }));
  expect(screen.getByRole('menuitem', { name: 'Export JSON' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Share view as image' })).toBeTruthy();
});

it('keeps sharing attached only to the saved renderer when a separate proposal preview exists', () => {
  if (!state.app) throw new Error('fixture missing');
  state.app.pendingDefinition = { ...starterApp('checklist'), title: 'Proposed checklist' };
  render(<BobAppsPage />);
  expect(screen.getByRole('heading', { name: 'Review proposed changes' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Apply changes' })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'App actions' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Share view as image' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'App actions' }));
  expect(screen.getAllByRole('menuitem', { name: 'Share view as image' })).toHaveLength(1);
});

it('allows a space member to share readable saved content without gaining management actions', () => {
  if (!state.app) throw new Error('fixture missing');
  state.app = { ...state.app, spaceId: 'team', canManage: false, pendingDefinition: starterApp('checklist') };
  const space: Space = { id: 'team', kind: 'group', name: 'Team', role: 'member', membership_revision: 1, created_at: 1, updated_at: 1, members: [] };
  render(<BobAppsPage space={space} />);
  expect(screen.getAllByRole('combobox', { name: 'Message input' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'App actions' }));
  for (const name of ['Delete app', 'Pause app', 'Undo last change']) expect(screen.queryByRole('menuitem', { name })).toBeNull();
  expect(screen.getByRole('menuitem', { name: 'Export JSON' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Share view as image' })).toBeTruthy();
});

it('does not expose a sharing surface after app access is lost', () => {
  state.app = null;
  state.error = 'This app is no longer available.';
  render(<BobAppsPage />);
  expect(screen.getByText(state.error)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'App actions' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Share view as image' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Share view as image' })).toBeNull();
});

it('resolves the actual current slide after switching away from records', () => {
  render(<BobAppsPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Presentation' }));
  expect(screen.getByText('Slide 1 of 2')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
  expect(screen.getByRole('heading', { name: 'Next steps' })).toBeTruthy();
  expect(screen.getByText('Slide 2 of 2')).toBeTruthy();
  expect(screen.queryByText('Saved lunch')).toBeNull();
  expect(screen.getAllByRole('combobox', { name: 'Message input' })).toHaveLength(1);
});
