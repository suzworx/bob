/**
 * Turn pipeline tests: STT -> agent -> TTS -> downlink streaming with
 * mocked audio adapters and agent, real session helpers, and journal capture.
 */
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import type { WebSocket } from 'ws';
import { GatewayAuthenticationError } from '@ai-sdk/gateway';
import { AUDIO_HEADER_BYTES, DOWNLINK_FRAME_BYTES, DOWNLINK_MP3_CHUNK_BYTES, MP3_16K_MONO_FORMAT, type ChatMessage, type SessionDto } from '../../src/voice/protocol.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { createSession, sendStatus, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import type { MemoryExtractionWorker } from '../../src/memory/extract.ts';
import { closeDb, setSharedDb, withUser, type Db } from '../../src/platform/db/db.ts';
import { appendMessage as storeAppendMessage, createConversation, deleteConversation } from '../../src/conversations/store.ts';
import { getActive, setActive } from '../../src/conversations/active.ts';
import { loadCardputerHistory } from '../../src/voice/cardputer-conversation.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import { resolveDevAccount } from '../../src/account/dev-account.ts';
import {
  asDb,
  closeTestDb,
  createTestDb,
  type TestDb,
} from '../support/test-db.ts';
import { MAX_DOWNLINK_PCM_BYTES } from '../../src/voice/turn/pacing.ts';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { runAgent } from '../../src/voice/turn/agent.ts';


vi.mock('../../src/voice/audio/stt-tts.ts', async (importOriginal) => ({
  assemblePcm16: (chunks: Buffer[]): Buffer => Buffer.concat(chunks),
  // A finished MP3 reply is spoken sentence by sentence through the real splitter.
  createReplySplitter: (await importOriginal<typeof import('../../src/voice/audio/stt-tts.ts')>()).createReplySplitter,
  isEmptyTurn: vi.fn(),
  isTooShortTurn: vi.fn(),
  transcribePcm: vi.fn(),
  synthesizePcm: vi.fn(),
  synthesizeMp3: vi.fn(),
  downlinkFrames: vi.fn(),
  downlinkMp3Frames: vi.fn(),
}));


// S14-PG-AGENT-MOCK: with real Postgres, a memory-enabled device turn builds
// a PER-TURN agent via createBobAgent, imported by the relative path below
// -- a different module id than '@bob/ai', so the "store-backed history"
// suite (real Postgres) reaches the real AI Gateway unless this is mocked
// too. @bob/ai embeddings.ts imports `gateway` from this same resolved
// module for the retrieval query embedder (built eagerly every memory-on
// turn); a `gateway.embeddingModel` stub with no `doEmbed` makes that embed
// call fail locally -- caught by memory-retrieval.ts's degrade path -- so no
// network request is attempted.
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  bobAgent: { generate: vi.fn() },
  BOB_SYSTEM_TEST_MODE: false,
  AI_STUB_MODE: false,
  isProviderError: (error: unknown) =>
    error instanceof Error && (/fetch failed|timeout/i.test(error.message) || /^Gateway/.test(error.name)),
  providerErrorStatus: () => undefined,
  // turn.ts logs the payload the journal is forbidden to carry through the
  // debug channel; stubbed here so the pipeline tests stay focused on framing.
  debugLog: vi.fn(),
  isFrameDebugEnabled: () => false,
}) ) as Factory),
    ((async (importOriginal) => {
  const { bobAgent: mockAgent } = await importOriginal<typeof import('@bob/ai')>();
  return {
    createBobAgent: vi.fn(() => mockAgent),
    bobAgent: mockAgent,
    assistantAgent: mockAgent,
    chatModel: {},
    gateway: Object.assign(vi.fn(() => ({})), { embeddingModel: vi.fn(() => ({})) }),
    logAgentConfig: vi.fn(),
  };
} ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

// Memory is off by default (memoryAvailable is mocked); the conversation-less tools test flips it on so
// the memory/productivity wiring is exercised without a vector store. Retrieval
// is stubbed to an empty block for the same reason.
const memoryState = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/memory/available.ts', () => ({
  memoryAvailable: vi.fn(() => Promise.resolve(memoryState.on)),
  resetMemoryAvailability: vi.fn(),
}));
vi.mock('../../src/memory/retrieval.ts', () => ({
  startMemoryRetrieval: vi.fn(() => ({ result: Promise.resolve({ block: null }) })),
}));

import { downlinkFrames, downlinkMp3Frames, isEmptyTurn, synthesizeMp3, synthesizePcm, transcribePcm } from '../../src/voice/audio/stt-tts.ts';
import { createBobAgent, debugLog, bobAgent, createProductivityTools, BOB_TTS_VOICE } from '@bob/ai';

/** A parseable MPEG1 Layer III frame header at 64 kbps, mono, 44.1 kHz. */
function mp3WithRealHeader(bytes: number): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE((((0x7ff << 21) | (3 << 19) | (1 << 17) | (1 << 16) | (5 << 12) | (3 << 6)) >>> 0), 0);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, bytes - 4))]);
}

function fakeSocket(readyState = 1): WebSocket {
  return { readyState, send: vi.fn() } as unknown as WebSocket;
}

function respondingSession(): SessionDto {
  const session = createSession();
  session.stage = 'responding';
  session.turnRef = 'turn_abc123';
  return session;
}

// One real test database for the whole file, shared with getDb(): every
// runTurn records its turn metric through getDb() (turn/metrics.ts), so the
// non-store suites need it too, not only "store-backed history".
let pg: TestDb;
let db: Db;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
});

