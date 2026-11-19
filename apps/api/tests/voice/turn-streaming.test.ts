/**
 * #317 streaming replies: the agent's text is split into sentences, each is
 * synthesized as soon as it completes and appended to ONE audio_down stream.
 * The real splitter and OLX2 framing run; STT, TTS (a stub with a latency
 * model) and the agent stream are doubles. Also measures time to the first
 * audio_down frame against the batch path (docs/perf/streaming-replies.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { MAX_DOWNLINK_MP3_BYTES, MP3_16K_MONO_FORMAT, type SessionDto } from '../../src/voice/protocol.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { runTurn as processTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { startEarlyPrep } from '../../src/voice/turn/generate.ts';

vi.mock('../../src/voice/audio/stt-tts.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/voice/audio/stt-tts.ts')>()),
  isEmptyTurn: vi.fn(() => false),
  isTooShortTurn: vi.fn(() => false),
  transcribePcm: vi.fn(),
  synthesizeMp3: vi.fn(),
  synthesizePcm: vi.fn(),
}));


vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  bobAgent: { generate: vi.fn(), stream: vi.fn() },
  BOB_SYSTEM_TEST_MODE: false,
  AI_STUB_MODE: false,
  MAX_TTS_INPUT_CHARS: 700,
  BOB_STT_LANGUAGE: 'en',
  isProviderError: () => false,
  providerErrorStatus: () => undefined,
  debugLog: vi.fn(),
  isFrameDebugEnabled: () => false,
  synthesizeSpeech: vi.fn(),
  transcribeAudio: vi.fn(),
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

// A paired turn's store: no memory, no Space, an in-scope game chosen per test.
vi.mock('../../src/platform/db/db.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/platform/db/db.ts')>()),
  getDb: vi.fn(async () => ({})),
}));
vi.mock('../../src/memory/available.ts', () => ({ memoryAvailable: vi.fn(async () => false) }));
vi.mock('../../src/spaces/store.ts', () => ({ ensurePrivateSpace: vi.fn(async () => ({ id: 'space_private_1' })) }));
vi.mock('../../src/spaces/active.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/spaces/active.ts')>()),
  getActiveSpace: vi.fn(async () => null),
}));
vi.mock('../../src/voice/cardputer-conversation.ts', () => ({
  loadCardputerHistory: vi.fn(async () => []),
  persistDeviceTurn: vi.fn(async () => ({ conversationId: 'conv_1', created: false, title: 't', userMessageId: 'm', changedAt: 1 })),
}));
// Null: no scope, so no early snapshot.
vi.mock('../../src/conversations/scope.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/conversations/scope.ts')>()),
  getConversationScope: vi.fn(async () => null),
}));
vi.mock('../../src/voice/game-tools.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/voice/game-tools.ts')>()),
  resolveGameScope: vi.fn(),
}));

import { synthesizeMp3, synthesizePcm, transcribePcm } from '../../src/voice/audio/stt-tts.ts';
import { bobAgent, BOB_TTS_VOICE } from '@bob/ai';
import { newGameTurnState, resolveGameScope, type GameScope } from '../../src/voice/game-tools.ts';
import { persistDeviceTurn } from '../../src/voice/cardputer-conversation.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
/** The stub TTS latency model: a fixed provider round trip plus a per-char cost. */
const TTS_BASE_MS = 120;
const TTS_MS_PER_CHAR = 1.5;
/** The stub agent emits one word every AGENT_TOKEN_MS. */
const AGENT_TOKEN_MS = 12;
/** MP3 bytes the stub TTS returns per reply character (kept under the pacer's prime). */
const MP3_BYTES_PER_CHAR = 40;

const THREE_SENTENCES = 'It is sunny today. The high is twenty degrees. Take a light jacket tonight.';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An MP3 of `bytes` that opens with a parseable MPEG1 Layer III header. */
function mp3Of(bytes: number): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE((((0x7ff << 21) | (3 << 19) | (1 << 17) | (1 << 16) | (5 << 12) | (3 << 6)) >>> 0), 0);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, bytes - 4))]);
}

/** Word deltas as a model streams them: "It", " is", " sunny", ... */
function wordDeltas(text: string): string[] {
  return text.split(/(?= )/);
}

