import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BobAppsPage } from './bob-apps-page';

type Summary = { id: string; title: string; lifecycle: 'draft' | 'active' | 'archived'; revision: number; createdAt: number; updatedAt: number };
const apps = vi.hoisted(() => ({ list: [] as Summary[] | null, capability: 'unavailable' }));
vi.mock('@/app/routes', async (original) => ({ ...await original<typeof import('@/app/routes')>(), routeFromPath: () => ({ kind: 'apps', appId: null }), useLocationPath: () => '/apps', navigateTo: vi.fn() }));
vi.mock('@/lib/auth/use-session', () => ({ useSession: () => ({ session: { user: { id: 'owner' } } }) }));
vi.mock('./marketing-api', async (original) => ({ ...await original<typeof import('./marketing-api')>(), installMarketing: vi.fn().mockRejectedValue(new Error('offline')) }));
vi.mock('./use-marketing-catalog', () => ({ useMarketingCatalog: () => ({ data: { package: { name: 'Bob', capabilities: [{ id: 'publishing', status: apps.capability, reason: 'No channel connection is proven yet, so nothing is published.' }] }, installations: [] }, error: false, reload: vi.fn() }) }));
vi.mock('./use-bob-apps', () => ({ useBobApps: () => ({ apps: apps.list, app: null, error: null, busy: false, nextCursor: null, load: vi.fn(), more: vi.fn(), perform: vi.fn() }) }));
afterEach(() => { cleanup(); apps.list = []; apps.capability = 'unavailable'; vi.useRealTimers(); });

const updatedAt = new Date(2026, 9, 28, 12).getTime();
const app = (id: string, title: string, lifecycle: Summary['lifecycle']): Summary => ({ id, title, lifecycle, revision: 1, createdAt: updatedAt, updatedAt });
const position = (name: string): number => {
  const nodes = Array.from(document.body.querySelectorAll('*'));
  return nodes.findIndex((node) => node === screen.getByText(name));
};

describe('My Apps', () => {
  it('puts your own apps above the catalog', () => {
    apps.list = [app('a', 'Fuel log', 'active')];
    render(<BobAppsPage />);
    expect(position('Fuel log')).toBeLessThan(position('Budget starter'));
    expect(position('Fuel log')).toBeLessThan(position('Bob Marketing'));
  });
  it('describes a row by when it last changed, and calls out a draft', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 31, 12));
    apps.list = [app('a', 'Fuel log', 'active'), app('b', 'Packing', 'draft')];
    render(<BobAppsPage />);
    expect(screen.getAllByText('3 days ago')).toHaveLength(2);
    expect(screen.getByText(/^Ready to try · Updated/)).toBeTruthy();
  });
  it('invites you in when you have no apps', () => {
    render(<BobAppsPage />);
    expect(screen.getByRole('heading', { name: 'No apps yet' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Create with Bob' })).toHaveLength(1);
  });
  it('does not say you have no apps when every app is archived', () => {
    apps.list = [app('b', 'Old budget', 'archived')];
    render(<BobAppsPage />);
    expect(screen.queryByRole('heading', { name: 'No apps yet' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Nothing current' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Archived' })).toBeTruthy();
  });
  it('shows a persistent message when Marketing cannot install', async () => {
    render(<BobAppsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Install Marketing' }));
    expect(await screen.findByText('Couldn’t install Marketing. Try again in a moment.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Install Marketing' })).toBeTruthy();
  });
  it('always offers archived apps, one control away', () => {
    apps.list = [app('a', 'Fuel log', 'active')];
    const { unmount } = render(<BobAppsPage />);
    expect(screen.getByRole('radio', { name: 'Archived' })).toBeTruthy();
    unmount();
    apps.list = [app('a', 'Fuel log', 'active'), app('b', 'Old budget', 'archived')];
    render(<BobAppsPage />);
    expect(screen.queryByText('Old budget')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Archived' }));
    expect(screen.getByText('Old budget')).toBeTruthy();
    expect(screen.queryByText('Fuel log')).toBeNull();
  });
  it('says what a starter does: it makes a draft you can look over', () => {
    render(<BobAppsPage />);
    expect(screen.queryByText(/preview/i)).toBeNull();
    expect(screen.getByText(/opens as a draft/)).toBeTruthy();
  });
  it('explains Marketing in plain words, without the internal publishing wording', () => {
    render(<BobAppsPage />);
    expect(screen.getByText('Bob Marketing')).toBeTruthy();
    expect(screen.queryByText(/No channel connection/)).toBeNull();
    expect(screen.getByText(/Nothing gets posted for you\.$/)).toBeTruthy();
    expect(screen.queryByText(/you copy/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Install Marketing' })).toBeTruthy();
  });
  it('does not claim nothing gets posted once publishing is available', () => {
    apps.capability = 'available';
    render(<BobAppsPage />);
    expect(screen.queryByText(/Nothing gets posted for you/)).toBeNull();
  });
});