afterAll(async () => {
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

describe('runTurn', () => {
  const journals: string[] = [];
  let socket: WebSocket;
  let session: SessionDto;

  beforeEach(() => {
    journals.length = 0;
    setJournalSink((line) => journals.push(line));
    socket = fakeSocket();
    session = respondingSession();
    vi.mocked(transcribePcm).mockResolvedValue({ text: 'user said this', model: 'stt-1', seconds: 1 });
    vi.mocked(bobAgent.generate).mockResolvedValue({
      text: 'reply text', toolCalls: [], modelId: 'model-x',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    } as never);
    vi.mocked(synthesizePcm).mockResolvedValue({ pcm: Buffer.alloc(3200), sourceRateHz: 44100 });
    vi.mocked(synthesizeMp3).mockResolvedValue({ mp3: Buffer.alloc(DOWNLINK_MP3_CHUNK_BYTES * 3) });
    vi.mocked(downlinkFrames).mockReturnValue([Buffer.alloc(340), Buffer.alloc(340)]);
    vi.mocked(downlinkMp3Frames).mockReturnValue([Buffer.alloc(AUDIO_HEADER_BYTES + DOWNLINK_MP3_CHUNK_BYTES), Buffer.alloc(AUDIO_HEADER_BYTES + DOWNLINK_MP3_CHUNK_BYTES), Buffer.alloc(AUDIO_HEADER_BYTES + DOWNLINK_MP3_CHUNK_BYTES)]);
  });

  afterEach(() => {
    setJournalSink(null);
    vi.clearAllMocks();
  });

  it('clears accumulated chunks before the pipeline runs', async () => {
    session.audioChunks = [Buffer.alloc(320)];
    session.totalAudioBytes = 320;
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');
    expect(session.audioChunks).toHaveLength(0);
    expect(session.totalAudioBytes).toBe(0);
  });

  it('#396: journals all-step usage, timings and the turn_id critical path', async () => {
    // One batched audio_up message carrying four 10 ms frames.
    session.audioChunks = [Buffer.alloc(4 * 320)];
    session.nextUplinkSeq = 1;
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    const step = (input: number, tools: string[], finishReason: string): Record<string, unknown> => ({
      toolCalls: tools.map((toolName) => ({ toolName, input: { note: 'private words' } })),
      finishReason,
      response: { modelId: 'openai/gpt-4o' },
      usage: { inputTokens: input, outputTokens: 5, totalTokens: input + 5, inputTokenDetails: { cacheReadTokens: 0 } },
    });
    vi.mocked(bobAgent.generate).mockResolvedValue({
      text: 'reply text', toolCalls: [], response: { modelId: 'openai/gpt-4o' }, finishReason: 'stop',
      usage: { inputTokens: 1010, outputTokens: 5, totalTokens: 1015 },
      totalUsage: { inputTokens: 2010, outputTokens: 10, totalTokens: 2020, inputTokenDetails: { cacheReadTokens: 512 } },
      steps: [step(1000, ['currentDateTime'], 'tool-calls'), step(1010, [], 'stop')],
    } as never);
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');
    const entries = journals.map((line) => JSON.parse(line) as Record<string, unknown>);
    const byEvent = (event: string): Record<string, unknown> => entries.find((entry) => entry.event === event)!;

    const agent = byEvent('v2.turn_stage_agent_completed');
    expect(agent).toMatchObject({
      model: 'openai/gpt-4o', input_tokens: 2010, output_tokens: 10, tokens: 2020, cached_input_tokens: 512,
      steps: 2, tool_calls: 1, called_tools: 'currentDateTime', finish_reason: 'stop',
    });
    expect(agent.prep_ms).toEqual(expect.any(Number));
    expect(agent.model_ms).toEqual(expect.any(Number));
    expect(agent.duration_ms).toBe((agent.prep_ms as number) + (agent.model_ms as number));
    expect(agent).not.toHaveProperty('stub');
    expect(JSON.stringify(entries)).not.toContain('private words');

    const tools = byEvent('v2.agent_tools');
    expect(tools).toMatchObject({ tool_count: expect.any(Number), tools_chars: expect.any(Number), history_messages: 0, history_chars: 0 });

    const downlink = byEvent('v2.downlink_started');
    const completed = byEvent('v2.turn_completed');
    expect(downlink.turn_id).toBe('turn_abc123');
    expect(completed.turn_id).toBe('turn_abc123');
    expect(completed).toMatchObject({ frames: 4, msgs: 1 });
    expect(agent.turn_id).toBe('turn_abc123');
    expect(completed.first_audio_ms).toEqual(expect.any(Number));
    expect(completed.first_audio_ms as number).toBeGreaterThanOrEqual(downlink.total_ms as number);
  });

  it('#999: v2.turn_completed tells a failed action from a clean turn', async () => {
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    vi.mocked(bobAgent.generate).mockResolvedValue({
      text: 'reply text', toolCalls: [], response: { modelId: 'openai/gpt-4o' }, finishReason: 'stop',
      steps: [
        {
          toolCalls: [{ toolName: 'set_alarm', input: { note: 'private words' } }],
          toolResults: [{ toolName: 'set_alarm', output: { ok: false, error: 'private words' } }],
          content: [], finishReason: 'tool-calls',
        },
        { toolCalls: [], toolResults: [], content: [], finishReason: 'stop' },
      ],
    } as never);
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');
    const entries = journals.map((line) => JSON.parse(line) as Record<string, unknown>);
    const byEvent = (event: string): Record<string, unknown> | undefined => entries.find((entry) => entry.event === event);
    expect(byEvent('v2.turn_stage_agent_completed')).toMatchObject({ tool_calls: 1, tool_failures: 1 });
    expect(byEvent('v2.turn_completed')).toMatchObject({ tool_calls: 1, tool_failures: 1, action_outcome: 'failed' });
    expect(JSON.stringify(entries)).not.toContain('private words');
  });

  it('#999: a turn with no tool calls, and an empty turn, have action_outcome none', async () => {
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');
    const completedOf = (): Record<string, unknown> | undefined => journals
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === 'v2.turn_completed');
    expect(completedOf()).toMatchObject({ tool_calls: 0, tool_failures: 0, action_outcome: 'none' });

    journals.length = 0;
    session = respondingSession();
    vi.mocked(isEmptyTurn).mockReturnValue(true);
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');
    expect(completedOf()).toMatchObject({ tool_calls: 0, tool_failures: 0, action_outcome: 'none' });
  });

  it('runs STT -> agent -> TTS for an audio turn and streams the reply', async () => {
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    expect(transcribePcm).toHaveBeenCalledWith(Buffer.alloc(320));
    expect(bobAgent.generate).toHaveBeenCalledWith({ messages: expect.any(Array) });
    const generateArgs = vi.mocked(bobAgent.generate).mock.calls[0]![0]!;
    const messages = (generateArgs as { messages: ChatMessage[] }).messages;
    expect(messages[0]).toMatchObject({ role: 'user', content: 'user said this' });
    expect(synthesizePcm).toHaveBeenCalledWith('reply text', undefined, BOB_TTS_VOICE);

    expect(journals.join('\n')).toContain('v2.turn_stage_stt_started');
    expect(journals.join('\n')).toContain('v2.turn_stage_stt_completed');
    expect(journals.join('\n')).toContain('v2.turn_stage_agent_started');
    expect(journals.join('\n')).toContain('v2.turn_stage_agent_completed');
    expect(journals.join('\n')).toContain('v2.turn_stage_tts_started');
    expect(journals.join('\n')).toContain('v2.turn_stage_tts_completed');
    expect(journals.join('\n')).toContain('v2.downlink_started');
    expect(journals.join('\n')).toContain('v2.turn_completed');

    const sent = vi.mocked(socket.send).mock.calls.map((call) => call[0]);
    expect(sent[0]).toContain('"type":"status"');
    expect(sent[0]).toContain('"stage":"thinking"');
    expect(sent[0]).toContain('"turn_ref":"turn_abc123"');
    expect(sent[1]).toContain('"type":"reply_text"'); // #318: before playback_start
    expect(sent[2]).toContain('"type":"status"');
    expect(sent[2]).toContain('"stage":"speaking"');
    expect(sent[3]).toContain('"type":"playback_start"');
    expect(sent[4]).toEqual(Buffer.alloc(340));
    expect(sent[5]).toEqual(Buffer.alloc(340));
    expect(sent[6]).toContain('"type":"playback_end"');
    expect(sent[7]).toContain('"type":"status"');
    expect(sent[7]).toContain('"stage":"idle"');
    expect(sent).toHaveLength(8);
  });

  it('streams MP3 frames when the session negotiates format_id 2', async () => {
    session.audioChunks = [Buffer.alloc(320)];
    session.formatId = MP3_16K_MONO_FORMAT;
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    expect(synthesizeMp3).toHaveBeenCalledWith('reply text', undefined, BOB_TTS_VOICE);
    expect(synthesizePcm).not.toHaveBeenCalled();
    expect(downlinkMp3Frames).toHaveBeenCalled();

    expect(journals.join('\n')).toContain('"format_id":2');
    expect(journals.join('\n')).toContain('"mp3_bytes":3072');

    const sent = vi.mocked(socket.send).mock.calls.map((call) => call[0]);
    expect(sent[0]).toContain('"type":"status"');
    expect(sent[0]).toContain('"stage":"thinking"');
    expect(sent[1]).toContain('"type":"reply_text"'); // #318: before playback_start
    expect(sent[2]).toContain('"type":"status"');
    expect(sent[2]).toContain('"stage":"speaking"');
    expect(sent[3]).toContain('"type":"playback_start"');
    expect(sent[4]).toEqual(Buffer.alloc(AUDIO_HEADER_BYTES + DOWNLINK_MP3_CHUNK_BYTES));
    expect(sent[5]).toEqual(Buffer.alloc(AUDIO_HEADER_BYTES + DOWNLINK_MP3_CHUNK_BYTES));
    expect(sent[6]).toEqual(Buffer.alloc(AUDIO_HEADER_BYTES + DOWNLINK_MP3_CHUNK_BYTES));
    expect(sent[7]).toContain('"type":"playback_end"');
    expect(sent[8]).toContain('"type":"status"');
    expect(sent[8]).toContain('"stage":"idle"');
    expect(sent).toHaveLength(9);
  });

  it('paces the MP3 downlink against the drain rate of the clip itself', async () => {
    // The pipeline mocks elsewhere use zero-filled buffers, which parse as no
    // frame at all and therefore exercise the FALLBACK rather than the pacer.
    // A real header is required for this assertion to mean anything.
    session.audioChunks = [Buffer.alloc(320)];
    session.formatId = MP3_16K_MONO_FORMAT;
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    vi.mocked(synthesizeMp3).mockResolvedValue({ mp3: mp3WithRealHeader(DOWNLINK_MP3_CHUNK_BYTES * 3) });
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    const framing = vi.mocked(debugLog).mock.calls.find((call) => call[0] === 'turn.downlink_frames');
    expect(framing).toBeDefined();
    // 64 kbps = 8000 bytes/sec.
    expect(framing![1]).toMatchObject({ paced: true, drain_bytes_per_sec: 8000 });
  });

  it('falls back to fixed pacing when the reply has no parseable frame', async () => {
    session.audioChunks = [Buffer.alloc(320)];
    session.formatId = MP3_16K_MONO_FORMAT;
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    const framing = vi.mocked(debugLog).mock.calls.find((call) => call[0] === 'turn.downlink_frames');
    expect(framing![1]).toMatchObject({ paced: false, drain_bytes_per_sec: null });
  });

  it('appends user and assistant messages to the session history', async () => {
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toMatchObject({ role: 'user', content: 'user said this' });
    expect(session.messages[1]).toMatchObject({ role: 'assistant', content: 'reply text' });
  });

  it('handles an empty turn with the canned reply and no STT/agent calls', async () => {
    vi.mocked(isEmptyTurn).mockReturnValue(true);
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    expect(journals.join('\n')).toContain('v2.turn_stage_input_completed');
    expect(transcribePcm).not.toHaveBeenCalled();
    expect(bobAgent.generate).not.toHaveBeenCalled();
    expect(synthesizePcm).toHaveBeenCalledWith('I did not hear anything. Please try again.', undefined, BOB_TTS_VOICE);
  });

  it('stops streaming frames when the socket closes mid-stream', async () => {
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    const closingSocket = fakeSocket();
    const closingState = closingSocket as unknown as { readyState: number };
    closingSocket.send = vi.fn(() => {
      closingState.readyState = 3;
    }) as never;
    await runTurn(appDeps.turn, closingSocket, session, 'turn_abc123');
    expect(vi.mocked(closingSocket.send).mock.calls.length).toBeLessThan(4);
  });

  it('journals v2.turn_failed with the real stt stage and sends INTERNAL error on upstream failure', async () => {
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    vi.mocked(transcribePcm).mockRejectedValue(new GatewayAuthenticationError({ statusCode: 503 }));
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    const journalText = journals.join('\n');
    expect(journalText).toContain('v2.turn_stage_stt_failed');
    expect(journalText).not.toContain('v2.turn_stage_agent_failed');
    expect(journalText).toContain('"kind":"upstream_error"');
    expect(journalText).toContain('"stage":"stt"');
    const sent = vi.mocked(socket.send).mock.calls.map((call) => call[0]);
    expect(sent.at(-1)).toContain('"type":"error"');
    expect(sent.at(-1)).toContain('"code":"INTERNAL"');
  });

  it('journals an STT failure as stage stt, not agent', async () => {
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    vi.mocked(transcribePcm).mockRejectedValue(new Error('boom'));
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');
    const journalText = journals.join('\n');
    expect(journalText).toContain('v2.turn_stage_stt_failed');
    expect(journalText).not.toContain('v2.turn_stage_agent_failed');
    expect(journalText).toContain('"stage":"stt"');
  });

  it('journals a TTS failure as stage tts, not agent', async () => {
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    vi.mocked(synthesizePcm).mockRejectedValue(new Error('boom'));
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');
    const journalText = journals.join('\n');
    expect(journalText).toContain('v2.turn_stage_tts_failed');
    expect(journalText).not.toContain('v2.turn_stage_agent_failed');
    expect(journalText).toContain('"stage":"tts"');
  });

  it('journals v2.turn_failed without an error message field', async () => {
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    vi.mocked(transcribePcm).mockRejectedValue(new Error('secret payload boom'));
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');
    const line = journals.find((entry) => entry.includes('v2.turn_failed'));
    expect(line).toBeDefined();
    const entry = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(entry).not.toHaveProperty('error');
    expect(line).not.toContain('secret payload');
    expect(entry).toMatchObject({ error_name: 'Error' });
  });

  it('ends an empty transcript the same visible way an empty recording does', async () => {
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    vi.mocked(transcribePcm).mockResolvedValue({ text: '   ', model: 'stt-1', seconds: 0 });
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    expect(bobAgent.generate).not.toHaveBeenCalled();
    expect(journals.join('\n')).toContain('v2.turn_stage_input_completed');
    expect(journals.join('\n')).toContain('v2.turn_completed');
    const sent = vi.mocked(socket.send).mock.calls.map((call) => call[0]);
    const speechPayload = sent.find((frame) => Buffer.isBuffer(frame)) as Buffer;
    expect(speechPayload.length).toBeGreaterThan(0);
  });

  it('reports non-upstream failures as kind internal', async () => {
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    vi.mocked(transcribePcm).mockRejectedValue(new Error('boom'));
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');
    const journalText = journals.join('\n');
    expect(journalText).toContain('"kind":"internal"');
    expect(journalText).toContain('"stage":"stt"');
  });

  it('resets the session back to ready in finally', async () => {
    session.audioChunks = [Buffer.alloc(320)];
    session.totalAudioBytes = 320;
    session.nextUplinkSeq = 3;
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    expect(session.stage).toBe('ready');
    expect(session.turnRef).toBeUndefined();
    expect(session.audioChunks).toHaveLength(0);
    expect(session.totalAudioBytes).toBe(0);
    expect(session.nextUplinkSeq).toBe(0);
    expect(session.creditBytes).toBe(16 * 1024);
  });
});

describe('store-backed history', () => {
  const journals: string[] = [];
  let userId: string;
  let socket: WebSocket;
  let session: DeviceSession;

  /** A Db whose every call rejects: simulates a store outage cheaply so the
   *  file's shared test database stays alive for the rest of the file. */
  function deadDb(): Db {
    return {
      query: async <T>(): Promise<T[]> => {
        throw new Error('store unavailable');
      },
      tx: async <T>(): Promise<T> => {
        throw new Error('store unavailable');
      },
    };
  }

  beforeAll(async () => {
    userId = await resolveDevAccount(db);
  });

  beforeEach(() => {
    journals.length = 0;
    setJournalSink((line) => journals.push(line));
    socket = fakeSocket();
    session = respondingSession() as DeviceSession;
    // T028: the turn pipeline resolves the account from the session (T018),
    // so store-backed turns need a device auth carrying the seeded account.
    session.auth = { kind: 'device', userId, deviceId: '11111111-1111-4111-8111-111111111111', name: 'Test Card' };
    vi.mocked(transcribePcm).mockResolvedValue({ text: 'user said this', model: 'stt-1', seconds: 1 });
    vi.mocked(bobAgent.generate).mockResolvedValue({
      text: 'reply text', toolCalls: [], modelId: 'model-x',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    } as never);
    vi.mocked(synthesizePcm).mockResolvedValue({ pcm: Buffer.alloc(3200), sourceRateHz: 44100 });
    vi.mocked(synthesizeMp3).mockResolvedValue({ mp3: Buffer.alloc(DOWNLINK_MP3_CHUNK_BYTES * 3) });
    vi.mocked(downlinkFrames).mockReturnValue([Buffer.alloc(340), Buffer.alloc(340)]);
    vi.mocked(downlinkMp3Frames).mockReturnValue([Buffer.alloc(AUDIO_HEADER_BYTES + DOWNLINK_MP3_CHUNK_BYTES)]);
  });

  afterEach(() => {
    setJournalSink(null);
    vi.clearAllMocks();
  });

  /** Seeds a conversation on the shared test Db, returning its id. */
  async function seedStore(): Promise<{ conversationId: string }> {
    const conversation = await createConversation(db, userId, 'seeded');
    return { conversationId: conversation.id };
  }

  it('loads history from the store before the current turn', async () => {
    const { conversationId } = await seedStore();
    await storeAppendMessage(db, userId, conversationId, { role: 'user', parts: [{ type: 'text', text: 'prior turn' }] });
    await storeAppendMessage(db, userId, conversationId, { role: 'assistant', parts: [{ type: 'text', text: 'prior reply' }] });
    session.activeConversationId = conversationId;
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);

    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    const generateArgs = vi.mocked(bobAgent.generate).mock.calls[0]![0]!;
    const messages = (generateArgs as { messages: ChatMessage[] }).messages;
    expect(messages).toEqual([
      { role: 'user', content: 'prior turn' },
      { role: 'assistant', content: 'prior reply' },
      { role: 'user', content: 'user said this' },
    ]);
  });

  it('appends the completed turn to the store', async () => {
    const { conversationId } = await seedStore();
    session.activeConversationId = conversationId;
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);

    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    expect(await loadCardputerHistory(db, userId, conversationId)).toEqual([
      { role: 'user', content: 'user said this' },
      { role: 'assistant', content: 'reply text' },
    ]);
  });

  it('D1: a turn that called a tool is replayed to the next turn as that tool call, not as bare text', async () => {
    const { conversationId } = await seedStore();
    session.activeConversationId = conversationId;
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    const input = { duration: 'PT3M' };
    vi.mocked(bobAgent.generate).mockResolvedValueOnce({
      text: "I've set a timer for 3 minutes.", toolCalls: [],
      steps: [
        {
          toolCalls: [{ toolName: 'set_timer' }],
          content: [
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'set_timer', input },
            { type: 'tool-result', toolCallId: 'call-1', toolName: 'set_timer', input, output: { ok: true, timerId: 'tmr_1' } },
          ],
        },
        { content: [{ type: 'text', text: "I've set a timer for 3 minutes." }] },
      ],
    } as never);

    await runTurn(appDeps.turn, socket, session, 'turn_abc123');
    session.stage = 'responding';
    session.audioChunks = [Buffer.alloc(320)];
    await runTurn(appDeps.turn, socket, session, 'turn_abc124');

    const second = vi.mocked(bobAgent.generate).mock.calls[1]?.[0] as { messages: Array<{ role: string; content: unknown }> } | undefined;
    expect(second?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    expect(second?.messages[1]?.content).toEqual([expect.objectContaining({ type: 'tool-call', toolCallId: 'call-1', toolName: 'set_timer', input })]);
    expect(JSON.stringify(second?.messages[2]?.content)).toContain('tmr_1');
  });

  it('creates a fresh conversation when the pinned one was deleted, titled deriveTitle(transcript)', async () => {
    const { conversationId } = await seedStore();
    await deleteConversation(db, userId, conversationId);
    session.activeConversationId = conversationId;
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);

    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    const journalText = journals.join('\n');
    expect(journalText).not.toContain('v2.conversation_reresolved');
    expect(journalText).not.toContain('v2.turn_persist_failed');
    expect(journalText).toContain('v2.turn_completed');
    expect(session.activeConversationId).not.toBe(conversationId);

    expect(await loadCardputerHistory(db, userId, session.activeConversationId!)).toEqual([
      { role: 'user', content: 'user said this' },
      { role: 'assistant', content: 'reply text' },
    ]);
    expect((await getActive(db, userId))?.conversationId).toBe(session.activeConversationId);
    expect((await getActive(db, userId))?.surface).toBe('device');
  });

  it('C-10: a device turn writes the pointer with surface device in the same transaction', async () => {
    const { conversationId } = await seedStore();
    session.activeConversationId = conversationId;
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    const received: AccountEvent[] = [];
    const stop = getAccountEvents().subscribe(userId, (event) => received.push(event));

    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    const active = await getActive(db, userId);
    expect(active?.conversationId).toBe(conversationId);
    expect(active?.surface).toBe('device');
    const changed = received.filter((event) => event.type === 'active.changed');
    expect(changed).toHaveLength(1);
    if (changed[0]!.type === 'active.changed') {
      expect(changed[0]!.conversation_id).toBe(conversationId);
      expect(changed[0]!.surface).toBe('device');
    }
    expect(received.some((event) => event.type === 'message.appended')).toBe(true);
    stop();
  });

  it('FR-025: the pointer changes mid-turn and the turn still saves in its original conversation', async () => {
    const pinned = await createConversation(db, userId, 'pinned by device');
    const movedTo = await createConversation(db, userId, 'web moved here');
    session.activeConversationId = pinned.id;
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);

    // A web turn moves the pointer to `movedTo` between turn_start and persist.
    await withUser(db, userId, (tx) => setActive(tx, userId, movedTo.id, 'web_text'));

    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    expect(session.activeConversationId).toBe(pinned.id);
    expect(await loadCardputerHistory(db, userId, pinned.id)).toEqual([
      { role: 'user', content: 'user said this' },
      { role: 'assistant', content: 'reply text' },
    ]);
    expect(await loadCardputerHistory(db, userId, movedTo.id)).toEqual([]);
    expect((await getActive(db, userId))?.conversationId).toBe(pinned.id);
  });

  it('a device turn with no pointer creates a conversation and sets the pointer (plan §E)', async () => {
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    const received: AccountEvent[] = [];
    const stop = getAccountEvents().subscribe(userId, (event) => received.push(event));

    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    expect(session.activeConversationId).toBeDefined();
    expect(await loadCardputerHistory(db, userId, session.activeConversationId!)).toEqual([
      { role: 'user', content: 'user said this' },
      { role: 'assistant', content: 'reply text' },
    ]);
    const active = await getActive(db, userId);
    expect(active?.conversationId).toBe(session.activeConversationId);
    expect(active?.surface).toBe('device');
    expect(received.some((event) => event.type === 'conversation.updated')).toBe(true);
    expect(received.some((event) => event.type === 'active.changed')).toBe(true);
    expect(received.some((event) => event.type === 'message.appended')).toBe(true);
    stop();
  });

  it('after new_conversation the agent gets only the current user message', async () => {
    const previous = await createConversation(db, userId, 'previous chat');
    await withUser(db, userId, (tx) => setActive(tx, userId, previous.id, 'picker'));
    session.stage = 'ready';
    session.turnRef = undefined;
    session.activeConversationId = previous.id;
    session.messages = [{ role: 'user', content: 'old turn' }, { role: 'assistant', content: 'old reply' }];
    await handleControl(appDeps, socket, session, {
      v: 1, type: 'new_conversation', id: 'test_ctrl_000001', payload: { request_id: 'newc_req_turn_001' },
    }, vi.fn());
    session.stage = 'responding';
    session.turnRef = 'turn_abc123';
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);

    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    const generateArgs = vi.mocked(bobAgent.generate).mock.calls[0]![0]!;
    expect((generateArgs as { messages: ChatMessage[] }).messages).toEqual([{ role: 'user', content: 'user said this' }]);
    expect(session.activeConversationId).toBeDefined();
    expect(session.activeConversationId).not.toBe(previous.id);
  });

  it('a conversation-less turn with an account is offered the memory tools and enqueues extraction', async () => {
    await withUser(db, userId, (tx) => setActive(tx, userId, null, 'device'));
    session.activeConversationId = undefined;
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    const worker = { enqueue: vi.fn() };
    memoryState.on = true;
    try {
      await runTurn(appDeps.turn, socket, session, 'turn_abc123', worker as unknown as MemoryExtractionWorker);
    } finally {
      memoryState.on = false;
    }

    expect(createBobAgent).toHaveBeenCalled();
    const toolsLine = journals.find((line) => line.includes('v2.agent_tools'));
    expect(toolsLine).toContain('remember');
    expect(session.activeConversationId).toBeDefined();
    expect(worker.enqueue).toHaveBeenCalledWith(userId);
  });

  it('a memory/tool wiring failure degrades to the base agent and the turn still persists', async () => {
    await withUser(db, userId, (tx) => setActive(tx, userId, null, 'device'));
    session.activeConversationId = undefined;
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    vi.mocked(createBobAgent).mockImplementationOnce(() => {
      throw new Error('wiring broke');
    });
    memoryState.on = true;
    try {
      await runTurn(appDeps.turn, socket, session, 'turn_abc123');
    } finally {
      memoryState.on = false;
    }

    const journalText = journals.join('\n');
    expect(journalText).toContain('v2.agent_tools_degraded');
    expect(journalText).not.toContain('v2.turn_failed');
    expect(bobAgent.generate).toHaveBeenCalled();
    expect(session.activeConversationId).toBeDefined();
    expect(await loadCardputerHistory(db, userId, session.activeConversationId!)).toEqual([
      { role: 'user', content: 'user said this' },
      { role: 'assistant', content: 'reply text' },
    ]);
  });

  it('delivers the reply and journals a failure when the store append fails', async () => {
    setSharedDb(Promise.resolve(deadDb()));
    session.activeConversationId = 'cnv_missing_conversation';
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);

    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    expect(journals.join('\n')).toContain('v2.turn_persist_failed');
    expect(journals.join('\n')).toContain('v2.turn_completed');
    expect(journals.join('\n')).not.toContain('v2.turn_failed');
    const sent = vi.mocked(socket.send).mock.calls.map((call) => call[0]);
    expect(sent.some((frame) => Buffer.isBuffer(frame))).toBe(true);
    expect(sent.some((frame) => typeof frame === 'string' && frame.includes('"type":"playback_end"'))).toBe(true);
    setSharedDb(Promise.resolve(db));
  });

  it('does not persist an empty transcript turn', async () => {
    const { conversationId } = await seedStore();
    session.activeConversationId = conversationId;
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    vi.mocked(transcribePcm).mockResolvedValue({ text: '   ', model: 'stt-1', seconds: 0 });

    await runTurn(appDeps.turn, socket, session, 'turn_abc123');

    expect(journals.join('\n')).toContain('v2.turn_stage_input_completed');
    expect(journals.join('\n')).toContain('v2.turn_completed');
    expect(journals.join('\n')).not.toContain('v2.turn_persist_failed');
    expect(await loadCardputerHistory(db, userId, conversationId)).toEqual([]);
  });
});

