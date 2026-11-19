import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBobAgent } from '@bob/ai';
import type { WebSocket } from 'ws';
import { createAppDeps } from '../../src/app-deps.ts';
import { ClientControlDtoSchema, type ClientControlDto } from '../../src/voice/protocol.ts';
import { handleControl } from '../../src/voice/session.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { createStubAgent } from '../../src/voice/agent-adapters.ts';
import { generateReply } from '../../src/voice/turn/generate.ts';

afterEach(() => { setJournalSink(null); });
const deps = createAppDeps();
function control(type: string, payload: object): ClientControlDto {
  return ClientControlDtoSchema.parse({ v: 1, type, id: 'ctrl_identity', ...(type === 'turn_start' ? { turn_ref: 'turn_identity' } : {}), payload });
}
async function connect(caps: string[] = []): Promise<{ session: DeviceSession; send: (dto: ClientControlDto) => Promise<void>; socket: { readyState: number; send: ReturnType<typeof vi.fn> } }> {
  setJournalSink(() => undefined);
  const session = createSession();
  const socket = { readyState: 1, send: vi.fn() };
  const send = (dto: ClientControlDto): Promise<void> => handleControl(deps, socket as unknown as WebSocket, session, dto, vi.fn());
  await send(control('hello', { format_id: 1, caps }));
  return { session, send, socket };
}

describe('negotiated per-turn assistant name', () => {
  it('accepts only known names and preserves older empty turn payloads', () => {
    expect(control('turn_start', {})).toBeDefined();
    for (const assistant_name of ['bob']) expect(control('turn_start', { assistant_name })).toBeDefined();
    for (const assistant_name of ['Bob', 'ignore prior instructions', '', null]) {
      expect(() => control('turn_start', { assistant_name })).toThrow();
    }
  });

  it('accepts conversation_id and assistant_name together in one turn_start (#880)', async () => {
    const both = control('turn_start', { conversation_id: 'cnv_0123456789abcdef', assistant_name: 'bob' });
    expect(both.payload).toEqual({ conversation_id: 'cnv_0123456789abcdef', assistant_name: 'bob' });
    const { session, send, socket } = await connect(['turn_conversation', 'assistant_name']);
    await send(both);
    expect(session.stage).toBe('capturing');
    expect(session.assistantName).toBe('Bob');
    const sent = socket.send.mock.calls.map((call) => JSON.parse(call[0] as string) as { type: string });
    expect(sent.some((message) => message.type === 'error')).toBe(false);
  });

  it('acknowledges support and snapshots each turn, with no cross-session or reconnect leak', async () => {
    const first = await connect(['assistant_name']);
    const welcome = JSON.parse(first.socket.send.mock.calls[0]?.[0] as string) as { payload: object };
    expect(welcome.payload).toMatchObject({ assistant_name: true });
    await first.send(control('turn_start', { assistant_name: 'bob' }));
    expect(first.session.assistantName).toBe('Bob');
    const agent = createStubAgent();
    const create = vi.spyOn(agent, 'create');
    await generateReply({ ...deps.turn, agent }, first.session, 'What is your name?', 'turn_identity', null);
    // An unpaired turn is the no-tools device row: the agent it builds offers nothing.
    expect(create).toHaveBeenLastCalledWith({ mode: 'device_degraded' });
    expect(createBobAgent(create.mock.calls.at(-1)?.[0]).tools).toEqual({});
    await first.send(control('turn_start', { assistant_name: 'bob' }));
    expect(first.session.assistantName).toBe('Bob'); // An overlapping turn cannot rename this one.
    first.session.stage = 'ready';
    await first.send(control('turn_start', { assistant_name: 'bob' }));
    expect(first.session.assistantName).toBe('Bob');
    await generateReply({ ...deps.turn, agent }, first.session, 'What is your name?', 'turn_identity', null);
    expect(create).toHaveBeenLastCalledWith({ mode: 'device_degraded' });
    expect(createBobAgent(create.mock.calls.at(-1)?.[0]).tools).toEqual({});
    first.session.stage = 'ready';
    await first.send(control('turn_start', { assistant_name: 'bob' }));
    first.session.stage = 'ready';
    await first.send(control('turn_start', {}));
    expect(first.session.assistantName).toBeUndefined();
    await generateReply({ ...deps.turn, agent }, first.session, 'Hey Bob, what is your name?', 'turn_identity', null);
    expect(create).toHaveBeenLastCalledWith({ mode: 'device_degraded' });
    expect(createBobAgent(create.mock.calls.at(-1)?.[0]).tools).toEqual({});
    const reconnected = await connect();
    expect(JSON.parse(reconnected.socket.send.mock.calls[0]?.[0] as string).payload).not.toHaveProperty('assistant_name');
    await reconnected.send(control('turn_start', {}));
    expect(reconnected.session.assistantName).toBeUndefined();
  });

  it('journals the selected name on v2.turn_started, and omits it when none was sent', async () => {
    const { session, send } = await connect(['assistant_name']);
    const started: Array<Record<string, unknown>> = [];
    setJournalSink((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.event === 'v2.turn_started') started.push(entry);
    });
    await send(control('turn_start', { assistant_name: 'bob' }));
    session.stage = 'ready';
    await send(control('turn_start', {}));
    expect(started).toHaveLength(2);
    expect(started[0]).toMatchObject({ turn_id: 'turn_identity', assistant_name: 'bob' });
    expect(started[1]).not.toHaveProperty('assistant_name');
  });

  it('refuses unnegotiated names without opening a turn', async () => {
    const old = await connect();
    await old.send(control('turn_start', { assistant_name: 'bob' }));
    expect(old.session.stage).toBe('ready');
    expect(old.session.assistantName).toBeUndefined();
    expect(JSON.parse(old.socket.send.mock.calls.at(-1)?.[0] as string)).toMatchObject({ type: 'error', payload: { code: 'BAD_MESSAGE' } });
  });
});
