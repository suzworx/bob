import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { NotificationSettingsSection } from './notification-settings';

vi.mock('@/lib/auth/use-session', () => ({
  useSession: () => ({ session: { user: { id: 'u-self' } } }),
  fetchWithAuth: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

function preference(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    user_id: 'u-self',
    space_id: null,
    thread_id: null,
    type: 'reminder',
    muted: true,
    quiet_hours_start: null,
    quiet_hours_end: null,
    quiet_zone: null,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Handler = (init?: RequestInit) => Response | Promise<Response>;

function stubFetch(overrides: Record<string, Handler> = {}): ReturnType<typeof vi.fn> {
  const routes: Record<string, Handler> = {
    'GET /api/notification-preferences': () => json({ preferences: [] }),
    ...overrides,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`;
    const route = routes[key];
    if (!route) throw new Error(`unrouted request: ${key}`);
    return route(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, method: string, path: string): unknown[][] {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input).split('?')[0] === path && ((init as RequestInit | undefined)?.method ?? 'GET') === method,
  );
}

function renderSettings(): void {
  render(
    <Theme theme={neutralTheme} mode="system">
      <NotificationSettingsSection />
    </Theme>,
  );
}

function switchChecked(name: string | RegExp): boolean {
  return (screen.getByRole('switch', { name }) as HTMLInputElement).checked;
}

describe('NotificationSettingsSection', () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows Skeleton rows while loading, then one switch per kind, all on by default', async () => {
    stubFetch();
    renderSettings();
    expect(screen.getByRole('status', { name: 'Loading notification settings' })).toBeTruthy();
    await screen.findByText('Choose what shows up in your notifications.');
    for (const name of [
      'Mentions', 'Task assignments', 'Tasks you follow', 'Reminders', 'Events', 'Space members', 'Notes from Bob',
    ]) {
      expect(switchChecked(name)).toBe(true);
    }
  });

  it('an account-wide muted row mutes that switch, a space-scoped one does not', async () => {
    stubFetch({
      'GET /api/notification-preferences': () =>
        json({
          preferences: [
            preference({ id: 'p1', type: 'reminder', space_id: null, muted: true }),
            preference({ id: 'p2', type: 'mention', space_id: 's1', muted: true }),
          ],
        }),
    });
    renderSettings();
    await screen.findByText('Choose what shows up in your notifications.');
    expect(switchChecked('Reminders')).toBe(false);
    expect(switchChecked('Mentions')).toBe(true);
  });

  it('lets the user mute Bob notes with an account-wide setting', async () => {
    const fetchMock = stubFetch({
      'PUT /api/notification-preferences': () => json(preference({ type: 'bob_message', muted: true })),
    });
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText('Choose what shows up in your notifications.');

    await user.click(screen.getByRole('switch', { name: 'Notes from Bob' }));

    await waitFor(() => expect(callsTo(fetchMock, 'PUT', '/api/notification-preferences')).toHaveLength(1));
    const [, init] = callsTo(fetchMock, 'PUT', '/api/notification-preferences')[0] as [unknown, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ type: 'bob_message', muted: true });
    expect(switchChecked('Notes from Bob')).toBe(false);
  });

  it('security notices are always on: a switch that is on and cannot be turned off', async () => {
    const fetchMock = stubFetch();
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText('Choose what shows up in your notifications.');
    const security = screen.getByRole('switch', { name: /Security notices/ }) as HTMLInputElement;
    expect(security.checked).toBe(true);
    await user.click(security);
    expect(security.checked).toBe(true);
    expect(callsTo(fetchMock, 'PUT', '/api/notification-preferences')).toHaveLength(0);
  });

  it('turning Mentions off sends a PUT and keeps the switch off', async () => {
    const fetchMock = stubFetch({
      'PUT /api/notification-preferences': () => json(preference({ id: 'p3', type: 'mention', muted: true })),
    });
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText('Choose what shows up in your notifications.');

    await user.click(screen.getByRole('switch', { name: 'Mentions' }));

    await waitFor(() => expect(callsTo(fetchMock, 'PUT', '/api/notification-preferences')).toHaveLength(1));
    const [, init] = callsTo(fetchMock, 'PUT', '/api/notification-preferences')[0] as [unknown, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ type: 'mention', muted: true });
    expect(switchChecked('Mentions')).toBe(false);
  });

  it('a failed save turns the switch back on and shows an error banner', async () => {
    const fetchMock = stubFetch({
      'PUT /api/notification-preferences': () => new Response(null, { status: 500 }),
    });
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText('Choose what shows up in your notifications.');

    await user.click(screen.getByRole('switch', { name: 'Mentions' }));

    await waitFor(() => expect(callsTo(fetchMock, 'PUT', '/api/notification-preferences')).toHaveLength(1));
    expect(await screen.findByText("Couldn't save that setting. Try again.")).toBeTruthy();
    await waitFor(() => expect(switchChecked('Mentions')).toBe(true));
  });

  it('shows a retry banner on a failed load, and Retry refetches', async () => {
    let failing = true;
    const fetchMock = stubFetch({
      'GET /api/notification-preferences': () =>
        failing ? new Response(null, { status: 500 }) : json({ preferences: [] }),
    });
    const user = userEvent.setup();
    renderSettings();
    expect(await screen.findByText("Couldn't load notification settings.")).toBeTruthy();

    failing = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Choose what shows up in your notifications.');
    expect(callsTo(fetchMock, 'GET', '/api/notification-preferences').length).toBeGreaterThanOrEqual(2);
  });
});