describe('runAgent', () => {
  beforeEach(() => {
    vi.mocked(bobAgent.generate).mockResolvedValue({
      text: 'hello back', toolCalls: [{ toolName: 'tool' }], response: { modelId: 'm' },
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      totalUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      steps: [{ toolCalls: [{ toolName: 'tool' }] }, { toolCalls: [] }],
      finishReason: 'stop',
    } as never);
  });

  it('passes the conversation to the agent and maps the result', async () => {
    const messages = [{ role: 'user', content: 'hi' }] as never;
    const result = await runAgent(messages);
    expect(bobAgent.generate).toHaveBeenCalledWith({ messages });
    // #396: the model id lives on response.modelId, not on the result itself.
    expect(result).toMatchObject({
      text: 'hello back',
      toolCalls: [{ toolName: 'tool' }],
      response: { modelId: 'm' },
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      totalUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      finishReason: 'stop',
    });
    expect(result.steps).toHaveLength(2);
    expect(result.stub).toBeUndefined();
  });

  it('defaults toolCalls to an empty array when absent', async () => {
    vi.mocked(bobAgent.generate).mockResolvedValue({ text: 'hi' } as never);
    const result = await runAgent([{ role: 'user', content: 'hi' }] as never);
    expect(result.toolCalls).toEqual([]);
  });
});

