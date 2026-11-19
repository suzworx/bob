/**
 * One focused test per turn stage (issue #617). Every stage takes a TurnDeps, so
 * these run with plain fake objects: no vi.mock, no database, no network.
 */
import type { WebSocket } from 'ws';
import { BOB_TTS_VOICE, traceSpan, ttsVoiceFor } from '@bob/ai';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AUDIO_HEADER_BYTES, MP3_16K_MONO_FORMAT, PCM16_16K_MONO_FORMAT } from '../../src/voice/protocol.ts';
import { createSession, sendStatus, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import type { TurnDeps } from '../../src/voice/turn/deps.ts';
import { TurnCancelledError, abortable, delay } from '../../src/voice/turn/abort.ts';
import {
  DEVICE_RING_BYTES, PCM_DRAIN_BYTES_PER_SECOND, PCM_PACING, newPacerState, streamFrames,
} from '../../src/voice/turn/pacing.ts';
import { transcribeTurn } from '../../src/voice/turn/transcribe.ts';
import { buildAgentMessages, memoryEmbedderDep, resolveTurnMemory } from '../../src/voice/turn/context.ts';
import { createSentencePlayback, streamPlayback } from '../../src/voice/turn/playback.ts';
import { persistTurn } from '../../src/voice/turn/persist.ts';
import { failTurn } from '../../src/voice/turn/failure.ts';
import { runAnnouncement } from '../../src/voice/turn/announce.ts';
import { appTurnTools } from '../../src/voice/turn/tools.ts';
import { createAppTurnExtension } from '../../src/bob-apps/app-turn-extension.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';
import type { TurnMemoryContext } from '../../src/voice/turn/context.ts';

/** The device turn reaches the installed apps only through deps.appTurnTools, as app-deps.ts wires it. */
const appDeps = { appTurnTools: createAppTurnExtension(saveAppIdea) } as unknown as TurnDeps;
const marketingTurnTools = (memory: TurnMemoryContext) => appTurnTools(appDeps, memory);

vi.mock('@bob/ai', async (orig) => ({
  ...(await orig<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, run) => run()),
}));

type FakeSocket = { readyState: number; bufferedAmount: number; send: ReturnType<typeof vi.fn> };
const fakeSocket = (): FakeSocket => ({ readyState: 1, bufferedAmount: 0, send: vi.fn() });
const asWs = (socket: FakeSocket): WebSocket => socket as unknown as WebSocket;
/** The JSON control messages a fake socket received, in order. */
const controls = (socket: FakeSocket): Array<{ type: string; payload: Record<string, unknown> }> =>
  socket.send.mock.calls.flatMap(([data]) => (typeof data === 'string' ? [JSON.parse(data)] : []));
const binaryFrames = (socket: FakeSocket): number => socket.send.mock.calls.filter(([data]) => typeof data !== 'string').length;

/** A TurnDeps whose every seam fails loudly unless the test provides it. */
function fakeDeps(over: Partial<TurnDeps> = {}): TurnDeps {
  const unexpected = (name: string) => (): never => { throw new Error(`unexpected deps.${name}`); };
  return {
    getDb: unexpected('getDb') as TurnDeps['getDb'],
    deviceSessions: { flushPending: vi.fn() } as unknown as TurnDeps['deviceSessions'],
    timersChanged: unexpected('timersChanged') as TurnDeps['timersChanged'],
    embedder: unexpected('embedder') as TurnDeps['embedder'],
    stt: unexpected('stt') as TurnDeps['stt'],
    ttsPcm: unexpected('ttsPcm') as TurnDeps['ttsPcm'],
    ttsMp3: unexpected('ttsMp3') as TurnDeps['ttsMp3'],
    agent: { base: unexpected('agent.base'), create: unexpected('agent.create') } as unknown as TurnDeps['agent'],
    accountEvents: unexpected('accountEvents') as TurnDeps['accountEvents'],
    ...over,
  };
}

let journalLines: Array<Record<string, unknown>>;
const events = (): string[] => journalLines.map((line) => String(line.event));

