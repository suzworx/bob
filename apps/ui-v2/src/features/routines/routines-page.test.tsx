import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { navigateTo } from '@/app/routes';
import { RoutinesPage } from './routines-page';

const fetchWithAuth = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth, useSession: () => ({ session: { user: { id: 'owner' } } }) }));
vi.mock('./routine-conversation', () => ({ RoutineConversation: ({ onTurnFinished }: { onTurnFinished: () => void }) => <button onClick={onTurnFinished}>Finish Bob turn</button> }));
vi.mock('@/lib/use-refresh-on-focus', () => ({ useRefreshOnFocus: () => 0 }));
HTMLDialogElement.prototype.showModal = function showModal(): void { this.setAttribute('open', ''); };
HTMLDialogElement.prototype.close = function close(): void { this.removeAttribute('open'); };
const account = { id: '7a0f3c3f-8d2b-5e4f-ab6c-1d2e3f4a5b6c', email: 'morning@example.com', name: null, selected: true, createdAt: 1, access: ['gmail.read'], needsReconnect: false };
const routine = { id: '914b82c0-d12c-43ad-a7de-4da862bd8bbc', kind: 'daily_gmail_digest', googleAccountId: account.id, scheduledReadConsent: true, emailResult: false, status: 'active', revision: 1, localTime: '08:00', timeZone: 'America/Los_Angeles', nextRunAt: Date.UTC(2026, 9, 23, 15), createdAt: 1, updatedAt: 1 };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  fetchWithAuth.mockReset();
  window.history.replaceState(null, '', '/routines#' + routine.id);
  fetchWithAuth.mockImplementation(async (url) => String(url) === '/api/google-accounts' ? json({ accounts: [account] }) : json({ routines: [routine] }));
});

it('shows the explicit account, local schedule and next run without claiming a completed summary', async () => {
  render(<RoutinesPage />);
  expect(await screen.findByText('morning@example.com')).toBeTruthy();
  expect(screen.getByText('Active · Every day at 08:00 (America/Los_Angeles)')).toBeTruthy();
  expect(screen.getByText(/^Next:/).textContent).toContain('America/Los_Angeles');
  expect(screen.queryByRole('link', { name: 'View summary' })).toBeNull();
});