describe('sendStatus', () => {
  it('emits the exact status control message shape', () => {
    const socket = fakeSocket();
    sendStatus(socket, respondingSession(), 'thinking', 'turn_abc123');
    const sent = vi.mocked(socket.send).mock.calls.map((call) => call[0]);
    expect(sent).toHaveLength(1);
    const control = JSON.parse(sent[0] as string) as {
      v: number; type: string; id: string; turn_ref: string; payload: { stage: string };
    };
    expect(control.v).toBe(1);
    expect(control.type).toBe('status');
    expect(control.id).toMatch(/^status_[A-Za-z0-9_-]{8,64}$/);
    expect(control.turn_ref).toBe('turn_abc123');
    expect(control.payload).toEqual({ stage: 'thinking' });
  });

  it('does not emit when the socket is not open', () => {
    const socket = fakeSocket(3);
    sendStatus(socket, respondingSession(), 'idle', 'turn_abc123');
    expect(socket.send).not.toHaveBeenCalled();
  });
});

describe('downlink streaming', () => {
  const journals: string[] = [];
  let socket: WebSocket;
  let session: SessionDto;

  beforeEach(() => {
    journals.length = 0;
    setJournalSink((line) => journals.push(line));
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'Date'],
    });
    socket = fakeSocket();
    session = respondingSession();
    session.audioChunks = [Buffer.alloc(320)];
    vi.mocked(isEmptyTurn).mockReturnValue(false);
    vi.mocked(transcribePcm).mockResolvedValue({ text: 'user said this', model: 'stt-1', seconds: 1 });
    vi.mocked(bobAgent.generate).mockResolvedValue({
      text: 'reply text', toolCalls: [], modelId: 'model-x',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    } as never);
    vi.mocked(synthesizePcm).mockResolvedValue({ pcm: Buffer.alloc(3200), sourceRateHz: 44100 });
    vi.mocked(synthesizeMp3).mockResolvedValue({ mp3: Buffer.alloc(DOWNLINK_MP3_CHUNK_BYTES * 3) });
    vi.mocked(downlinkFrames).mockImplementation((pcm: Buffer): Buffer[] => {
      const count = Math.max(1, Math.ceil(pcm.length / DOWNLINK_FRAME_BYTES));
      return Array.from({ length: count }, () => Buffer.alloc(340));
    });
    vi.mocked(downlinkMp3Frames).mockImplementation((mp3: Buffer): Buffer[] => {
      const count = Math.max(1, Math.ceil(mp3.length / DOWNLINK_MP3_CHUNK_BYTES));
      return Array.from({ length: count }, () => Buffer.alloc(AUDIO_HEADER_BYTES + DOWNLINK_MP3_CHUNK_BYTES));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    setJournalSink(null);
    vi.clearAllMocks();
  });

  it('trims replies beyond MAX_DOWNLINK_PCM_BYTES before framing', async () => {
    const oversized = Buffer.alloc(MAX_DOWNLINK_PCM_BYTES + DOWNLINK_FRAME_BYTES);
    vi.mocked(synthesizePcm).mockResolvedValue({ pcm: oversized, sourceRateHz: 44100 });
    const turn = runTurn(appDeps.turn, socket, session, 'turn_abc123');
    // #674: PCM is paced at real time, so the 60 s cap takes ~60 s to send.
    await vi.advanceTimersByTimeAsync(65_000);
    await turn;

    const journalText = journals.join('\n');
    expect(journalText).toContain('v2.downlink_trimmed');
    expect(journalText).toContain(`"original_bytes":${MAX_DOWNLINK_PCM_BYTES + DOWNLINK_FRAME_BYTES}`);
    expect(journalText).toContain(`"trimmed_bytes":${MAX_DOWNLINK_PCM_BYTES}`);
    expect(journalText).toContain(`"pcm_bytes":${MAX_DOWNLINK_PCM_BYTES}`);
    const framed = vi.mocked(downlinkFrames).mock.calls[0]![0]!;
    expect(framed.length).toBe(MAX_DOWNLINK_PCM_BYTES);
    const sent = vi.mocked(socket.send).mock.calls.map((call) => call[0]);
    const audioFrames = sent.filter((frame) => Buffer.isBuffer(frame));
    expect(audioFrames).toHaveLength(MAX_DOWNLINK_PCM_BYTES / DOWNLINK_FRAME_BYTES);
    expect(journalText).toContain(`"down_frames":${MAX_DOWNLINK_PCM_BYTES / DOWNLINK_FRAME_BYTES}`);
  }, 25_000);

  it('does not journal v2.downlink_trimmed for replies within the limit', async () => {
    const turn = runTurn(appDeps.turn, socket, session, 'turn_abc123');
    await vi.advanceTimersByTimeAsync(1_000);
    await turn;
    expect(journals.join('\n')).not.toContain('v2.downlink_trimmed');
  });

  it('backs off on TCP backpressure and aborts after 10 s of sustained stall', async () => {
    const backpressured = { readyState: 1, bufferedAmount: 64 * 1024, send: vi.fn() } as unknown as WebSocket;
    vi.mocked(synthesizePcm).mockResolvedValue({ pcm: Buffer.alloc(MAX_DOWNLINK_PCM_BYTES), sourceRateHz: 44100 });
    const turn = runTurn(appDeps.turn, backpressured, session, 'turn_abc123');
    await vi.advanceTimersByTimeAsync(12_000);
    await turn;

    const journalText = journals.join('\n');
    expect(journalText).toContain('v2.downlink_aborted');
    expect(journalText).toContain('"buffered_bytes":65536');
    expect(journalText).toContain('"frames_sent":0');
    expect(journalText).toContain(`"frames_total":${MAX_DOWNLINK_PCM_BYTES / DOWNLINK_FRAME_BYTES}`);
    expect(journalText).toContain('"down_frames":0');
    const sent = vi.mocked(backpressured.send).mock.calls.map((call) => call[0]);
    expect(sent).toHaveLength(6);
    expect(sent[0]).toContain('"type":"status"');
    expect(sent[0]).toContain('"stage":"thinking"');
    expect(sent[1]).toContain('"type":"reply_text"'); // #318: before playback_start
    expect(sent[2]).toContain('"type":"status"');
    expect(sent[2]).toContain('"stage":"speaking"');
    expect(sent[3]).toContain('"type":"playback_start"');
    expect(sent[4]).toContain('"type":"playback_end"');
    expect(sent.at(-1)).toContain('"type":"status"');
    expect(sent.at(-1)).toContain('"stage":"idle"');
  });

  it('backs off while backpressure persists and resumes once it clears', async () => {
    let buffered = 64 * 1024;
    const backpressured = {
      readyState: 1,
      send: vi.fn(),
      get bufferedAmount(): number {
        return buffered;
      },
    } as unknown as WebSocket;
    setTimeout(() => {
      buffered = 0;
    }, 200);
    const turn = runTurn(appDeps.turn, backpressured, session, 'turn_abc123');
    await vi.advanceTimersByTimeAsync(2_000);
    await turn;

    expect(journals.join('\n')).not.toContain('v2.downlink_aborted');
    const sent = vi.mocked(backpressured.send).mock.calls.map((call) => call[0]);
    const audioFrames = sent.filter((frame) => Buffer.isBuffer(frame));
    // Every frame arrives: a frame held by backpressure is retried, not skipped (#999).
    // The old loop dropped one frame per 50 ms wait and sent 6 of these 10.
    expect(audioFrames).toHaveLength(10);
    expect(journals.join('\n')).toContain('"down_frames":10');
  });

  it('reports down_frames as frames actually sent when the socket closes mid-stream', async () => {
    const closingSocket = fakeSocket();
    const closingState = closingSocket as unknown as { readyState: number };
    let sends = 0;
    closingSocket.send = vi.fn(() => {
      sends += 1;
      if (sends === 5) closingState.readyState = 3;
    }) as never;
    const turn = runTurn(appDeps.turn, closingSocket, session, 'turn_abc123');
    await vi.advanceTimersByTimeAsync(1_000);
    await turn;

    const sent = vi.mocked(closingSocket.send).mock.calls.map((call) => call[0]);
    expect(sent.filter((frame) => Buffer.isBuffer(frame))).toHaveLength(1);
    expect(journals.join('\n')).toContain('"down_frames":1');
  });
});
import { bindPrivateCallbacks } from '../../src/tasks/agent-callbacks.ts';
import { ensurePrivateSpace } from '../../src/spaces/store.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
describe('device tool output links the written item (#517)', () => {
  it('create task and create event name the item, its Space and its title', async () => {
    const pg = await createTestDb();
    try {
      const db = asDb(pg);
      const userId = await resolveDevAccount(db);
      const spaceId = (await ensurePrivateSpace(db, userId)).id;
      const scope = { timeZone: 'Asia/Kolkata', localTimeDues: false };
      const tools = createProductivityTools(bindPrivateCallbacks(db, userId, spaceId, scope), { localTimeDues: false });
      const run = async (name: string, input: unknown): Promise<unknown> =>
        tools[name]!.execute!(input as never, { toolCallId: 't', messages: [], context: {} });

      expect(await run('create_task', { title: 'Milk' }))
        .toEqual({ ok: true, taskId: expect.any(String), spaceId, title: 'Milk' });
      expect(await run('create_event', {
        title: 'Dentist',
        startIso: '2026-10-01T10:00:00+05:30',
        endIso: '2026-10-01T11:00:00+05:30',
        zone: 'Asia/Kolkata',
      })).toEqual({ ok: true, eventId: expect.any(String), spaceId, title: 'Dentist' });
    } finally {
      await closeTestDb(pg).catch(() => undefined);
    }
  });
});