beforeEach(() => {
  journalLines = [];
  setJournalSink((line) => journalLines.push(JSON.parse(line)));
});
afterEach(() => setJournalSink(null));

describe('Marketing: real prepared private voice scope', () => {
  type Support = typeof import('../support/test-db.ts');
  let support: Support;
  let pg: Awaited<ReturnType<Support['createTestDb']>>;
  beforeAll(async () => { support = await import('../support/test-db.ts'); pg = await support.createTestDb(); });
  afterAll(async () => { if (pg) await support.closeTestDb(pg); });

  async function fixture(): Promise<{ memory: TurnMemoryContext; installationId: string; sessionId: string }> {
    const { installMarketingPackage, changeMarketingLifecycle, selectMarketingInstallation } = await import('../../src/bob-apps/marketing-install.ts');
    const { createConversation } = await import('../../src/conversations/store.ts');
    const { withUser } = await import('../../src/platform/db/db.ts');
    const { preparePrivateDeviceTurn } = await import('../../src/voice/cardputer-conversation.ts');
    const db = support.asDb(pg), owner = await support.addAccount(pg);
    const installed = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, owner.sessionId);
    await changeMarketingLifecycle(db, owner.userId, installed.id, { operation: 'activate', expectedRevision: installed.revision, mutationId: randomUUID() });
    await selectMarketingInstallation(db, owner.userId, { installationId: installed.id, mutationId: randomUUID() }, owner.sessionId);
    const conversation = await withUser(db, owner.userId, tx => createConversation(tx, owner.userId, 'Voice verification'));
    const prepared = await preparePrivateDeviceTurn(db, owner.userId, { pinnedRef: conversation.id, transcriptText: 'Synthetic campaign request', deviceId: null, userMessageId: `msg_${randomUUID()}`, replyMessageId: `msg_${randomUUID()}` });
    if (!prepared) throw new Error('Expected a committed private voice anchor');
    return { memory: { db, userId: owner.userId, memoryOn: false, timeZone: 'UTC', conversation: prepared.scope, prepared }, installationId: installed.id, sessionId: owner.sessionId };
  }

  it('offers the selected app with memory off, executes against its committed anchor, and deduplicates retries', async () => {
    const { memory, installationId } = await fixture();
    const tools = await marketingTurnTools(memory);
    const execute = tools.create_campaign?.execute;
    if (!execute) throw new Error('Expected create_campaign');
    const input = { name: 'Voice campaign', goal: 'curiosity', channels: ['instagram', 'linkedin'] };
    const first = await execute(input, { toolCallId: 'transient_call_one', messages: [], context: undefined });
    const retry = await execute(input, { toolCallId: 'transient_call_two', messages: [], context: undefined });
    expect(first).toMatchObject({ ok: true, data: { receipt: { kind: 'campaign.create' } } });
    expect(retry).toEqual(first);
    const { listCampaigns } = await import('../../src/bob-apps/marketing-store.ts');
    expect((await listCampaigns(memory.db, memory.userId, installationId, null)).items).toHaveLength(1);
  });

  it('uses the one active app after an expired selection, but never a paused or absent app', async () => {
    const { memory, installationId } = await fixture();
    const { withUser } = await import('../../src/platform/db/db.ts');
    await withUser(memory.db, memory.userId, tx => tx.query('update bob.bob_app_selection set expires_at=now()-interval \'1 second\' where user_id=$1', [memory.userId]));
    expect(Object.keys(await marketingTurnTools(memory))).toContain('save_draft');
    const { changeMarketingLifecycle } = await import('../../src/bob-apps/marketing-install.ts');
    await changeMarketingLifecycle(memory.db, memory.userId, installationId, { operation: 'pause', expectedRevision: 2, mutationId: randomUUID() });
    expect(await marketingTurnTools(memory)).toEqual({});
  });

  it('denies a fabricated anchor, another owner and a conversation archived after preparation', async () => {
    const { memory } = await fixture();
    if (!memory.prepared || !memory.conversation) throw new Error('Expected prepared scope');
    expect(await marketingTurnTools({ ...memory, prepared: { ...memory.prepared, userMessageId: 'transient_turn_ref' } })).toEqual({});
    const other = await support.addAccount(pg);
    expect(await marketingTurnTools({ ...memory, userId: other.userId })).toEqual({});
    const { withUser } = await import('../../src/platform/db/db.ts');
    await withUser(memory.db, memory.userId, tx => tx.query('update bob.conversations set archived_at=now() where id=$1', [memory.prepared?.conversationId]));
    expect(await marketingTurnTools(memory)).toEqual({});
  });

  it('omits Marketing for missing, pair, group, archived and mismatched prepared scopes', async () => {
    const { memory } = await fixture();
    if (!memory.prepared || !memory.conversation) throw new Error('Expected prepared scope');
    expect(await marketingTurnTools({ ...memory, conversation: null })).toEqual({});
    for (const spaceKind of ['pair', 'group'] as const) expect(await marketingTurnTools({ ...memory, conversation: { ...memory.conversation, spaceKind } })).toEqual({});
    expect(await marketingTurnTools({ ...memory, conversation: { ...memory.conversation, spaceArchived: true } })).toEqual({});
    expect(await marketingTurnTools({ ...memory, prepared: { ...memory.prepared, conversationId: 'conv_other_scope' } })).toEqual({});
  });
});

