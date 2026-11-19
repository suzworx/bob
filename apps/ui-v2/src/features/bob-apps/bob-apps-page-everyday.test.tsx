import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { BobAppsPage } from './bob-apps-page';
import { AppRenderer } from './app-renderer';
import { starterApp } from './app-starters';
import { AppRequestError, type BobApp } from './bob-apps-api';
import { AppRefresh } from './app-refresh';
import { getRefresh, getRuns, saveRefresh } from './app-refresh-api';
import type { RefreshState } from './app-refresh-api';

const state = vi.hoisted(() => ({ app: null as BobApp | null }));
vi.mock('@/app/routes', async (original) => ({ ...await original<typeof import('@/app/routes')>(), routeFromPath: () => ({ kind: 'apps', appId: 'app' }), useLocationPath: () => '/apps/app' }));
vi.mock('@/lib/auth/use-session', () => ({ useSession: () => ({ session: { user: { id: 'owner' } } }) }));
vi.mock('@/features/spaces/use-spaces', () => ({ useSpaces: () => ({ spaces: [{ id: 'source', name: 'Team tasks' }] }) }));
vi.mock('./use-marketing-catalog', () => ({ useMarketingCatalog: () => ({ data: { package: {}, installations: [] }, error: false, reload: vi.fn() }) }));
vi.mock('./use-bob-apps', () => ({ useBobApps: () => ({ apps: [], app: state.app, error: null, busy: false, nextCursor: null, load: vi.fn(), more: vi.fn(), perform: async (action: () => Promise<unknown>) => { await action(); return true; } }) }));
vi.mock('./app-workspace', () => ({ AppWorkspace: ({ children }: { children: ReactNode }) => <>{children}<textarea role="combobox" aria-label="Message input" /></> }));
vi.mock('./app-refresh-api', async (original) => ({ ...await original<typeof import('./app-refresh-api')>(), getRefresh: vi.fn(), getRuns: vi.fn(), saveRefresh: vi.fn() }));