it('requires an explicit account and unchecked scheduled-read consent before creating', async () => {
  fetchWithAuth.mockImplementation(async (url, init) => {
    if (String(url) === '/api/google-accounts') return json({ accounts: [account] });
    if (init?.method === 'POST') return json({ routine }, 201);
    return json({ routines: [] });
  });
  render(<RoutinesPage />);
  await screen.findByText('Give your mornings a little head start');
  fireEvent.click(screen.getByRole('button', { name: 'New routine' }));
  const create = screen.getByRole('button', { name: 'Create routine' });
  expect(create.hasAttribute('disabled')).toBe(true);
  const consent = screen.getByRole('checkbox', { name: "Let Bob read this account's emails on this schedule" });
  expect((consent as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('combobox', { name: 'Google account' }));
  fireEvent.click(await screen.findByRole('option', { name: 'morning@example.com' }));
  expect(create.hasAttribute('disabled')).toBe(true);
  fireEvent.click(consent);
  fireEvent.change(screen.getByRole('textbox', { name: 'Time zone' }), { target: { value: 'America/Los_Angeles' } });
  fireEvent.click(create);
  await waitFor(() => expect(fetchWithAuth.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
  const call = fetchWithAuth.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ kind: 'daily_gmail_digest', googleAccountId: account.id, scheduledReadConsent: true, localTime: '08:00', timeZone: 'America/Los_Angeles' });
});

it('keeps routine email off by default and saves an explicit opt-in', async () => {
  fetchWithAuth.mockImplementation(async (url, init) => {
    if (String(url) === '/api/google-accounts') return json({ accounts: [account] });
    if (init?.method === 'POST') return json({ routine: { ...routine, ...JSON.parse(String(init.body)), id: routine.id } }, 201);
    return json({ routines: [] });
  });
  render(<RoutinesPage />);
  await screen.findByText('Give your mornings a little head start');
  fireEvent.click(screen.getByRole('button', { name: 'New routine' }));
  const emailPreference = screen.getByRole('checkbox', { name: 'Email me when a recap is ready' }) as HTMLInputElement;
  expect(emailPreference.checked).toBe(false);
  fireEvent.click(screen.getByRole('combobox', { name: 'Google account' }));
  fireEvent.click(await screen.findByRole('option', { name: 'morning@example.com' }));
  fireEvent.click(screen.getByRole('checkbox', { name: "Let Bob read this account's emails on this schedule" }));
  fireEvent.click(emailPreference);
  fireEvent.click(screen.getByRole('button', { name: 'Create routine' }));
  await waitFor(() => expect(fetchWithAuth.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
  const call = fetchWithAuth.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ emailResult: true });
});

it('loads and keeps an existing routine email preference when saving settings', async () => {
  const savedRoutine = { ...routine, emailResult: true };
  fetchWithAuth.mockImplementation(async (url, init) => {
    if (String(url) === '/api/google-accounts') return json({ accounts: [account] });
    if (init?.method === 'PATCH') return json({ routine: { ...savedRoutine, ...JSON.parse(String(init.body)), revision: 2 } });
    return json({ routines: [savedRoutine] });
  });
  render(<RoutinesPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Configure routine' }));
  const emailPreference = screen.getByRole('checkbox', { name: 'Email me when a recap is ready' }) as HTMLInputElement;
  expect(emailPreference.checked).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: 'Time zone' }), { target: { value: 'Europe/London' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(fetchWithAuth.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
  const call = fetchWithAuth.mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ emailResult: true, expectedRevision: 1 });
});

it('does not offer a reconnect-needed account for new scheduled reads', async () => {
  fetchWithAuth.mockImplementation(async (url) => String(url) === '/api/google-accounts' ? json({ accounts: [{ ...account, needsReconnect: true }] }) : json({ routines: [] }));
  render(<RoutinesPage />);
  await screen.findByText('Give your mornings a little head start');
  fireEvent.click(screen.getByRole('button', { name: 'New routine' }));
  expect(screen.getByText('Connect an account with Gmail access first')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Manage integrations' }).getAttribute('href')).toBe('/integrations');
  expect(screen.getByRole('button', { name: 'Create routine' }).hasAttribute('disabled')).toBe(true);
});

it('pauses with the displayed revision, then shows the saved paused state', async () => {
  let paused = false;
  fetchWithAuth.mockImplementation(async (url, init) => {
    if (String(url) === '/api/google-accounts') return json({ accounts: [account] });
    if (init?.method === 'PATCH') {
      expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: 1, status: 'paused' });
      paused = true;
      return json({ routine: { ...routine, status: 'paused', revision: 2, nextRunAt: null } });
    }
    return json({ routines: [{ ...routine, ...(paused ? { status: 'paused', revision: 2, nextRunAt: null } : {}) }] });
  });
  render(<RoutinesPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
  expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
  expect(screen.getByText('No run scheduled')).toBeTruthy();
});

it('preserves the routine after a revision conflict and offers refresh', async () => {
  fetchWithAuth.mockImplementation(async (url, init) => {
    if (init?.method === 'PATCH') return json({ error: 'routine_conflict' }, 409);
    return String(url) === '/api/google-accounts' ? json({ accounts: [account] }) : json({ routines: [routine] });
  });
  render(<RoutinesPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
  expect(await screen.findByText('This routine changed elsewhere. Refresh to see the latest version.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
});

it('changes the schedule without changing the authorized account or consent', async () => {
  fetchWithAuth.mockImplementation(async (url, init) => {
    if (init?.method === 'PATCH') return json({ routine: { ...routine, timeZone: 'Europe/London', revision: 2 } });
    return String(url) === '/api/google-accounts' ? json({ accounts: [account] }) : json({ routines: [routine] });
  });
  render(<RoutinesPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Configure routine' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Time zone' }), { target: { value: 'Europe/London' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(fetchWithAuth.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
  const call = fetchWithAuth.mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ localTime: '08:00', timeZone: 'Europe/London', expectedRevision: 1 });
});

it('rejects an invalid timezone before sending an edit', async () => {
  render(<RoutinesPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Configure routine' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Time zone' }), { target: { value: 'Not/AZone' } });
  expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('Choose a valid time and time zone.')).toBeTruthy();
});

it('requires archive confirmation and sends its revision only after confirming', async () => {
  let deleted = false;
  fetchWithAuth.mockImplementation(async (url, init) => {
    if (init?.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
    return String(url) === '/api/google-accounts' ? json({ accounts: [account] }) : json({ routines: deleted ? [] : [routine] });
  });
  render(<RoutinesPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
  expect(fetchWithAuth.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Archive routine' }));
  expect(await screen.findByText('Give your mornings a little head start')).toBeTruthy();
  expect(JSON.parse(String(fetchWithAuth.mock.calls.find(([, init]) => init?.method === 'DELETE')?.[1]?.body))).toEqual({ expectedRevision: 1 });
});

it('opens run history on demand without navigating to insights', async () => {
  fetchWithAuth.mockImplementation(async (url) => {
    if (String(url).endsWith('/runs')) return json({ runs: [{ id: 'run-1', routineId: routine.id, scheduledAt: 1, startedAt: 2, completedAt: 3, status: 'completed', failureCode: null, insightId: 'result-1' }] });
    return String(url) === '/api/google-accounts' ? json({ accounts: [account] }) : json({ routines: [routine] });
  });
  render(<RoutinesPage />);
  await screen.findByText('morning@example.com');
  expect(fetchWithAuth.mock.calls.some(([url]) => String(url).endsWith('/runs'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Run history' }));
  fireEvent.click(await screen.findByRole('button', { name: /Ready/ }));
  expect(await screen.findByText('This run finished, but its saved recap is no longer available.')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'View summary' })).toBeNull();
});

it('shows queued and muted email outcomes without claiming the email was sent', async () => {
  fetchWithAuth.mockImplementation(async (url) => {
    if (String(url).endsWith('/runs')) return json({ runs: [
      { id: 'run-queued', routineId: routine.id, scheduledAt: 1, startedAt: 2, completedAt: 3, status: 'completed', failureCode: null, insightId: null, emailOutcome: 'queued' },
      { id: 'run-muted', routineId: routine.id, scheduledAt: 2, startedAt: 2, completedAt: 3, status: 'completed', failureCode: null, insightId: null, emailOutcome: 'muted' },
    ] });
    return String(url) === '/api/google-accounts' ? json({ accounts: [account] }) : json({ routines: [routine] });
  });
  render(<RoutinesPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Run history' }));
  const readyRuns = await screen.findAllByRole('button', { name: /Ready/ });
  for (const readyRun of readyRuns) fireEvent.click(readyRun);
  expect(await screen.findByText('Email notification queued')).toBeTruthy();
  expect(screen.getByText('Your notification preferences muted this email')).toBeTruthy();
  expect(screen.queryByText(/Email sent/)).toBeNull();
});

it('shows a retriable failure instead of an empty successful list', async () => {
  fetchWithAuth.mockResolvedValue(json({}, 503));
  render(<RoutinesPage />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText('Give your mornings a little head start')).toBeNull();
  fetchWithAuth.mockImplementation(async (url) => String(url) === '/api/google-accounts' ? json({ accounts: [account] }) : json({ routines: [] }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
  expect(await screen.findByText('Give your mornings a little head start')).toBeTruthy();
});


it('refreshes existing routines and expanded run history after a Bob turn', async () => {
  fetchWithAuth.mockImplementation(async (url) => {
    if (String(url).endsWith('/runs')) return json({ runs: [] });
    return String(url) === '/api/google-accounts' ? json({ accounts: [account] }) : json({ routines: [routine] });
  });
  render(<RoutinesPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Run history' }));
  await screen.findByText('No runs yet. Bob will start at the next scheduled time.');
  fetchWithAuth.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Ask Bob' }));
  fireEvent.click(screen.getByRole('button', { name: 'Finish Bob turn' }));
  await waitFor(() => {
    expect(fetchWithAuth.mock.calls.some(([url]) => String(url) === '/api/routines?includeArchived=true')).toBe(true);
    expect(fetchWithAuth.mock.calls.some(([url]) => String(url).endsWith('/runs'))).toBe(true);
  });
});

it('starts with the routine list and opens one routine without mounting its conversation', async () => {
  window.history.replaceState(null, '', '/routines');
  render(<RoutinesPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Email recap/ }));
  expect(await screen.findByRole('heading', { name: 'At a glance' })).toBeTruthy();
  expect(window.location.hash).toBe(`#${routine.id}`);
  expect(screen.queryByRole('button', { name: 'Finish Bob turn' })).toBeNull();
  act(() => navigateTo('/routines'));
  expect(screen.getByRole('heading', { name: 'Your routines' })).toBeTruthy();
});

it('requires fresh consent when switching a routine to another account', async () => {
  const second = { ...account, id: '614b82c0-d12c-43ad-a7de-4da862bd8bb1', email: 'other@example.com' };
  fetchWithAuth.mockImplementation(async (url, init) => {
    if (String(url) === '/api/google-accounts') return json({ accounts: [account, second] });
    if (init?.method === 'PATCH') return json({ routine: { ...routine, googleAccountId: second.id, revision: 2 } });
    return json({ routines: [routine] });
  });
  render(<RoutinesPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Configure routine' }));
  fireEvent.click(screen.getByRole('combobox', { name: 'Google account' }));
  fireEvent.click(await screen.findByRole('option', { name: second.email }));
  const save = screen.getByRole('button', { name: 'Save changes' });
  expect(save.hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: "Let Bob read this account's emails on this schedule" }));
  fireEvent.click(save);
  await waitFor(() => expect(fetchWithAuth.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
  const call = fetchWithAuth.mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ googleAccountId: second.id, scheduledReadConsent: true, expectedRevision: 1 });
});

it('keeps archived routines reachable through the archive filter and direct history link', async () => {
  const archived = { ...routine, name: 'Earlier recap', status: 'archived', nextRunAt: null };
  fetchWithAuth.mockImplementation(async (url) => {
    if (String(url) === '/api/google-accounts') return json({ accounts: [account] });
    if (String(url).endsWith('/runs')) return json({ runs: [{ id: 'run-1', routineId: routine.id, scheduledAt: 1, startedAt: 2, completedAt: 3, status: 'completed', failureCode: null, insightId: null }] });
    expect(String(url)).toBe('/api/routines?includeArchived=true');
    return json({ routines: [archived] });
  });
  window.history.replaceState(null, '', '/routines');
  render(<RoutinesPage />);
  await screen.findByText('No current routines. Your past recaps are in Archived.');
  fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
  fireEvent.click(screen.getByRole('button', { name: /Earlier recap/ }));
  expect(await screen.findByRole('heading', { name: 'Earlier recap' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Configure routine' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Run history' }));
  expect(await screen.findByRole('button', { name: /Ready/ })).toBeTruthy();
  act(() => navigateTo('/routines'));
  act(() => navigateTo(`/routines#${routine.id}`));
  expect(await screen.findByRole('heading', { name: 'Earlier recap' })).toBeTruthy();
});

// jsdom loads no StyleX, so the real clip styles cannot be read: stand in a marker for VisuallyHidden.
const shell = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@astryxdesign/core/AppShell', async (original) => {
  const actual = await original<typeof import('@astryxdesign/core/AppShell')>();
  return { ...actual, useAppShellMobile: () => ({ ...actual.useAppShellMobile(), isMobile: shell.isMobile }) };
});
vi.mock('@astryxdesign/core/VisuallyHidden', () => ({ VisuallyHidden: ({ children }: { children: ReactNode }) => <div data-testid="visually-hidden">{children}</div> }));

it.each([[true, 'phone'], [false, 'desktop']])('frames the list header for %s (%s)', async (isMobile) => {
  shell.isMobile = isMobile;
  window.history.replaceState(null, '', '/routines');
  render(<RoutinesPage />);
  const title = await screen.findByRole('heading', { level: 1, name: 'Routines' });
  expect(Boolean(title.closest('[data-testid="visually-hidden"]'))).toBe(isMobile);
  expect(screen.getByRole('button', { name: 'New routine' })).toBeTruthy();
  expect(Boolean(screen.queryByRole('button', { name: 'Refresh' }))).toBe(!isMobile);
  if (isMobile) {
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(await screen.findByRole('menuitem', { name: 'Refresh' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Daily timeline' })).toBeTruthy();
  }
  shell.isMobile = false;
});