describe('abort: abortable and delay', () => {
  it('abortable settles with the promise, or rejects with TurnCancelledError once the signal aborts', async () => {
    await expect(abortable(Promise.resolve(7))).resolves.toBe(7);
    const controller = new AbortController();
    const pending = abortable(new Promise<number>(() => undefined), controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(TurnCancelledError);
    await expect(abortable(Promise.resolve(1), controller.signal)).rejects.toBeInstanceOf(TurnCancelledError);
  });

  it('delay returns early, never rejecting, when the signal aborts', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const waiting = delay(5_000, controller.signal);
    controller.abort();
    await waiting;
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('status: sendStatus', () => {
  it('sends a status control message for the turn', () => {
    const socket = fakeSocket();
    sendStatus(asWs(socket), createSession(), 'thinking', 'turn_1');
    expect(controls(socket)).toMatchObject([{ type: 'status', payload: { stage: 'thinking' } }]);
  });
});

describe('pacing: streamFrames', () => {
  const frames = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')];

  it('sends every frame in order and records the count on the session', async () => {
    const socket = fakeSocket();
    const session = createSession();
    const sent = await streamFrames(asWs(socket), session, frames, 0, null, undefined, undefined, newPacerState());
    expect(sent).toBe(3);
    expect(socket.send.mock.calls.map(([frame]) => String(frame))).toEqual(['a', 'b', 'c']);
    expect(session.downFramesSent).toBe(3);
  });

  it('stops at the next frame boundary on abort and when the socket is gone', async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(await streamFrames(asWs(fakeSocket()), createSession(), frames, 0, null, aborted.signal)).toBe(0);
    const closed = fakeSocket();
    closed.readyState = 3;
    expect(await streamFrames(asWs(closed), createSession(), frames, 0)).toBe(0);
    expect(closed.send).not.toHaveBeenCalled();
  });

  describe('PCM at real time for the device ring (#674)', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
    afterEach(() => { vi.useRealTimers(); });

    it('sends a 20 s reply at ~32000 B/s; the device ring never overflows 48 KB nor runs dry once playing', async () => {
      const payload = 320;
      const pcmFrames = Array.from({ length: 2000 }, () => Buffer.alloc(AUDIO_HEADER_BYTES + payload));
      const sentAt: number[] = [];
      const socket = fakeSocket();
      socket.send.mockImplementation(() => { sentAt.push(Date.now()); });
      const streaming = streamFrames(
        asWs(socket), createSession(), pcmFrames, 20, PCM_DRAIN_BYTES_PER_SECOND, undefined, undefined, newPacerState(PCM_PACING),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await streaming).toBe(2000);

      // The device: stores payload only, starts at its 16 KB prebuffer, then
      // plays 32 B per ms without pause.
      const start = sentAt[0]!;
      let ring = 0;
      let playingSince: number | null = null;
      let last = start;
      let peak = 0;
      let dryMs = 0;
      for (const at of sentAt) {
        if (playingSince !== null) {
          const due = ((at - last) * PCM_DRAIN_BYTES_PER_SECOND) / 1000;
          if (due > ring) dryMs += (due - ring) / 32;
          ring = Math.max(0, ring - due);
        }
        last = at;
        ring += payload;
        peak = Math.max(peak, ring);
        if (playingSince === null && ring >= PCM_PACING.drainStartBytes) playingSince = at;
      }
      expect(peak).toBeLessThanOrEqual(DEVICE_RING_BYTES);
      expect(peak).toBeGreaterThan(DEVICE_RING_BYTES / 2); // it does build a cushion
      expect(dryMs).toBe(0);
      // First audio within ~0.5 s: the prime goes out at the 8 ms floor.
      expect(playingSince! - start).toBeLessThan(600);
      // Steady state (5 s to 15 s after start): real time, within 2%.
      const inWindow = sentAt.filter((at) => at >= start + 5_000 && at < start + 15_000).length;
      expect((inWindow * payload) / 10).toBeGreaterThan(PCM_DRAIN_BYTES_PER_SECOND * 0.98);
      expect((inWindow * payload) / 10).toBeLessThan(PCM_DRAIN_BYTES_PER_SECOND * 1.02);
      // Never faster than one frame per 8 ms: the device queues at most 24 frames.
      for (let i = 1; i < sentAt.length; i += 1) expect(sentAt[i]! - sentAt[i - 1]!).toBeGreaterThanOrEqual(PCM_PACING.minFrameGapMs);
    });
  });
});

describe('transcribe: transcribeTurn', () => {
  it('returns the transcript, and null for a blank one; journals started and completed', async () => {
    const stt = vi.fn().mockResolvedValueOnce({ text: 'set a timer', model: 'stt-1', seconds: 2 }).mockResolvedValueOnce({ text: '   ' });
    const deps = fakeDeps({ stt });
    expect(await transcribeTurn(deps, createSession(), Buffer.alloc(32), 'turn_1')).toBe('set a timer');
    expect(await transcribeTurn(deps, createSession(), Buffer.alloc(32), 'turn_2')).toBeNull();
    expect(events().filter((e) => e === 'v2.turn_stage_stt_started')).toHaveLength(2);
    expect(events().filter((e) => e === 'v2.turn_stage_stt_completed')).toHaveLength(2);
    expect(JSON.stringify(journalLines)).not.toContain('set a timer');
    expect(traceSpan).toHaveBeenCalledWith('device-stt', expect.objectContaining({ turnId: 'turn_1' }), expect.any(Function));
    expect(JSON.stringify(vi.mocked(traceSpan).mock.calls.map((call) => call[1]))).not.toContain('set a timer');
  });

  it('rejects with TurnCancelledError when the turn is cancelled during STT', async () => {
    const controller = new AbortController();
    const deps = fakeDeps({ stt: () => new Promise(() => undefined) });
    const pending = transcribeTurn(deps, createSession(), Buffer.alloc(32), 'turn_1', controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(TurnCancelledError);
  });
});

describe('context: history, embedder adapter, turn memory', () => {
  it('buildAgentMessages uses the in-memory history with no conversation, and falls back when the store fails', async () => {
    const session = createSession();
    session.messages = [{ role: 'user', content: 'earlier' }];
    expect(await buildAgentMessages(fakeDeps(), session, 'now')).toEqual([
      { role: 'user', content: 'earlier' },
      { role: 'user', content: 'now' },
    ]);
    const paired = createSession({ kind: 'legacy', userId: 'u1' } as never) as DeviceSession;
    paired.activeConversationId = 'cnv_1';
    paired.messages = [{ role: 'assistant', content: 'kept' }];
    const deps = fakeDeps({ getDb: () => Promise.reject(new Error('store down')) });
    expect(await buildAgentMessages(deps, paired, 'now')).toEqual([
      { role: 'assistant', content: 'kept' },
      { role: 'user', content: 'now' },
    ]);
  });

  it('memoryEmbedderDep adapts the embedder to { values, model, dim }, resolving it at call time', async () => {
    const embedder = { embed: vi.fn().mockResolvedValue([0.1, 0.2]), modelId: 'emb-1', dim: 2 };
    const embedderFactory = vi.fn(() => embedder);
    const embed = memoryEmbedderDep(fakeDeps({ embedder: embedderFactory as never }));
    expect(embedderFactory).not.toHaveBeenCalled();
    expect(await embed('hello')).toEqual({ values: [0.1, 0.2], model: 'emb-1', dim: 2 });
    expect(embedderFactory).toHaveBeenCalledTimes(1);
  });

  it('resolveTurnMemory is null for an unpaired turn (the store is never touched) and for an unreachable store', async () => {
    expect(await resolveTurnMemory(fakeDeps(), createSession())).toEqual({ memory: null });
    const paired = createSession({ kind: 'legacy', userId: 'u1' } as never);
    const result = await resolveTurnMemory(fakeDeps({ getDb: () => Promise.reject(new Error('down')) }), paired);
    expect(result.memory).toBeNull();
    expect(typeof result.contextMs).toBe('number');
  });
});

describe('playback: streamPlayback', () => {
  it('speaks a PCM reply: playback_start, audio frames, playback_end, and reports the counts', async () => {
    const socket = fakeSocket();
    const session = createSession();
    session.formatId = PCM16_16K_MONO_FORMAT;
    const ttsPcm = vi.fn().mockResolvedValue({ pcm: Buffer.alloc(640), sourceRateHz: 16_000 });
    const result = await streamPlayback(fakeDeps({ ttsPcm }), asWs(socket), session, 'hello there', 'turn_1', Date.now());
    expect(ttsPcm).toHaveBeenCalledWith('hello there', BOB_TTS_VOICE);
    expect(traceSpan).toHaveBeenCalledWith('device-tts', expect.objectContaining({ turnId: 'turn_1' }), expect.any(Function));
    expect(controls(socket).map((m) => m.type)).toEqual(['status', 'playback_start', 'playback_end', 'status']);
    expect(binaryFrames(socket)).toBe(result.downFrames);
    expect(result.downFrames).toBeGreaterThan(0);
    expect(result.replyBytes).toBe(640);
    expect(result.firstAudioAt).not.toBeNull();
    expect(events()).toContain('v2.downlink_started');
  });

  it('uses the MP3 synthesizer for an MP3 session and rejects with TurnCancelledError on cancel', async () => {
    const session = createSession();
    session.formatId = MP3_16K_MONO_FORMAT;
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(2_048) });
    const socket = fakeSocket();
    const result = await streamPlayback(fakeDeps({ ttsMp3 }), asWs(socket), session, 'hi', 'turn_1', Date.now());
    expect(ttsMp3).toHaveBeenCalledWith('hi', BOB_TTS_VOICE);
    expect(result.replyBytes).toBe(2_048);
    const controller = new AbortController();
    const pending = streamPlayback(fakeDeps({ ttsMp3: () => new Promise(() => undefined) }), asWs(fakeSocket()), session, 'hi', 'turn_2', Date.now(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(TurnCancelledError);
  });
});

describe('persist: persistTurn', () => {
  it('does nothing for an unpaired session, and journals (never throws) when the store fails', async () => {
    const getDb = vi.fn(() => Promise.reject(new Error('store down')));
    await persistTurn(fakeDeps({ getDb }), createSession(), 'turn_1', 'hi', 'hello', null);
    expect(getDb).not.toHaveBeenCalled();
    const paired = createSession({ kind: 'legacy', userId: 'u1' } as never);
    await expect(persistTurn(fakeDeps({ getDb }), paired, 'turn_1', 'hi', 'hello', null)).resolves.toBeUndefined();
    expect(getDb).toHaveBeenCalledTimes(1);
    expect(events()).toContain('v2.turn_persist_failed');
    expect(JSON.stringify(journalLines)).not.toContain('hello');
  });
});

describe('failure: failTurn', () => {
  it('journals the stage and the turn failure and sends INTERNAL to the device', () => {
    const socket = fakeSocket();
    failTurn(asWs(socket), createSession(), 'turn_1', 'tts', new Error('boom'), Date.now() - 5);
    expect(events()).toEqual(expect.arrayContaining(['v2.turn_stage_tts_failed', 'v2.turn_failed']));
    expect(controls(socket)).toMatchObject([{ type: 'error', payload: { code: 'INTERNAL' } }]);
    expect(JSON.stringify(journalLines)).not.toContain('boom');
  });

  it('journals only, without an error to the device, when audio already played', () => {
    const socket = fakeSocket();
    failTurn(asWs(socket), createSession(), 'turn_1', 'agent', new Error('late'), Date.now(), false);
    expect(events()).toContain('v2.turn_failed');
    expect(socket.send).not.toHaveBeenCalled();
  });
});

describe('announce: runAnnouncement', () => {
  const announcement = { announce_id: 'a1', kind: 'reminder', speech: 'Your timer is done' } as never;

  it('ignores a PCM session and a busy session', async () => {
    const ttsMp3 = vi.fn();
    const pcm = createSession();
    pcm.stage = 'ready';
    await runAnnouncement(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), pcm, announcement);
    const busy = createSession();
    busy.formatId = MP3_16K_MONO_FORMAT;
    busy.stage = 'responding';
    await runAnnouncement(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), busy, announcement);
    expect(ttsMp3).not.toHaveBeenCalled();
  });

  it('plays an MP3 announcement between playback_start and playback_end and journals the outcome without the speech', async () => {
    const session = createSession();
    session.formatId = MP3_16K_MONO_FORMAT;
    session.stage = 'ready';
    const socket = fakeSocket();
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(1_024) });
    await runAnnouncement(fakeDeps({ ttsMp3 }), asWs(socket), session, announcement);
    expect(controls(socket).map((m) => m.type)).toEqual(['playback_start', 'playback_end']);
    expect(journalLines.find((l) => l.event === 'v2.announce_played')).toMatchObject({ outcome: 'played', mp3_bytes: 1_024 });
    expect(JSON.stringify(journalLines)).not.toContain('timer is done');
    expect(session.stage).toBe('ready');
  });
});