const unconfigured: RefreshState = { enabled: false, config: null, nextRunAt: null, lastRefreshAt: null, lastError: null };
function app(kind: Parameters<typeof starterApp>[0] = 'budget'): BobApp {
  return { id: 'app', installationId: 'installation', spaceId: null, canManage: true, revision: 3, lifecycle: 'active', createdAt: 1, updatedAt: 1, definition: starterApp(kind), state: {}, metrics: {}, pendingDefinition: null, canUndo: true };
}
beforeEach(() => {
  state.app = app();
  vi.mocked(getRefresh).mockReset().mockResolvedValue(unconfigured);
  vi.mocked(getRuns).mockReset().mockResolvedValue([]);
  vi.mocked(saveRefresh).mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('keeps an ineligible active app editable without irrelevant automatic-update controls', async () => {
  render(<BobAppsPage />);
  expect(await screen.findByRole('button', { name: 'Add to Expenses' })).toBeTruthy();
  expect(screen.getAllByRole('combobox', { name: 'Message input' })).toHaveLength(1);
  expect(screen.queryByRole('heading', { name: 'Automatic updates' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Configure automatic updates' })).toBeNull();
});

it('does not call a never-configured eligible app paused or give it empty update history', async () => {
  state.app = app('checklist');
  render(<BobAppsPage />);
  expect(await screen.findByRole('button', { name: 'Add to Checklist' })).toBeTruthy();
  expect(screen.queryByText('Automatic updates are paused.')).toBeNull();
  expect(screen.queryByText('No automatic refresh yet.')).toBeNull();
});

it('keeps a configured refresh target locked and requires fresh replacement consent', async () => {
  state.app = app('checklist');
  vi.mocked(getRefresh).mockResolvedValue({ ...unconfigured, enabled: true, config: { source: 'tasks', spaceId: 'source', targetTable: 'items', schedule: { weekdays: [1], localTime: '08:00', timeZone: 'UTC' } } });
  render(<BobAppsPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Configure automatic updates' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Add to Checklist' })).toBeNull());
  const enable = screen.getByRole('button', { name: 'Enable automatic updates' });
  expect(enable.hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Let Bob read these tasks and replace this table on this schedule' }));
  expect(enable.hasAttribute('disabled')).toBe(false);
});

it('shows a previously run schedule as paused after pausing clears its config and unlocks records', async () => {
  state.app = app('checklist');
  const lastRefreshAt = Date.UTC(2026, 9, 31, 12);
  vi.mocked(getRefresh).mockResolvedValue({ ...configuredRefresh(), lastRefreshAt });
  vi.mocked(getRuns).mockResolvedValue([{ id: 'completed-run', status: 'completed', scheduledAt: lastRefreshAt, completedAt: lastRefreshAt, failureCode: null }]);
  vi.mocked(saveRefresh).mockImplementationOnce(async () => {
    // configureBobAppRefresh stores the submitted null config while retaining completed runs and last_refresh_at.
    vi.mocked(getRefresh).mockResolvedValue({ ...unconfigured, lastRefreshAt });
  });
  render(<BobAppsPage />);
  const pause = await screen.findByRole('button', { name: 'Pause automatic updates' });
  expect(screen.queryByRole('button', { name: 'Add to Checklist' })).toBeNull();
  fireEvent.click(pause);
  await waitFor(() => expect(saveRefresh).toHaveBeenCalledWith(state.app, false, null));
  expect(await screen.findByRole('button', { name: 'Add to Checklist' })).toBeTruthy();
  expect(getRefresh).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('heading', { name: 'Refresh history' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Pause automatic updates' })).toBeNull();
  expect(screen.getByText('Automatic updates are paused.')).toBeTruthy();
});

it('puts secondary app actions in one menu while the record action and composer stay directly available', async () => {
  render(<BobAppsPage />);
  expect(await screen.findByRole('button', { name: 'Add to Expenses' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Duplicate app' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete app' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reload latest data' })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'App actions' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'App actions' }));
  for (const name of ['Duplicate app', 'Export JSON', 'Undo last change', 'Archive app', 'Delete app']) expect(screen.getByRole('menuitem', { name })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Change with Bob' })).toBeTruthy();
  expect(screen.getAllByRole('combobox', { name: 'Message input' })).toHaveLength(1);
});

it('gives an empty saved view one original-Bob illustration and one next step', () => {
  const { container } = render(<AppRenderer definition={starterApp('budget')} state={{}} metrics={{}} onAction={vi.fn().mockResolvedValue(true)} />);
  expect(screen.getAllByRole('heading', { name: 'Nothing here yet' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Add to Expenses' })).toHaveLength(1);
  const pictures = container.querySelectorAll('img');
  expect(pictures).toHaveLength(1);
  expect(pictures[0]?.getAttribute('src')).toMatch(/^\/brand\/bob\/bob-(?:playful|helper)\.webp$/);
});

function configuredRefresh(): RefreshState {
  return { ...unconfigured, enabled: true, config: { source: 'tasks', spaceId: 'source', targetTable: 'items', schedule: { weekdays: [1], localTime: '08:00', timeZone: 'UTC' } } };
}
function editRefresh(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Configure automatic updates' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Refresh time zone' }), { target: { value: 'America/Chicago' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Let Bob read these tasks and replace this table on this schedule' }));
}

it('keeps edited update choices and consent through a save conflict and a settings retry', async () => {
  vi.mocked(getRefresh).mockResolvedValue(configuredRefresh());
  vi.mocked(saveRefresh).mockRejectedValueOnce(new AppRequestError(409));
  const rereadApp = vi.fn();
  render(<AppRefresh app={app('checklist')} onChanged={rereadApp} onState={vi.fn()} />);
  await screen.findByRole('button', { name: 'Configure automatic updates' });
  editRefresh();
  fireEvent.click(screen.getByRole('button', { name: 'Enable automatic updates' }));
  await screen.findByText('This app changed elsewhere. Reload the latest data, then review and save your schedule again.');
  expect((screen.getByRole('textbox', { name: 'Refresh time zone' }) as HTMLInputElement).value).toBe('America/Chicago');
  fireEvent.click(screen.getByRole('button', { name: 'Retry update settings' }));
  await waitFor(() => expect(getRefresh).toHaveBeenCalledTimes(2));
  expect(rereadApp).toHaveBeenCalledOnce();
  expect((screen.getByRole('textbox', { name: 'Refresh time zone' }) as HTMLInputElement).value).toBe('America/Chicago');
  expect((screen.getByRole('checkbox', { name: 'Let Bob read these tasks and replace this table on this schedule' }) as HTMLInputElement).checked).toBe(true);
  expect(saveRefresh).toHaveBeenCalledTimes(1);
});

it('retains an open update form and its last known lock after a later history read fails', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.mocked(getRefresh).mockResolvedValue(configuredRefresh());
  const observed = vi.fn();
  render(<AppRefresh app={app('checklist')} onChanged={vi.fn()} onState={observed} />);
  await act(async () => { await Promise.resolve(); });
  editRefresh();
  vi.mocked(getRuns).mockRejectedValueOnce(new Error('temporary read failure'));
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(screen.getByText('Couldn’t load update history. Reload to try again.')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'Refresh time zone' }) as HTMLInputElement).value).toBe('America/Chicago');
  expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, config: expect.objectContaining({ targetTable: 'items' }) }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry update settings' })); await Promise.resolve(); });
  expect((screen.getByRole('textbox', { name: 'Refresh time zone' }) as HTMLInputElement).value).toBe('America/Chicago');
  expect((screen.getByRole('checkbox', { name: 'Let Bob read these tasks and replace this table on this schedule' }) as HTMLInputElement).checked).toBe(true);
});
