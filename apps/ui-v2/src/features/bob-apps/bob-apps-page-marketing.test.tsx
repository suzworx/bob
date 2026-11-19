import type { Space } from '@/features/spaces/use-spaces';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { BobAppsPage } from './bob-apps-page';
import { starterApp } from './app-starters';
import type { BobApp } from './bob-apps-api';
import { deleteApp } from './bob-apps-api';
import { navigateTo } from '@/app/routes';
import { useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import type { AppMenuItems } from './app-actions';

const access = vi.hoisted(() => ({ shared: false, canManage: true, generic: false, error: null as string | null }));
const reload = vi.hoisted(() => ({ apps: vi.fn(), marketing: vi.fn(), mounts: 0 }));

vi.mock('@/app/routes', async (original) => ({ ...await original<typeof import('@/app/routes')>(), routeFromPath: () => ({ kind: 'apps', appId: 'marketing-app' }), useLocationPath: () => '/apps/marketing-app', navigateTo: vi.fn() }));
vi.mock('@/lib/auth/use-session', () => ({ useSession: () => ({ session: { user: { id: 'owner' } } }) }));
vi.mock('./marketing-workspace', () => ({ MarketingWorkspace: ({ readRevision, lifecycleActions, appActions = [] }: { readRevision: number; lifecycleActions?: ReactElement; appActions?: AppMenuItems }) => {
  const [text, setText] = useState(() => { reload.mounts += 1; return ''; });
  return <><p>Marketing workspace</p><output>{`Read revision ${readRevision}`}</output><input aria-label="Pending draft" value={text} onChange={(event) => setText(event.target.value)} /><MoreMenu label="More app actions" items={appActions} />{lifecycleActions}</>;
} }));
vi.mock('./use-marketing-catalog', () => ({ useMarketingCatalog: () => ({ data: { package: {}, installations: access.shared || access.generic ? [] : [{ id: 'installation', appId: 'marketing-app' }] }, error: false, reload: reload.marketing }) }));
vi.mock('./use-bob-apps', () => ({ useBobApps: () => ({ apps: [], app: app(), error: access.error, busy: false, nextCursor: null, load: reload.apps, more: vi.fn(), perform: async (action: () => Promise<unknown>) => { await action(); return true; } }) }));
vi.mock('./bob-apps-api', async (original) => ({ ...await original<typeof import('./bob-apps-api')>(), deleteApp: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./app-refresh-api', async (original) => ({ ...await original<typeof import('./app-refresh-api')>(), getRefresh: vi.fn().mockResolvedValue({ enabled: false, config: null, nextRunAt: null, lastRefreshAt: null, lastError: null }), getRuns: vi.fn().mockResolvedValue([]) }));
vi.mock('./app-workspace', () => ({ AppWorkspace: ({ children, focusRef }: { children: ReactNode; focusRef: RefObject<(() => void) | null> }) => {
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  focusRef.current = () => input.current?.focus();
  return <>{children}<textarea ref={input} role="combobox" aria-label="Message input" value={text} onChange={(event) => setText(event.target.value)} /></>;
} }));
function app(): BobApp { return { id: 'marketing-app', installationId: 'installation', spaceId: access.shared ? 's1' : null, canManage: access.canManage, revision: 2, lifecycle: 'active', createdAt: 1, updatedAt: 1, definition: { ...starterApp('checklist'), title: 'Bob Marketing' }, state: {}, metrics: {}, pendingDefinition: access.shared ? starterApp('checklist') : null, canUndo: false }; }

const dialogMethods = ['showModal', 'close'] as const;
const originalMethods = dialogMethods.map((name) => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name));
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
});
afterAll(() => { dialogMethods.forEach((name, index) => { const original = originalMethods[index]; if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original); else Reflect.deleteProperty(HTMLDialogElement.prototype, name); }); });

it('keeps the shared delete confirmation accessible on an installed Marketing workspace', async () => {
  render(<BobAppsPage />);
  expect(screen.getByText('Marketing workspace')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'More app actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete app' }));
  expect(deleteApp).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete app permanently' }));
  await waitFor(() => expect(deleteApp).toHaveBeenCalledWith(expect.objectContaining({ id: 'marketing-app' })));
});

it('reloads generic state, Marketing catalog and workspace reads without remounting pending edits', () => {
  reload.apps.mockClear(); reload.marketing.mockClear(); reload.mounts = 0;
  access.error = 'This app changed elsewhere.';
  render(<BobAppsPage />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Pending draft' }), { target: { value: 'Keep my exact pending draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reload latest data' }));
  expect(reload.apps).toHaveBeenCalledOnce();
  expect(reload.marketing).toHaveBeenCalledOnce();
  expect(screen.getByText('Read revision 1')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'Pending draft' }) as HTMLInputElement).value).toBe('Keep my exact pending draft');
  expect(reload.mounts).toBe(1);
  access.error = null;
});

it('members edit shared records and inspect proposals while management actions belong to admins', () => {
  const space: Space = { id: 's1', kind: 'group', name: 'Team', role: 'member', membership_revision: 1, created_at: 1, updated_at: 1, members: [] };
  access.shared = true; access.canManage = false;
  window.history.replaceState(null, '', '/spaces/s1/apps?app=marketing-app');
  try {
    const { rerender } = render(<BobAppsPage space={space} />);
    expect(screen.getByRole('button', { name: 'Add to Checklist' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change with Bob' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete app' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'App actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Delete app' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Pause app' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    access.canManage = true;
    rerender(<BobAppsPage space={{ ...space, role: 'admin' }} />);
    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'App actions' }));
    expect(screen.getByRole('menuitem', { name: 'Delete app' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Pause app' })).toBeTruthy();
  } finally { access.shared = false; access.canManage = true; window.history.replaceState(null, '', '/'); }
});

it('keeps a personal declarative app open when Change with Bob focuses its in-place composer', async () => {
  access.generic = true;
  vi.mocked(navigateTo).mockClear();
  try {
    await act(async () => { render(<BobAppsPage />); });
    const composer = screen.getByRole('combobox', { name: /Message/ });
    fireEvent.change(composer, { target: { value: 'My unsent change idea' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change with Bob' }));
    expect(navigateTo).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add to Checklist' })).toBeTruthy();
    expect(document.activeElement).toBe(composer);
    expect((composer as HTMLTextAreaElement).value).toBe('My unsent change idea');
  } finally { access.generic = false; }
});

it('lets a group member ask Bob to change the open declarative app without leaving it', async () => {
  const space: Space = { id: 's1', kind: 'group', name: 'Team', role: 'member', membership_revision: 1, created_at: 1, updated_at: 1, members: [] };
  access.generic = true; access.shared = true; access.canManage = false;
  vi.mocked(navigateTo).mockClear();
  window.history.replaceState(null, '', '/spaces/s1/apps?app=marketing-app');
  try {
    render(<BobAppsPage space={space} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change with Bob' }));
    expect(navigateTo).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: /Message/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull();
  } finally { access.generic = false; access.shared = false; access.canManage = true; window.history.replaceState(null, '', '/'); }
});
