/**
 * WS185-SERVER: each device board is its own kind of client. The hello `board`
 * rides the device session into the turn journal ("cardputer" for firmware
 * that sends none), and "not connected" names the device, not the board type.
 * The wire path and `interface: 'cardputer'` stay as they are.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { sessionBoard } from '../../src/voice/session-board.ts';
import { handleControl } from '../../src/voice/session.ts';
import { ClientControlDtoSchema } from '../../src/voice/protocol.ts';
import { journalStageFailed } from '../../src/voice/turn/failure.ts';
import { bindDeviceTools } from '../../src/voice/device-tools.ts';
import { DeviceSessions } from '../../src/voice/device-sessions.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { createAppDeps } from '../../src/app-deps.ts';

const appDeps = createAppDeps();
const hello = (payload: Record<string, unknown>): unknown => ({ v: 1, type: 'hello', id: 'hello_123456_v2', payload });
let lines: string[];
const journaled = (event: string): Record<string, unknown>[] =>
  lines.filter((line) => line.includes(`"${event}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);

async function connect(payload: Record<string, unknown>): Promise<DeviceSession> {
  const session = createSession();
  const socket = { readyState: 1, send: vi.fn() };
  await handleControl(appDeps, socket as unknown as WebSocket, session, ClientControlDtoSchema.parse(hello(payload)), vi.fn());
  return session;
}

beforeEach(() => {
  lines = [];
  setJournalSink((line: string) => lines.push(line));
});

describe('hello board on the device session', () => {
  it('keeps the Waveshare board and journals it on v2.hello', async () => {
    const session = await connect({ format_id: 2, fw_version: '0.3.0', board: 'waveshare-s3-185c' });
    expect(sessionBoard(session)).toBe('waveshare-s3-185c');
    expect(journaled('v2.hello').at(-1)?.board).toBe('waveshare-s3-185c');
  });

  it('records cardputer when an older firmware sends no board', async () => {
    const session = await connect({ format_id: 2 });
    expect(sessionBoard(session)).toBe('cardputer');
    expect(journaled('v2.hello').at(-1)?.board).toBe('cardputer');
  });
});

describe('turn journal carries the board', () => {
  it('a failed stage names the board and keeps interface cardputer', async () => {
    const session = await connect({ format_id: 2, board: 'waveshare-s3-185c' });
    journalStageFailed(session, 'turn_1', { stage: 'stt', kind: 'timeout', errorName: 'X', timedOut: true } as never, Date.now());
    const entry = journaled('v2.turn_stage_stt_failed')[0];
    expect(entry).toMatchObject({ interface: 'cardputer', board: 'waveshare-s3-185c' });
  });
});

describe('"not connected" names the device', () => {
  const USER = '33333333-3333-4333-8333-333333333333';
  const registry = (): DeviceSessions => new DeviceSessions({ subscribe: () => () => undefined });

  it('uses the paired device name', async () => {
    const tools = bindDeviceTools({ userId: USER, deviceId: 'd1', deviceName: 'Kitchen Bob', state: () => undefined, registry: registry() });
    await expect(tools.setVolume({ level: 3 })).rejects.toThrow('Kitchen Bob is not connected');
  });

  it('falls back to your device / your devices', async () => {
    const one = bindDeviceTools({ userId: USER, deviceId: 'd1', state: () => undefined, registry: registry() });
    await expect(one.setVolume({ level: 3 })).rejects.toThrow('your device is not connected');
    const web = bindDeviceTools({ userId: USER, deviceId: null, state: () => undefined, registry: registry() });
    await expect(web.setVolume({ level: 3 })).rejects.toThrow('your device is not connected');
  });
});

describe('stage events carry the board', () => {
  it('stt started and completed name the board', async () => {
    const { transcribeTurn } = await import('../../src/voice/turn/transcribe.ts');
    const session = await connect({ format_id: 2, board: 'waveshare-s3-185c' });
    const deps = { stt: async () => ({ text: 'hi', model: 'm', seconds: 1 }) } as never;
    await transcribeTurn(deps, session, Buffer.alloc(320), 'turn_2');
    for (const event of ['v2.turn_stage_stt_started', 'v2.turn_stage_stt_completed']) {
      expect(journaled(event)[0]).toMatchObject({ interface: 'cardputer', board: 'waveshare-s3-185c' });
    }
  });
});

describe('agent and tts stage events carry the board', () => {
  it('names the Waveshare board on the agent stage', async () => {
    const { generateReply } = await import('../../src/voice/turn/generate.ts');
    const { createStubAgent } = await import('../../src/voice/agent-adapters.ts');
    const session = await connect({ format_id: 1, board: 'waveshare-s3-185c' });
    await generateReply({ ...appDeps.turn, agent: createStubAgent() }, session, 'hello', 'turn_3', null);
    for (const event of ['v2.turn_stage_agent_started', 'v2.turn_stage_agent_completed']) {
      expect(journaled(event)[0]).toMatchObject({ interface: 'cardputer', board: 'waveshare-s3-185c' });
    }
  });

  it('names the board on the tts stage', async () => {
    const { streamPlayback } = await import('../../src/voice/turn/playback.ts');
    const session = await connect({ format_id: 1, board: 'waveshare-s3-185c' });
    const ttsPcm = vi.fn().mockResolvedValue({ pcm: Buffer.alloc(640), sourceRateHz: 16_000 });
    const socket = { readyState: 1, bufferedAmount: 0, send: vi.fn() };
    await streamPlayback({ ...appDeps.turn, ttsPcm } as never, socket as unknown as WebSocket, session, 'hi', 'turn_4', Date.now());
    for (const event of ['v2.turn_stage_tts_started', 'v2.turn_stage_tts_completed']) {
      expect(journaled(event)[0]).toMatchObject({ interface: 'cardputer', board: 'waveshare-s3-185c' });
    }
  });
});
