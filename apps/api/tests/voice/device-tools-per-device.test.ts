// #900 gap 3: web chat's device tools (deviceId null, chat/tools.ts) used to
// read only the FIRST connected device's volume and broadcast that one
// absolute level to every device, so two Cardputers at different volumes
// both landed on the same number. bindDeviceTools must instead move each
// device from its OWN last-known state; a push bound for one device must
// never reach another's socket.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { bindDeviceTools } from '../../src/voice/device-tools.ts';
import { DeviceSessions } from '../../src/voice/device-sessions.ts';
import type { SessionStage } from '../../src/voice/protocol.ts';

type FakeDeviceState = { volume: number; muted: boolean; mode: 'ptt'; dnd: boolean };
type FakeSession = { id: string; stage: SessionStage; deviceState?: FakeDeviceState };
type FakeSocket = { readyState: number; send: ReturnType<typeof vi.fn> };

const USER = '33333333-3333-4333-8333-333333333333';
const events = { subscribe: () => () => undefined };
let registry: DeviceSessions;

function device(sessionId: string, deviceId: string, volume: number): FakeSocket {
  const socket: FakeSocket = { readyState: 1, send: vi.fn() };
  const session: FakeSession = { id: sessionId, stage: 'ready', deviceState: { volume, muted: false, mode: 'ptt', dnd: false } };
  registry.register(socket as unknown as WebSocket, session, USER, deviceId);
  return socket;
}

const controlPayloads = (socket: FakeSocket): Array<Record<string, unknown>> =>
  socket.send.mock.calls
    .map((call) => JSON.parse(call[0] as string) as { type: string; payload: Record<string, unknown> })
    .filter((dto) => dto.type === 'device_control')
    .map((dto) => dto.payload);

function webChatTools(): ReturnType<typeof bindDeviceTools> {
  return bindDeviceTools({
    userId: USER,
    deviceId: null,
    state: () => registry.forAccount(USER)[0]?.session.deviceState,
    registry,
  });
}

beforeEach(() => {
  registry = new DeviceSessions(events);
});

describe('bindDeviceTools from web chat (#900): deviceId null drives every device by its OWN state', () => {
  it('a relative step lands each device at its own new level, never the first device\'s level on both', async () => {
    const a = device('session_a', 'device-a', 3);
    const b = device('session_b', 'device-b', 7);
    const result = await webChatTools().setVolume({ delta: 2 });
    expect(controlPayloads(a)).toEqual([{ volume: 5, muted: false }]);
    expect(controlPayloads(b)).toEqual([{ volume: 9, muted: false }]);
    expect(result).toEqual({ volume: 5, muted: false });
  });

  it('a push bound for one device never reaches the other\'s socket', async () => {
    const a = device('session_a', 'device-a', 3);
    const b = device('session_b', 'device-b', 7);
    await webChatTools().setVolume({ delta: 2 });
    expect(a.send).toHaveBeenCalledTimes(1);
    expect(b.send).toHaveBeenCalledTimes(1);
    expect(controlPayloads(a)).not.toEqual(controlPayloads(b));
  });

  it('an absolute level still goes to every device alike', async () => {
    const a = device('session_a', 'device-a', 3);
    const b = device('session_b', 'device-b', 7);
    await webChatTools().setVolume({ level: 5 });
    expect(controlPayloads(a)).toEqual([{ volume: 5, muted: false }]);
    expect(controlPayloads(b)).toEqual([{ volume: 5, muted: false }]);
  });

  it('with only one connected device, a relative step still works through the single broadcast path', async () => {
    const a = device('session_a', 'device-a', 3);
    const result = await webChatTools().setVolume({ delta: 2 });
    expect(controlPayloads(a)).toEqual([{ volume: 5, muted: false }]);
    expect(result).toEqual({ volume: 5, muted: false });
  });

  it('says "your devices" (plural) when more than one device fails to receive the push', async () => {
    const a = device('session_a', 'device-a', 3);
    const b = device('session_b', 'device-b', 7);
    a.readyState = 3;
    b.readyState = 3;
    await expect(webChatTools().setVolume({ delta: 2 })).rejects.toThrow('your devices are not connected');
  });

  it('says "your device" (singular) for a single bound device', async () => {
    const target = bindDeviceTools({ userId: USER, deviceId: 'device-a', state: () => undefined, registry });
    await expect(target.setVolume({ level: 5 })).rejects.toThrow('your device is not connected');
  });
});
