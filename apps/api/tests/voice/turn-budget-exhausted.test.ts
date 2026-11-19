/**
 * #1041: a spent AI Gateway budget answers every call with HTTP 402. A device
 * turn that meets one ends on a plain out-of-credit reply card (reply_text,
 * then status idle), not the generic INTERNAL toast, and raises the
 * v2.ai_budget_exhausted alarm. Real provider-error predicates; only the
 * provider calls are mocked (a GatewayInternalServerError with statusCode 402
 * is what @ai-sdk/gateway builds for the `quota_for_entity` 402 body).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { GatewayInternalServerError } from '@ai-sdk/gateway';
import { MP3_16K_MONO_FORMAT, type SessionDto } from '../../src/voice/protocol.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { createSession } from '../../src/voice/session-handlers.ts';
import { rememberSocketCaps } from '../../src/voice/device-caps.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { OUT_OF_CREDIT_REPLY, SPEECH_OUT_OF_CREDIT_REPLY } from '../../src/voice/turn/failure.ts';
import { resetBudgetAlarm } from '../../src/platform/observability/budget-alarm.ts';
import { closeDb, setSharedDb } from '../../src/platform/db/db.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

vi.mock('../../src/voice/audio/stt-tts.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/voice/audio/stt-tts.ts')>();
  return { ...actual, transcribePcm: vi.fn(), synthesizePcm: vi.fn(), synthesizeMp3: vi.fn(), downlinkFrames: vi.fn() };
});

// The agent is a harness agent (tests/support/agent-harness.ts), swapped per test.
const slot = vi.hoisted(() => ({ agent: null as unknown }));
vi.mock('@bob/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@bob/ai')>();
  return {
    ...original,
    get bobAgent() { return slot.agent; },
    get assistantAgent() { return slot.agent; },
    createBobAgent: vi.fn(() => slot.agent),
    chatModel: {},
    gateway: Object.assign(vi.fn(() => ({})), { embeddingModel: vi.fn(() => ({})) }),
    logAgentConfig: vi.fn(),
    BOB_SYSTEM_TEST_MODE: false,
    AI_STUB_MODE: false,
    debugLog: vi.fn(),
    isFrameDebugEnabled: () => false,
  };
});

import { downlinkFrames, synthesizeMp3, synthesizePcm, transcribePcm } from '../../src/voice/audio/stt-tts.ts';
import { createAgentHarness, words, type AgentHarness } from '../support/agent-harness.ts';
import { createAppDeps } from '../../src/app-deps.ts';

vi.stubEnv('BOB_TTS_CACHE', '');
const appDeps = createAppDeps();
vi.unstubAllEnvs();

const TURN = 'turn_credit1';
const budgetSpent = (): GatewayInternalServerError => new GatewayInternalServerError({ message: 'API key budget exceeded', statusCode: 402 });

/** An MP3 of `bytes` that opens with a parseable MPEG1 Layer III header. */
function mp3Of(bytes: number): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE((((0x7ff << 21) | (3 << 19) | (1 << 17) | (1 << 16) | (5 << 12) | (3 << 6)) >>> 0), 0);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, bytes - 4))]);
}

/** MP3 TTS that answers 402 from call `failOn` (1-based) on. */
function mp3TtsSpentFrom(failOn: number): void {
  let call = 0;
  vi.mocked(synthesizeMp3).mockImplementation(async (text: string) => {
    call += 1;
    if (call >= failOn) throw budgetSpent();
    return { mp3: mp3Of(text.length * 40) };
  });
}

function deviceSocket(caps: string[] = ['reply_text']): WebSocket {
  const socket = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
  rememberSocketCaps(socket, caps);
  return socket;
}

function respondingSession(): SessionDto {
  const session = createSession();
  session.stage = 'responding';
  session.turnRef = TURN;
  session.audioChunks = [Buffer.alloc(32_000)];
  session.totalAudioBytes = 32_000;
  return session;
}

function sent(socket: WebSocket): Array<{ type: string; payload?: Record<string, unknown> }> {
  return vi.mocked(socket.send).mock.calls
    .map((call) => call[0])
    .filter((frame): frame is string => typeof frame === 'string')
    .map((frame) => JSON.parse(frame) as { type: string; payload?: Record<string, unknown> });
}

