import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { navigateTo } from '@/app/routes';
import { InsightsPage } from './insights-page';

const state = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>(), owner: 'owner' }));
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth: state.fetch, useSession: () => ({ session: { user: { id: state.owner } } }) }));
vi.mock('@/lib/use-refresh-on-focus', () => ({ useRefreshOnFocus: () => 0 }));
const insight = { id: 'insight-1', routineId: 'routine-1', googleAccountId: 'account-1', category: 'past', title: 'Your morning email summary', summary: 'Three messages to catch up on.', periodStart: 1, periodEnd: 2, generatedAt: 3, sources: [{ kind: 'gmail', id: 'm1', label: 'Project update', url: 'https://mail.google.com/mail/u/0/#inbox/m1' }], partial: true, messageCount: 3 };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => { state.fetch.mockReset(); state.owner = 'owner'; window.history.replaceState(null, '', '/insights/past'); });

it('shows saved result provenance, period, partial status and secure source links', async () => {
  state.fetch.mockResolvedValue(json({ insights: [insight] }));
  render(<InsightsPage />);
  expect(await screen.findByRole('heading', { name: insight.title })).toBeTruthy();
  expect(screen.getByText(insight.summary)).toBeTruthy();
  expect(screen.getByText('A partial picture')).toBeTruthy();
  expect(screen.getByText(/3 messages reviewed/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Sources (1)' }));
  const source = screen.getByRole('link', { name: /Project update/ });
  expect(source.getAttribute('href')).toBe(insight.sources[0]?.url);
  expect(source.getAttribute('rel')).toContain('noopener');
  expect(screen.getByRole('article', { name: insight.title }).id).toBe(insight.id);
});

it('switches all three URL-backed tabs without inventing a forecast', async () => {
  state.fetch.mockImplementation(async (url) => json(String(url) === '/api/google-accounts' ? { accounts: [] } : { insights: [] }));
  render(<InsightsPage />);
  await screen.findByText('A fresh start for past');
  fireEvent.click(screen.getByRole('link', { name: 'Future' }));
  expect(window.location.pathname).toBe('/insights/future');
  expect(await screen.findByText(/No outlooks yet/)).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: 'Reflections' }));
  expect(await screen.findByText(/No reflections yet/)).toBeTruthy();
  expect(state.fetch.mock.calls.map(([url]) => url).filter((url) => String(url).startsWith('/api/insights'))).toEqual(['/api/insights?category=past', '/api/insights?category=future', '/api/insights?category=reflections']);
});

it('keeps insights separate from routine configuration across populated tabs', async () => {
  state.fetch.mockImplementation(async (url) => {
    if (String(url) === '/api/google-accounts') return json({ accounts: [] });
    const category = new URL(String(url), window.location.origin).searchParams.get('category');
    return json({ insights: [{ ...insight, category, title: `${category} result` }] });
  });
  render(<InsightsPage />);
  for (const [label, category] of [['Past', 'past'], ['Future', 'future'], ['Reflections', 'reflections']]) {
    fireEvent.click(screen.getByRole('link', { name: label }));
    expect(await screen.findByRole('heading', { name: `${category} result` })).toBeTruthy();
    expect(window.location.pathname).toBe(`/insights/${category}`);
    expect(screen.queryByRole('link', { name: 'Create or manage routines' })).toBeNull();
  }
});

it('keeps insight loading and retry independent of routines', async () => {
  let rejectLoad: (error: Error) => void = () => {};
  state.fetch.mockImplementation(async () => new Promise<Response>((_resolve, reject) => { rejectLoad = reject; }));
  render(<InsightsPage />);
  expect(screen.getByText('Opening your insights…')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Create or manage routines' })).toBeNull();
  await act(async () => rejectLoad(new Error('offline')));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Create or manage routines' })).toBeNull();
});

it('ignores an earlier tab response after navigation', async () => {
  let resolvePast: (response: Response) => void = () => {};
  state.fetch.mockImplementation(async (url) => String(url).endsWith('past') ? new Promise<Response>((resolve) => { resolvePast = resolve; }) : json({ insights: [] }));
  render(<InsightsPage />);
  act(() => navigateTo('/insights/future'));
  await screen.findByText(/No outlooks yet/);
  await act(async () => { resolvePast(json({ insights: [insight] })); });
  expect(screen.queryByText(insight.summary)).toBeNull();
});

it('clears a previous owner’s private results when the signed-in owner changes', async () => {
  state.fetch.mockResolvedValue(json({ insights: [insight] }));
  const { rerender } = render(<InsightsPage />);
  await screen.findByText(insight.summary);
  state.owner = 'next-owner';
  state.fetch.mockImplementation(async () => new Promise<Response>(() => {}));
  rerender(<InsightsPage />);
  expect(screen.queryByText(insight.summary)).toBeNull();
  expect(screen.getByText('Opening your insights…')).toBeTruthy();
});

it('rejects an unsafe source URL and gives a retry instead of rendering it', async () => {
  state.fetch.mockResolvedValue(json({ insights: [{ ...insight, sources: [{ ...insight.sources[0], url: 'javascript:alert(1)' }] }] }));
  render(<InsightsPage />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText(insight.summary)).toBeNull();
  state.fetch.mockResolvedValue(json({ insights: [] }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(screen.queryByRole('link', { name: 'Manage routines' })).toBeNull();
});

it('shows reflection coverage from its summary without inventing a zero message total', async () => {
  window.history.replaceState(null, '', '/insights/reflections');
  const reflection = { ...insight, category: 'reflections', partial: false, messageCount: 0, summary: 'Your saved recaps cover 8 messages across two periods.' };
  state.fetch.mockImplementation(async (url) => json(String(url) === '/api/google-accounts' ? { accounts: [] } : { insights: [reflection] }));
  render(<InsightsPage />);
  expect(await screen.findByText(reflection.summary)).toBeTruthy();
  expect(screen.queryByText('0 messages included')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Sources (1)' }));
  expect(screen.getByRole('link', { name: /Project update/ })).toBeTruthy();
});
