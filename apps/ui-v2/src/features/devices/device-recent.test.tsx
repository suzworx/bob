import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Space } from '@/features/spaces/use-spaces';
import { DeviceRecent, newestTurnAt, useDeviceActivity, type DeviceActivity, type DeviceActivityItem } from './device-recent';
import { spacePath } from '../../app/routes';

const fetchWithAuth = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));

const DEVICE = '6f9f2b2e-7c1a-4d3e-9a5b-0c1d2e3f4a5b';
const GARDEN: Space = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Garden', kind: 'group', role: 'owner', membership_revision: 1, created_at: 1, updated_at: 1, members: [],
};
const THREAD = '33333333-3333-4333-8333-333333333333';
const NOW = Date.now();
const GENERAL_TURN: DeviceActivityItem = { kind: 'turn', at: NOW - 60_000, title: 'Trip plan', heard_excerpt: 'what time is the train', conversation_id: 'cnv_1' };
const THREAD_TURN: DeviceActivityItem = { kind: 'turn', at: NOW - 120_000, title: 'Seeds', heard_excerpt: 'order more basil', thread_id: THREAD, space_id: GARDEN.id };
const TIMER: DeviceActivityItem = { kind: 'timer', at: NOW - 30_000, label: 'Pasta', status: 'fired', scope: 'account' };

// A description mixes text and a <Timestamp>, so it is matched as one line.
function lineStarting(prefix: string): HTMLElement {
  return screen.getAllByText((_content, element) => element?.tagName === 'SPAN' && (element.textContent ?? '').startsWith(prefix))[0];
}

function ready(items: DeviceActivityItem[]): DeviceActivity {
  return { state: 'ready', items };
}

beforeEach(() => fetchWithAuth.mockReset());
afterEach(() => window.history.replaceState(null, '', '/'));

describe('useDeviceActivity', () => {
  it('asks for the five newest items of this device', async () => {
    fetchWithAuth.mockResolvedValueOnce(new Response(JSON.stringify({ items: [GENERAL_TURN] })));
    const { result } = renderHook(() => useDeviceActivity(DEVICE));
    expect(result.current).toMatchObject({ state: 'loading' });
    await waitFor(() => expect(result.current).toMatchObject(ready([GENERAL_TURN])));
    expect(fetchWithAuth).toHaveBeenCalledWith(`/api/devices/${DEVICE}/activity?limit=5`);
  });

  it('fails on a refusal and on a network error', async () => {
    fetchWithAuth.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    const refused = renderHook(() => useDeviceActivity(DEVICE));
    await waitFor(() => expect(refused.result.current).toMatchObject({ state: 'failed' }));
    fetchWithAuth.mockRejectedValueOnce(new Error('offline'));
    const offline = renderHook(() => useDeviceActivity(DEVICE));
    await waitFor(() => expect(offline.result.current).toMatchObject({ state: 'failed' }));
  });

  it('keeps the loaded list when a refresh fails', async () => {
    fetchWithAuth.mockResolvedValueOnce(new Response(JSON.stringify({ items: [GENERAL_TURN] })));
    const { result, rerender } = renderHook(({ key }) => useDeviceActivity(DEVICE, key), { initialProps: { key: 0 } });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    fetchWithAuth.mockRejectedValueOnce(new Error('offline'));
    rerender({ key: 1 });
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
    expect(result.current).toMatchObject(ready([GENERAL_TURN]));
  });

  it('Retry reads again after a failure', async () => {
    fetchWithAuth.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useDeviceActivity(DEVICE));
    await waitFor(() => expect(result.current.state).toBe('failed'));
    fetchWithAuth.mockResolvedValueOnce(new Response(JSON.stringify({ items: [GENERAL_TURN] })));
    act(() => result.current.retry?.());
    await waitFor(() => expect(result.current).toMatchObject(ready([GENERAL_TURN])));
  });
});

describe('newestTurnAt', () => {
  it('is the newest turn, skipping timers, and null with no turns', () => {
    expect(newestTurnAt(ready([TIMER, GENERAL_TURN, THREAD_TURN]))).toBe(GENERAL_TURN.at);
    expect(newestTurnAt(ready([TIMER]))).toBeNull();
    expect(newestTurnAt({ state: 'loading' })).toBeNull();
  });
});

describe('DeviceRecent', () => {
  it('lists a General turn: heard words, "title · General" and when', () => {
    render(<DeviceRecent deviceName="Kitchen" activity={ready([GENERAL_TURN])} spaces={[GARDEN]} />);
    expect(screen.getByText('“what time is the train”')).toBeTruthy();
    expect(lineStarting('Trip plan · General · ')).toBeTruthy();
    expect(lineStarting('Trip plan · General · ').textContent).toMatch(/min/);
  });

  it('names the space of a thread turn and opens the thread', async () => {
    const user = userEvent.setup();
    render(<DeviceRecent deviceName="Kitchen" activity={ready([THREAD_TURN])} spaces={[GARDEN]} />);
    expect(lineStarting('Seeds · Garden · ')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /order more basil/ }));
    expect(window.location.pathname).toBe(spacePath(GARDEN.id, 'threads', THREAD));
  });

  it('opens the chat of a General turn', async () => {
    const user = userEvent.setup();
    render(<DeviceRecent deviceName="Kitchen" activity={ready([GENERAL_TURN])} spaces={[]} />);
    await user.click(screen.getByRole('button', { name: /what time is the train/ }));
    expect(window.location.pathname).toBe('/c/cnv_1');
  });

  it('shows a timer with its status and the account-wide note', () => {
    render(<DeviceRecent deviceName="Kitchen" activity={ready([TIMER, { ...TIMER, at: 1, label: null, status: 'dismissed' }])} spaces={[]} />);
    expect(screen.getByText('Timer: Pasta, rang')).toBeTruthy();
    expect(screen.getByText('Timer: untitled, dismissed')).toBeTruthy();
    // The account-wide note shows once, not on every timer row.
    expect(screen.getAllByText(/A timer rings on every device on your account/)).toHaveLength(1);
  });

  it('says so when there is nothing yet, while loading, and on failure', () => {
    const { rerender } = render(<DeviceRecent deviceName="Kitchen" activity={ready([])} spaces={[]} />);
    expect(screen.getByText('Nothing yet. What you say to Kitchen shows up here.')).toBeTruthy();
    rerender(<DeviceRecent deviceName="Kitchen" activity={{ state: 'loading' }} spaces={[]} />);
    expect(screen.getByRole('status', { name: 'Loading recent activity' })).toBeTruthy();
    rerender(<DeviceRecent deviceName="Kitchen" activity={{ state: 'failed' }} spaces={[]} />);
    expect(screen.getByText("Couldn't load recent activity.")).toBeTruthy();
  });
});