describe('assistant voice: a Bob session speaks in en-US-Sage, anything else in the default voice', () => {
  const mp3Session = (name?: 'Bob'): DeviceSession => {
    const session = createSession();
    session.formatId = MP3_16K_MONO_FORMAT;
    session.stage = 'ready';
    session.assistantName = name;
    return session;
  };
  const voices = (fn: ReturnType<typeof vi.fn>): unknown[] => fn.mock.calls.map((call) => call[1]);

  it('batch MP3 and batch PCM replies use the session name\'s voice', async () => {
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(1_024) });
    for (const name of ['Bob', undefined] as const) {
      await streamPlayback(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), mp3Session(name), 'hi', 'turn_1', Date.now());
    }
    expect(voices(ttsMp3)).toEqual([ttsVoiceFor('Bob'), BOB_TTS_VOICE]);
    const ttsPcm = vi.fn().mockResolvedValue({ pcm: Buffer.alloc(640), sourceRateHz: 16_000 });
    const pcmBob = mp3Session('Bob');
    pcmBob.formatId = PCM16_16K_MONO_FORMAT;
    await streamPlayback(fakeDeps({ ttsPcm }), asWs(fakeSocket()), pcmBob, 'hi', 'turn_1', Date.now());
    expect(voices(ttsPcm)).toEqual([ttsVoiceFor('Bob')]);
  });

  it('every streamed sentence of a Bob reply uses en-US-Sage', async () => {
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(1_024) });
    const playback = createSentencePlayback(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), mp3Session('Bob'), 'turn_1', Date.now());
    playback.push('First one. Second one. ');
    await playback.finish();
    expect(voices(ttsMp3)).toEqual([ttsVoiceFor('Bob'), ttsVoiceFor('Bob')]);
  });

  it('an announcement to a Bob session uses en-US-Sage, to an unnamed session the default voice', async () => {
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(1_024) });
    const announcement = { announce_id: 'a1', kind: 'reminder', speech: 'Your timer is done' } as never;
    await runAnnouncement(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), mp3Session('Bob'), announcement);
    await runAnnouncement(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), mp3Session(), announcement);
    expect(voices(ttsMp3)).toEqual([ttsVoiceFor('Bob'), BOB_TTS_VOICE]);
  });
});

