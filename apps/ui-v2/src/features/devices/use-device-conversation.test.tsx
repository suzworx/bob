import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { notifyDevicesChanged } from './devices-events';
import { DEVICE_APPLIED, DEVICE_STATUS, useDeviceConversation } from './use-device-conversation';

let serverActive: { conversation_id: string; title: string } | null;
let putStatus: number;
let connected: boolean;
// #900: d1's own pointer; null (the default) means it has none of its own.
let ownPointerId: string | null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function puts(): unknown[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([url, init]) => url === '/api/devices/active-conversation' && init?.method === 'PUT')
    .map(([, init]) => JSON.parse(String(init?.body)));
}

// Shared by every describe below, so the device-scoped tests get the same
// fetch stub as the account-wide ones.
beforeEach(() => {
  serverActive = null;
  putStatus = 200;
  connected = false;
  ownPointerId = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === '/api/active') return json({ active: serverActive });
      if (url === '/api/devices') {
        return json({
          devices: [{ id: 'd1', connected, live: { connected }, active_conversation_id: ownPointerId }],
          active_conversation: serverActive && { id: serverActive.conversation_id, title: serverActive.title },
        });
      }
      if (url === '/api/devices/active-conversation' && init?.method === 'PUT') {
        if (putStatus === 202) return json({ status: 'pending' }, 202);
        if (putStatus !== 200) return json({ error: { code: putStatus === 409 ? 'no_device' : 'x' } }, putStatus);
        const body = JSON.parse(String(init.body)) as { conversation_id: string | null };
        serverActive = body.conversation_id ? { conversation_id: body.conversation_id, title: 'Trip plan' } : null;
        return json({});
      }
      throw new Error(`unrouted fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useDeviceConversation', () => {

  it('reads the pointer, and re-reads it when bob:active-changed fires', async () => {
    serverActive = { conversation_id: 'c1', title: 'Trip plan' };
    const { result } = renderHook(() => useDeviceConversation());
    await waitFor(() => expect(result.current.activeTitle).toBe('Trip plan'));
    serverActive = null;
    act(() => {
      window.dispatchEvent(new Event('bob:active-changed'));
    });
    await waitFor(() => expect(result.current.activeId).toBeNull());
  });

  it('Use on device sends the conversation in the main space, once, and follows the server', async () => {
    const { result } = renderHook(() => useDeviceConversation());
    const use = result.current.items({ conversationId: 'c1', spaceId: 's1' })[0]!;
    expect(use).toMatchObject({ label: 'Use on device' });
    await act(async () => {
      if ('onClick' in use) use.onClick?.();
    });
    await waitFor(() => expect(result.current.activeId).toBe('c1'));
    expect(puts()).toEqual([{ conversation_id: 'c1', space_id: null }]);
    expect(result.current.status).toEqual({ key: 'c1', text: 'Sent to device.' });
    // Now it is the device's conversation, the item says so and is off.
    const now = result.current.items({ conversationId: 'c1', spaceId: null })[0]!;
    expect(now).toMatchObject({ isDisabled: true, description: 'device is in this conversation' });
  });

  it('New conversation on device clears the conversation in the given space', async () => {
    const { result } = renderHook(() => useDeviceConversation());
    const items = result.current.items({ spaceId: 's1', statusKey: 'thread' });
    expect(items.map((item) => ('label' in item ? item.label : ''))).toEqual(['New conversation on device']);
    await act(async () => {
      await result.current.send({ conversationId: null, spaceId: 's1' }, 'thread');
    });
    expect(puts()).toEqual([{ conversation_id: null, space_id: 's1' }]);
    expect(result.current.status).toEqual({ key: 'thread', text: 'Sent to device.' });
  });

  it('Use on device for a thread sends thread_id in its space, and is off once the pointer is that thread', async () => {
    const { result } = renderHook(() => useDeviceConversation());
    const use = result.current.items({ threadId: 't1', spaceId: 's1', statusKey: 'thread:t1' })[0]!;
    expect(use).toMatchObject({ label: 'Use on device', isDisabled: false });
    await act(async () => {
      if ('onClick' in use) use.onClick?.();
    });
    expect(puts()).toEqual([{ conversation_id: null, space_id: 's1', thread_id: 't1' }]);
    expect(result.current.status).toEqual({ key: 'thread:t1', text: 'Sent to device.' });
    serverActive = { conversation_id: 'thr_t1', title: 'Dinner plans' };
    act(() => {
      window.dispatchEvent(new Event('bob:active-changed'));
    });
    await waitFor(() => expect(result.current.activeId).toBe('thr_t1'));
    const now = result.current.items({ threadId: 't1', spaceId: 's1' })[0]!;
    expect(now).toMatchObject({ isDisabled: true, description: 'device is in this thread' });
    // Another thread is still offered.
    expect(result.current.items({ threadId: 't2', spaceId: 's1' })[0]).toMatchObject({ isDisabled: false });
  });

  it('says no Cardputer is connected when a thread send answers 409', async () => {
    putStatus = 409;
    const { result } = renderHook(() => useDeviceConversation());
    await act(async () => {
      expect(await result.current.send({ conversationId: null, spaceId: 's1', threadId: 't1' })).toBe('no_device');
    });
    expect(result.current.status).toEqual({ key: 'thr_t1', text: 'No device is connected.' });
  });

  it('says no Cardputer is connected on a 409, and a plain failure otherwise', async () => {
    putStatus = 409;
    const { result } = renderHook(() => useDeviceConversation());
    await act(async () => {
      expect(await result.current.send({ conversationId: 'c1', spaceId: null })).toBe('no_device');
    });
    expect(result.current.status?.text).toBe('No device is connected.');
    expect(result.current.activeId).toBeNull();
    putStatus = 500;
    await act(async () => {
      expect(await result.current.send({ conversationId: 'c1', spaceId: null })).toBe('failed');
    });
    expect(result.current.status?.text).toBe('Could not reach the device.');
  });

  it('ignores a second send while one is in flight', async () => {
    const { result } = renderHook(() => useDeviceConversation());
    await act(async () => {
      await Promise.all([
        result.current.send({ conversationId: 'c1', spaceId: null }),
        result.current.send({ conversationId: 'c1', spaceId: null }),
      ]);
    });
    expect(puts()).toHaveLength(1);
  });

  it('a second send while one is in flight is busy, never failed, and shows no failure (#1240 P0)', async () => {
    const { result } = renderHook(() => useDeviceConversation());
    let results: string[] = [];
    await act(async () => {
      results = await Promise.all([
        result.current.send({ conversationId: 'c1', spaceId: null }),
        result.current.send({ conversationId: 'c1', spaceId: null }),
      ]);
    });
    expect(results).toEqual(['sent', 'busy']);
    expect(result.current.status?.text).toBe('Sent to device.');
    expect(result.current.isSending).toBe(false);
  });

  it('an offline device answers 202 pending: the line stays until a device.changed shows it connected', async () => {
    putStatus = 202;
    const { result } = renderHook(() => useDeviceConversation());
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.send({ conversationId: 'c1', spaceId: null }, 'card');
    });
    expect(outcome).toBe('pending');
    expect(result.current.status).toEqual({ key: 'card', text: DEVICE_STATUS.pending });
    act(() => notifyDevicesChanged());
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/devices')).toBe(true));
    expect(result.current.status?.text).toBe(DEVICE_STATUS.pending);
    connected = true;
    act(() => notifyDevicesChanged());
    await waitFor(() => expect(result.current.status).toEqual({ key: 'card', text: DEVICE_APPLIED }));
  });

  it('a plain 2xx is sent, not pending', async () => {
    const { result } = renderHook(() => useDeviceConversation());
    await act(async () => {
      expect(await result.current.send({ conversationId: 'c1', spaceId: null })).toBe('sent');
    });
  });
});

describe('useDeviceConversation scoped to a device (#900)', () => {
  it('shows the device\'s own pointer when it has one, with no title of its own', async () => {
    serverActive = { conversation_id: 'c1', title: 'Trip plan' };
    ownPointerId = 'c2';
    const { result } = renderHook(() => useDeviceConversation({ deviceId: 'd1' }));
    await waitFor(() => expect(result.current.activeId).toBe('c2'));
    expect(result.current.activeTitle).toBeNull();
  });

  it('falls back to the account pointer when the device has none of its own', async () => {
    serverActive = { conversation_id: 'c1', title: 'Trip plan' };
    ownPointerId = null;
    const { result } = renderHook(() => useDeviceConversation({ deviceId: 'd1' }));
    await waitFor(() => expect(result.current.activeId).toBe('c1'));
    expect(result.current.activeTitle).toBe('Trip plan');
  });

  it('send carries this device\'s own id', async () => {
    const { result } = renderHook(() => useDeviceConversation({ deviceId: 'd1' }));
    await act(async () => {
      await result.current.send({ conversationId: 'c1', spaceId: null });
    });
    expect(puts()).toEqual([{ conversation_id: 'c1', space_id: null, device_id: 'd1' }]);
  });

  it('an explicit null override forces the account-wide write (e.g. "All Cardputers")', async () => {
    const { result } = renderHook(() => useDeviceConversation({ deviceId: 'd1' }));
    await act(async () => {
      await result.current.send({ conversationId: 'c1', spaceId: null }, undefined, null);
    });
    expect(puts()).toEqual([{ conversation_id: 'c1', space_id: null }]);
  });

  it('an explicit device id overrides the hook\'s own scope', async () => {
    const { result } = renderHook(() => useDeviceConversation({ deviceId: 'd1' }));
    await act(async () => {
      await result.current.send({ conversationId: 'c1', spaceId: null }, undefined, 'd2');
    });
    expect(puts()).toEqual([{ conversation_id: 'c1', space_id: null, device_id: 'd2' }]);
  });
});