interface Sent {
  at: number;
  type: string;
  seq?: number;
  payload?: Record<string, unknown>;
}

/** A socket that records each DTO type and each audio_down frame's sequence;
 *  `onSend` runs after each send is recorded. */
function recordingSocket(onSend?: () => void): { socket: WebSocket; sent: Sent[] } {
  const sent: Sent[] = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn((data: Buffer | string) => {
      if (typeof data === 'string') {
        const dto = JSON.parse(data) as { type: string; payload?: Record<string, unknown> };
        sent.push({ at: Date.now(), type: dto.type, payload: dto.payload });
      } else {
        sent.push({ at: Date.now(), type: 'audio_down', seq: data.readUInt32BE(12) });
      }
      onSend?.();
    }),
  };
  return { socket: socket as unknown as WebSocket, sent };
}

/** A StreamTextResult double: word deltas on a clock, optionally an error part. */
function agentStream(text: string, options: { errorAt?: number; tokenMs?: number } = {}): unknown {
  const deltas = wordDeltas(text);
  async function* parts(): AsyncGenerator<{ type: string; text?: string; error?: unknown }> {
    yield { type: 'start-step' };
    for (const [index, delta] of deltas.entries()) {
      await sleep(options.tokenMs ?? AGENT_TOKEN_MS);
      if (index === options.errorAt) {
        yield { type: 'error', error: new Error('model stream broke') };
        return;
      }
      yield { type: 'text-delta', text: delta };
    }
    yield { type: 'finish' };
  }
  const done = <T>(value: T): Promise<T> => Promise.resolve(value);
  return {
    stream: parts(), toolCalls: done([]), steps: done([]), response: done({ modelId: 'model-x' }),
    usage: done(undefined), totalUsage: done(undefined), finishReason: done('stop'), providerMetadata: done(undefined),
  };
}

/** The stub TTS: latency grows with the text; `failOn` / `bigOn` pick a 1-based call. */
function stubTts(options: { failOn?: number; bigOn?: number } = {}): void {
  let call = 0;
  vi.mocked(synthesizeMp3).mockImplementation(async (text: string) => {
    call += 1;
    const index = call;
    await sleep(TTS_BASE_MS + TTS_MS_PER_CHAR * text.length);
    if (index === options.failOn) throw new Error('tts provider down');
    return { mp3: mp3Of(index === options.bigOn ? MAX_DOWNLINK_MP3_BYTES : text.length * MP3_BYTES_PER_CHAR) };
  });
}

/** The agent doubles: stream() resolves (async, as ToolLoopAgent's does) to word
 *  deltas; generate() takes as long, then returns it all. */
function stubAgent(reply: string, options: { errorAt?: number; tokenMs?: number } = {}): void {
  vi.mocked(bobAgent.stream).mockImplementation(async () => agentStream(reply, options) as never);
  vi.mocked(bobAgent.generate).mockImplementation(async () => {
    await sleep((options.tokenMs ?? AGENT_TOKEN_MS) * wordDeltas(reply).length);
    return { text: reply, toolCalls: [] } as never;
  });
}

function mp3Session(): SessionDto {
  const session = createSession();
  session.stage = 'responding';
  session.turnRef = 'turn_abc123';
  session.formatId = MP3_16K_MONO_FORMAT;
  session.audioChunks = [Buffer.alloc(32_000)];
  session.turnAbort = new AbortController();
  return session;
}

/** A paired MP3 session in conversation conv_1 whose game scope is `mode`. */
function pairedSession(mode: GameScope['mode']): SessionDto {
  vi.mocked(resolveGameScope).mockResolvedValue({ mode, tools: {}, turn: newGameTurnState() });
  const paired = createSession({ kind: 'device', userId: 'user_1', deviceId: 'dev_1', name: 'cardputer' });
  const session = mp3Session();
  Object.assign(session, { auth: (paired as DeviceSession).auth, activeConversationId: 'conv_1' });
  return session;
}

interface TurnRun {
  sent: Sent[];
  journals: Array<Record<string, unknown>>;
  lines: string[];
  startedAt: number;
  session: SessionDto;
}

