import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDeviceOnline, type Device } from './devices-api';
import { notifyDevicesChanged } from './devices-events';
import { useDevices } from './use-devices';
import { useDevicesSummary } from './use-devices-summary';

const fetchWithAuth = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));

const LIVE_OFF = { connected: false, battery_pct: null, charging: null, fw_version: null };
const row = (id: string, connected: boolean | undefined, live = false) => ({ id, name: id, connected, live: { ...LIVE_OFF, connected: live } }) as unknown as Device;
let devices: Device[];

beforeEach(() => {
  devices = [row('a', true), row('b', false, true), row('c', false)];
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async () => new Response(JSON.stringify({ devices, active_space: null, active_conversation: null })));
});
afterEach(cleanup);

describe('isDeviceOnline: the one rule', () => {
  it('is online when either the row or its live state says connected', () => {
    expect(isDeviceOnline(row('x', true))).toBe(true);
    expect(isDeviceOnline(row('x', undefined, true))).toBe(true);
    expect(isDeviceOnline(row('x', false, false))).toBe(false);
  });
});

describe('useDevicesSummary', () => {
  it('counts paired and online devices, and follows device.changed', async () => {
    const { result } = renderHook(() => useDevicesSummary());
    await waitFor(() => expect(result.current).toEqual({ connected: 2, total: 3 }));
    devices = [row('a', false)];
    act(() => notifyDevicesChanged());
    await waitFor(() => expect(result.current).toEqual({ connected: 0, total: 1 }));
  });

  it('every surface shares one read', async () => {
    const first = renderHook(() => useDevices());
    const second = renderHook(() => useDevicesSummary());
    await waitFor(() => expect(first.result.current.state).toBe('ready'));
    await waitFor(() => expect(second.result.current.total).toBe(3));
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
});