describe('characterization: web and thread tool order stays byte-identical (spec 015 U1)', () => {
  type Support = typeof import('../support/test-db.ts');
  let support: Support;
  let pg: Awaited<ReturnType<Support['createTestDb']>>;
  beforeAll(async () => { support = await import('../support/test-db.ts'); pg = await support.createTestDb(); });
  afterAll(async () => { if (pg) await support.closeTestDb(pg); });

  /** Capability keys, then the real agent's offered keys, so the app group's position shows before the delegate folds it. */
  async function recorder(): Promise<{ keys: string[][]; build: (options: Parameters<typeof import('@bob/ai')['createBobAgent']>[0]) => unknown }> {
    const { createBobAgent } = await import('@bob/ai');
    const keys: string[][] = [];
    return { keys, build: (options) => {
      const agent = createBobAgent(options);
      keys.push([...Object.keys(options?.capabilityTools ?? {}), '|', ...Object.keys(agent.tools)]);
      return agent;
    } };
  }

  it('a web marketing turn on the selected app keeps this order', async () => {
    const { installMarketingPackage, changeMarketingLifecycle, selectMarketingInstallation } = await import('../../src/bob-apps/marketing-install.ts');
    const { createConversation } = await import('../../src/conversations/store.ts');
    const { withUser } = await import('../../src/platform/db/db.ts');
    const { runWebChatTurn } = await import('../../src/workflows/workflow-web-chat-turn.ts');
    const { webChatRequestSchema } = await import('../../src/conversations/schemas.ts');
    const { createAgentHarness } = await import('../support/agent-harness.ts');
    const db = support.asDb(pg), owner = await support.addAccount(pg);
    const installed = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, owner.sessionId);
    await changeMarketingLifecycle(db, owner.userId, installed.id, { operation: 'activate', expectedRevision: installed.revision, mutationId: randomUUID() });
    await selectMarketingInstallation(db, owner.userId, { installationId: installed.id, mutationId: randomUUID() }, owner.sessionId);
    const conversation = await withUser(db, owner.userId, tx => createConversation(tx, owner.userId, 'Web characterization'));
    const { keys, build } = await recorder();
    const agent = { kind: 'scripted', base: () => createAgentHarness([[{ type: 'text', text: 'Hi.' }]]).agent, create: build, createInvocation: build,
      withOfferedTools: () => createAgentHarness([[{ type: 'text', text: 'Hi.' }]]).agent };
    const deps = { appTurnTools: createAppTurnExtension(saveAppIdea), getDb: async () => db, agent, deviceSessions: { forAccount: () => [] }, timersChanged: async () => {}, embedder: () => ({ modelId: 'embed', dim: 3, embed: async () => [0, 0, 0], embedMany: async (texts: string[]) => texts.map(() => [0, 0, 0]) }), memoryWorker: null, recordTurnMetric: () => {} };
    const stop = new AbortController();
    const request = webChatRequestSchema.parse({ id: conversation.id, message: { id: `msg_${randomUUID()}`, role: 'user', parts: [{ type: 'text', text: 'Plan posts' }] } });
    let opened = false;
    const out = { json: () => {}, openStream: () => { opened = true; }, write: () => {}, end: () => {}, headersSent: () => opened, onDisconnect: () => {} };
    await runWebChatTurn(deps as never, { userId: owner.userId, request, timeZone: () => 'UTC', assistantName: () => 'Bob', cancellation: { turnId: `client-${randomUUID()}`, stop, bound: stop.signal, agentSignal: stop.signal } } as never, out as never,
      { boundHistoryAttachments: (messages: unknown) => messages, createFirstTextDetector: () => () => true } as never);
    expect(keys[0]).toEqual([
      'set_timer', 'set_alarm', 'list_timers', 'cancel_timer', 'list_tasks', 'create_task', 'complete_task', 'update_task', 'list_agenda', 'create_event', 'notify_email', 'list_timeline',
      'marketing_context', 'research_sources', 'list_capabilities', 'list_campaigns', 'read_campaign', 'select_campaign', 'list_drafts', 'read_draft', 'create_campaign', 'save_plan_section', 'save_draft', 'update_draft', 'save_week_plan',
      'start_game', 'list_games', '|',
      'currentDateTime', 'set_timer', 'set_alarm', 'list_timers', 'cancel_timer', 'list_tasks', 'create_task', 'complete_task', 'update_task', 'list_agenda', 'create_event', 'notify_email', 'list_timeline',
      'start_game', 'list_games', 'remember', 'forget', 'list_actions', 'complete_action', 'create_reminder', 'list_reminders', 'cancel_reminder', 'create_note', 'append_note', 'read_note', 'search', 'read_inbox',
      'apps_agent', 'productivity_agent', 'marketing_agent', 'health_agent',
    ]);
  });

  it('a thread turn bound to the group Marketing app keeps this order', async () => {
    const { installMarketingPackage, changeMarketingLifecycle } = await import('../../src/bob-apps/marketing-install.ts');
    const { createSpace, addMember } = await import('../../src/spaces/store.ts');
    const { openAppConversation } = await import('../../src/workflows/workflow-app-conversation.ts');
    const { postMessage } = await import('../../src/conversations/thread-store.ts');
    const { runInvocation } = await import('../../src/workflows/workflow-thread-invocation.ts');
    const { createAgentHarness } = await import('../support/agent-harness.ts');
    const db = support.asDb(pg), owner = await support.addAccount(pg), member = await support.addAccount(pg);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Bob team' });
    await addMember(db, owner.userId, space.id, member.userId, 'member');
    const draft = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', spaceId: space.id, mutationId: randomUUID() }, owner.sessionId);
    await changeMarketingLifecycle(db, owner.userId, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() });
    const conversation = await openAppConversation(db, member.userId, draft.appId);
    const { message } = await postMessage(db, member.userId, { threadId: conversation.conversationId, body: 'Plan our week', clientMessageId: randomUUID() });
    const { keys, build } = await recorder();
    const createAgent = (options?: Parameters<typeof build>[0]) => { build(options); return createAgentHarness([[{ type: 'text', text: 'Planned.' }]]).agent; };
    await runInvocation({ actorUserId: member.userId, spaceId: space.id, threadId: conversation.conversationId, triggerMessageId: message.id, contextHighWater: message.sequence,
      appBinding: { installationId: draft.id, mode: 'run', intent: 'posts' } }, { appTurnTools: createAppTurnExtension(saveAppIdea), db, createAgent: createAgent as never });
    expect(keys[0]).toEqual([
      'marketing_context', 'research_sources', 'list_capabilities', 'list_campaigns', 'read_campaign', 'select_campaign', 'list_drafts', 'read_draft', 'add_marketing_review_note',
      'create_campaign', 'save_plan_section', 'save_draft', 'update_draft', 'save_week_plan',
      'list_tasks', 'create_task', 'complete_task', 'update_task', 'list_agenda', 'create_event', 'list_space_members', '|',
      'currentDateTime', 'list_tasks', 'create_task', 'complete_task', 'update_task', 'list_agenda', 'create_event', 'list_space_members', 'marketing_agent',
    ]);
  });
});