let pg: TestDb;
beforeAll(async () => {
  pg = await createTestDb();
  setSharedDb(Promise.resolve(asDb(pg)));
});
afterAll(async () => {
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

describe('a device turn on a spent AI budget (402)', () => {
  const journals: Array<Record<string, unknown>> = [];
  const events = (name: string): Array<Record<string, unknown>> => journals.filter((entry) => entry.event === name);

  let harness: AgentHarness;
  const useAgent = (next: AgentHarness): void => { harness = next; slot.agent = next.agent; };

  beforeEach(() => {
    useAgent(createAgentHarness([words('It is noon.')]));
    journals.length = 0;
    setJournalSink((line) => journals.push(JSON.parse(line) as Record<string, unknown>));
    resetBudgetAlarm();
    vi.mocked(transcribePcm).mockResolvedValue({ text: 'what time is it', model: 'stt-1', seconds: 1 });
    vi.mocked(synthesizePcm).mockResolvedValue({ pcm: Buffer.alloc(3200), sourceRateHz: 16000 });
    vi.mocked(downlinkFrames).mockReturnValue([Buffer.alloc(340)]);
  });

  afterEach(() => {
    setJournalSink(null);
    vi.clearAllMocks();
  });

  function expectOutOfCreditCard(socket: WebSocket, session: SessionDto, stage: string): void {
    const messages = sent(socket);
    const card = messages.filter((dto) => dto.type === 'reply_text');
    expect(card.at(-1)?.payload).toEqual({ heard: '', reply: OUT_OF_CREDIT_REPLY });
    expect(messages.at(-1)).toMatchObject({ type: 'status', payload: { stage: 'idle' } });
    expect(messages.some((dto) => dto.type === 'error')).toBe(false);
    expect(messages.some((dto) => dto.type === 'playback_start')).toBe(false);
    expect(events('v2.turn_failed')[0]).toMatchObject({ stage, kind: 'upstream_error', upstream_status: 402 });
    expect(events('v2.ai_budget_exhausted')).toEqual([expect.objectContaining({ surface: 'device', stage })]);
    expect(session.stage).toBe('ready');
  }

  it('STT 402: the out-of-credit card, no agent, no TTS, one alarm', async () => {
    vi.mocked(transcribePcm).mockRejectedValue(budgetSpent());
    const socket = deviceSocket();
    const session = respondingSession();
    await runTurn(appDeps.turn, socket, session, TURN);
    expect(harness.calls()).toBe(0);
    expect(synthesizePcm).not.toHaveBeenCalled();
    expectOutOfCreditCard(socket, session, 'stt');
  });

  it('agent 402: the out-of-credit card, which claims nothing was done', async () => {
    useAgent(createAgentHarness([[{ type: 'error', message: 'budget spent', error: budgetSpent() }]]));
    const socket = deviceSocket();
    const session = respondingSession();
    await runTurn(appDeps.turn, socket, session, TURN);
    expect(synthesizePcm).not.toHaveBeenCalled();
    expectOutOfCreditCard(socket, session, 'agent');
  });

  // #1041 follow-up: a TTS 402 after STT and the agent succeeded. The reply is
  // real (it may report what a tool did), so it stays, after a plain note that
  // speech is out of credit; heard is empty, as on the stt/agent card.
  const speechCard = (reply: string): Record<string, unknown> => ({ heard: '', reply: `${SPEECH_OUT_OF_CREDIT_REPLY} ${reply}` });

  function expectSpeechOutOfCredit(socket: WebSocket, reply: string): void {
    const messages = sent(socket);
    expect(messages.filter((dto) => dto.type === 'reply_text').at(-1)?.payload).toEqual(speechCard(reply));
    expect(messages.at(-1)).toMatchObject({ type: 'status', payload: { stage: 'idle' } });
    expect(messages.some((dto) => dto.type === 'error')).toBe(false);
    expect(events('v2.ai_budget_exhausted')).toEqual([expect.objectContaining({ surface: 'device', stage: 'tts' })]);
    for (const line of journals.map((entry) => JSON.stringify(entry))) expect(line).not.toContain(reply);
  }

  it('TTS 402 (batch): the card says speech is out of credit, then the agent reply, with no INTERNAL', async () => {
    vi.mocked(synthesizePcm).mockRejectedValue(budgetSpent());
    const socket = deviceSocket();
    await runTurn(appDeps.turn, socket, respondingSession(), TURN);
    expect(sent(socket).some((dto) => dto.type === 'playback_start')).toBe(false);
    expectSpeechOutOfCredit(socket, 'It is noon.');
  });

  it('TTS 402 on the first streamed sentence: the same speech card, nothing played', async () => {
    useAgent(createAgentHarness([words('It is noon. Have a lovely lunch.')]));
    mp3TtsSpentFrom(1);
    const socket = deviceSocket();
    const session = respondingSession();
    session.formatId = MP3_16K_MONO_FORMAT;
    await runTurn(appDeps.turn, socket, session, TURN);
    expect(sent(socket).some((dto) => dto.type === 'playback_start')).toBe(false);
    expectSpeechOutOfCredit(socket, 'It is noon. Have a lovely lunch.');
  });

  it('TTS 402 mid-stream: the first sentence plays, then the speech card replaces the reply', async () => {
    useAgent(createAgentHarness([words('It is noon. Have a lovely lunch.')]));
    mp3TtsSpentFrom(2);
    const socket = deviceSocket();
    const session = respondingSession();
    session.formatId = MP3_16K_MONO_FORMAT;
    await runTurn(appDeps.turn, socket, session, TURN);
    expect(sent(socket).some((dto) => dto.type === 'playback_start')).toBe(true);
    expectSpeechOutOfCredit(socket, 'It is noon. Have a lovely lunch.');
  });

  it('firmware without the reply_text cap still gets INTERNAL (never a silent end), and the alarm fires', async () => {
    vi.mocked(transcribePcm).mockRejectedValue(budgetSpent());
    const socket = deviceSocket([]);
    await runTurn(appDeps.turn, socket, respondingSession(), TURN);
    expect(sent(socket).at(-1)).toMatchObject({ type: 'error', payload: { code: 'INTERNAL' } });
    expect(events('v2.ai_budget_exhausted')).toHaveLength(1);
  });

  it('any other provider failure keeps INTERNAL and raises no alarm', async () => {
    vi.mocked(transcribePcm).mockRejectedValue(new GatewayInternalServerError({ statusCode: 500 }));
    const socket = deviceSocket();
    await runTurn(appDeps.turn, socket, respondingSession(), TURN);
    expect(sent(socket).at(-1)).toMatchObject({ type: 'error', payload: { code: 'INTERNAL' } });
    expect(events('v2.ai_budget_exhausted')).toHaveLength(0);
  });
});