async function runTurn(session: SessionDto = mp3Session(), during?: (sent: Sent[], session: SessionDto) => void): Promise<TurnRun> {
  const lines: string[] = [];
  setJournalSink((line) => lines.push(line));
  const { socket, sent } = recordingSocket(during === undefined ? undefined : (): void => during(sent, session));
  const startedAt = Date.now();
  await processTurn(appDeps.turn, socket, session, 'turn_abc123');
  setJournalSink(null);
  return { sent, journals: lines.map((line) => JSON.parse(line) as Record<string, unknown>), lines, startedAt, session };
}

function event(run: TurnRun, name: string): Record<string, unknown> | undefined {
  return run.journals.find((entry) => entry.event === name);
}

function firstAudioMs(run: TurnRun): number {
  const frame = run.sent.find((item) => item.type === 'audio_down');
  if (!frame) throw new Error('no audio_down frame was sent');
  return frame.at - run.startedAt;
}

describe('streaming replies (#317)', () => {
  beforeEach(() => {
    vi.mocked(transcribePcm).mockResolvedValue({ text: 'what is the weather', model: 'stt-1', seconds: 1 });
    stubAgent(THREE_SENTENCES);
    stubTts();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('speaks each sentence in order into one audio_down stream with continuous sequence numbers', async () => {
    const run = await runTurn();
    expect(bobAgent.stream).toHaveBeenCalledTimes(1);
    expect(bobAgent.generate).not.toHaveBeenCalled();
    expect(vi.mocked(synthesizeMp3).mock.calls.map((call) => call[0])).toEqual([
      'It is sunny today.', 'The high is twenty degrees.', 'Take a light jacket tonight.',
    ]);
    const types = run.sent.map((item) => item.type).filter((type) => type !== 'audio_down');
    expect(types.filter((type) => type === 'playback_start')).toHaveLength(1);
    expect(types.filter((type) => type === 'playback_end')).toHaveLength(1);
    expect(types.indexOf('reply_text')).toBeLessThan(types.indexOf('playback_end'));
    expect(types.at(-1)).toBe('status');
    const seqs = run.sent.filter((item) => item.type === 'audio_down').map((item) => item.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index));
    const start = run.sent.findIndex((item) => item.type === 'playback_start');
    const end = run.sent.findIndex((item) => item.type === 'playback_end');
    expect(run.sent.findIndex((item) => item.type === 'audio_down')).toBeGreaterThan(start);
    expect(run.sent.findLastIndex((item) => item.type === 'audio_down')).toBeLessThan(end);
    expect(run.sent.find((item) => item.type === 'reply_text')!.payload).toEqual({ heard: 'what is the weather', reply: THREE_SENTENCES });
  });

  it('journals first_token_ms, first_audio_ms, the sentence count and per-sentence TTS ms, never sentence text', async () => {
    const run = await runTurn();
    const completed = event(run, 'v2.turn_completed')!;
    expect(completed).toMatchObject({ streamed: true, sentences: 3 });
    expect(completed.first_audio_ms).toEqual(expect.any(Number));
    expect(completed.first_token_ms).toEqual(expect.any(Number));
    expect(completed.first_token_ms as number).toBeLessThanOrEqual(completed.first_audio_ms as number);
    expect(String(completed.tts_ms_per_sentence).split(',').map(Number)).toHaveLength(3);
    expect(completed).not.toHaveProperty('partial');
    const ttsStage = run.journals.filter((entry) => entry.stage === 'tts').map((entry) => entry.outcome);
    expect(ttsStage).toEqual(['started', 'completed']);
    for (const word of ['sunny', 'jacket', 'weather']) expect(run.lines.join('\n')).not.toContain(word);
  });

  it('keeps the full reply as the stored text, not only the first sentence', async () => {
    const run = await runTurn();
    expect(run.session.messages.at(-1)).toEqual({ role: 'assistant', content: THREE_SENTENCES });
  });

  it('sends the first audio_down frame while the agent is still writing', async () => {
    // A slower model (40 ms a word): the reply takes ~560 ms to write, while
    // sentence 1 is complete at ~160 ms and its TTS takes ~150 ms.
    stubAgent(THREE_SENTENCES, { tokenMs: 40 });
    const run = await runTurn();
    const agentDone = run.journals.find((entry) => entry.stage === 'agent' && entry.outcome === 'completed')!;
    expect(Date.parse(String(agentDone.ts))).toBeGreaterThanOrEqual(run.startedAt + firstAudioMs(run));
  });

  it('TTS failing on sentence 3: the audio sent plays, playback_end ends it, the turn is partial', async () => {
    stubTts({ failOn: 3 });
    const run = await runTurn();
    expect(synthesizeMp3).toHaveBeenCalledTimes(3);
    const types = run.sent.map((item) => item.type);
    expect(types).toContain('playback_end');
    expect(types).not.toContain('error');
    const completed = event(run, 'v2.turn_completed')!;
    expect(completed).toMatchObject({ partial: 'tts_failed', sentences: 2 });
    expect(run.journals.find((entry) => entry.stage === 'tts' && entry.outcome === 'failed')).toBeDefined();
  });

  it('TTS failing on the first sentence ends the turn like a batch TTS failure', async () => {
    stubTts({ failOn: 1 });
    const run = await runTurn();
    const types = run.sent.map((item) => item.type);
    expect(types).not.toContain('playback_start');
    expect(types).toContain('error');
    expect(event(run, 'v2.turn_failed')).toMatchObject({ stage: 'tts' });
  });

  it('an agent stream error before the first sentence fails the turn with no audio', async () => {
    stubAgent(THREE_SENTENCES, { errorAt: 2 });
    const streamed = await runTurn();
    expect(streamed.sent.map((item) => item.type)).toEqual(['status', 'error']);
    expect(event(streamed, 'v2.turn_failed')).toMatchObject({ stage: 'agent' });
    expect(synthesizeMp3).not.toHaveBeenCalled();
  });

  it('an agent error after audio started ends playback cleanly, journals the failure, sends no error', async () => {
    // ~40 ms a word: sentence 1 is playing well before the error at word 10.
    stubAgent(THREE_SENTENCES, { errorAt: 10, tokenMs: 40 });
    const run = await runTurn();
    const types = run.sent.map((item) => item.type);
    expect(types).toContain('audio_down');
    expect(types.filter((type) => type === 'playback_end')).toHaveLength(1);
    expect(types).not.toContain('error');
    expect(run.sent.at(-1)).toMatchObject({ type: 'status', payload: { stage: 'idle' } });
    expect(event(run, 'v2.turn_failed')).toMatchObject({ stage: 'agent' });
    expect(event(run, 'v2.turn_completed')).toBeUndefined();
  });

  it.each([
    ['none', true],
    ['paused', true],
    ['active', false],
  ] as const)('a paired turn with game mode %s streams: %s', async (mode, streams) => {
    const run = await runTurn(pairedSession(mode));
    expect(resolveGameScope).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bobAgent.stream).mock.calls.length).toBe(streams ? 1 : 0);
    expect(vi.mocked(bobAgent.generate).mock.calls.length).toBe(streams ? 0 : 1);
    const completed = event(run, 'v2.turn_completed')!;
    if (streams) expect(completed).toMatchObject({ streamed: true, sentences: 3 });
    else expect(completed).not.toHaveProperty('streamed');
    expect(run.sent.find((item) => item.type === 'reply_text')!.payload).toMatchObject({ reply: THREE_SENTENCES });
  });

  it('a finished reply played sentence by sentence that TTS cuts short is saved as cut to what was heard', async () => {
    // An ACTIVE game's reply is not streamed live; streamPlayback still plays it clause by clause.
    stubTts({ failOn: 3 });
    const run = await runTurn(pairedSession('active'));
    expect(vi.mocked(bobAgent.stream)).not.toHaveBeenCalled();
    expect(run.sent.map((item) => item.type)).toContain('playback_end');
    const saved = vi.mocked(persistDeviceTurn).mock.calls.at(-1)![2] as unknown as { replyText: string; heardChars?: number };
    expect(saved.replyText).toBe(THREE_SENTENCES);
    // The first two sentences were heard, the third was not.
    expect(saved.heardChars).toBe('It is sunny today. The high is twenty degrees. '.length);
    // The journal reports the sentence playback as a live stream's would.
    const completed = event(run, 'v2.turn_completed')!;
    expect(completed).toMatchObject({ partial: 'tts_failed', sentences: 2 });
    expect(String(completed.tts_ms_per_sentence).split(',')).toHaveLength(2);
  });

  it('stops at a sentence boundary when the next sentence would pass the 3 MB MP3 cap', async () => {
    stubTts({ bigOn: 2 });
    const run = await runTurn();
    expect(event(run, 'v2.downlink_trimmed')).toBeDefined();
    expect(event(run, 'v2.turn_completed')).toMatchObject({ partial: 'size_cap', sentences: 1 });
    const frames = run.sent.filter((item) => item.type === 'audio_down').length;
    expect(frames).toBe(Math.ceil(('It is sunny today.'.length * MP3_BYTES_PER_CHAR) / 1024));
    expect(run.sent.map((item) => item.type)).toContain('playback_end');
  });

  it('keeps the 700-character cap: sentences past it are not synthesized', async () => {
    const sentence = `${'This sentence is exactly padded to be long enough '.slice(0, 48)}. `;
    const reply = sentence.repeat(20).trim();
    stubAgent(reply, { tokenMs: 1 });
    stubTts();
    const run = await runTurn();
    const spoken = vi.mocked(synthesizeMp3).mock.calls.map((call) => call[0]);
    expect(spoken.length).toBe(Math.floor(700 / sentence.length));
    expect(event(run, 'v2.turn_completed')).toMatchObject({ chars_capped: true });
    expect(event(run, 'v2.turn_completed')).not.toHaveProperty('partial');
    expect(run.session.messages.at(-1)).toEqual({ role: 'assistant', content: reply });
  });

  it('a cancel mid-stream abandons the pending TTS and ends the stream at once (#315)', async () => {
    // #898: the cancel here fires on sentence 1's first audio_down frame, so
    // by cancel time sentence 1 has already COMPLETED synthesis, and up to
    // TTS_AHEAD more sentences may already be synthesizing concurrently with
    // it -- hence the 1 + TTS_AHEAD bound below. That is not a new synthesis
    // started after the cancel -- it is the lookahead the feature intends.
    // What must still hold: no FURTHER synthesis starts once the cancel
    // fires, any sentence still in flight is abandoned (its audio never
    // reaches the device), and the stream ends at once.
    const TTS_AHEAD = 2;
    let aborted = false;
    let callsAtCancel = -1;
    const run = await runTurn(mp3Session(), (sent, session) => {
      if (!aborted && sent.some((item) => item.type === 'audio_down')) {
        aborted = true;
        callsAtCancel = vi.mocked(synthesizeMp3).mock.calls.length;
        session.turnAbort!.abort();
      }
    });
    // Drains every microtask still queued after the turn's own promise chain
    // settled, so a synthesis sneaking in behind the cancel would show up here.
    await new Promise((resolve) => setImmediate(resolve));

    const audioIndex = run.sent.findIndex((item) => item.type === 'audio_down');
    const afterAbort = run.sent.slice(audioIndex + 1);
    expect(afterAbort.filter((item) => item.type === 'audio_down')).toEqual([]); // no audio_down follows the cancel
    expect(afterAbort.map((item) => item.type)).toEqual(['playback_end', 'status']); // ends at once
    expect(afterAbort.at(-1)!.payload).toEqual({ stage: 'idle' });

    expect(callsAtCancel).toBeGreaterThan(0);
    expect(callsAtCancel).toBeLessThanOrEqual(1 + TTS_AHEAD); // sentence 1 (completed) + up to TTS_AHEAD in flight
    expect(vi.mocked(synthesizeMp3).mock.calls.length).toBe(callsAtCancel); // no synthesis started after the cancel
    expect(event(run, 'v2.turn_cancelled')).toMatchObject({ stage: 'stream', down_frames: 1 });
    expect(event(run, 'v2.turn_completed')).toBeUndefined();
  });

  it('a PCM session keeps the batch path', async () => {
    vi.mocked(synthesizePcm).mockResolvedValue({ pcm: Buffer.alloc(640), sourceRateHz: 16_000 });
    const session = mp3Session();
    session.formatId = 1;
    await runTurn(session);
    expect(bobAgent.stream).not.toHaveBeenCalled();
    expect(synthesizePcm).toHaveBeenCalledWith(THREE_SENTENCES, undefined, BOB_TTS_VOICE);
  });
});
