/**
 * TG-AGENT-HARNESS (test-gap class B): one device turn in the PRODUCTION
 * shape. A paired MP3 device session on a real store (per-file test DB), in
 * a stored conversation whose game scope comes from the real resolveGameScope
 * (none, paused or active), runs through the real runTurn. The per-turn
 * agent is the real-SDK harness agent over exactly the tools the turn built.
 * Only ids, types and counts are recorded, never text.
 *
 * The test file must vi.mock, as paired-turn-invariants.test.ts does:
 * `../src/voice/audio/stt-tts.ts` (STT/TTS), `@bob/ai`, `@bob/ai` with
 * createBobAgent -> pairedAgent, memoryAvailable -> true and
 * startMemoryRetrieval (no embedding provider). Everything else is real.
 */
import { vi } from 'vitest';
import type { ToolLoopAgent } from 'ai';
import type { WebSocket } from 'ws';
import { type CreateBobAgentOptions } from '@bob/ai/testing';
import { synthesizeMp3, transcribePcm } from '../../src/voice/audio/stt-tts.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { MP3_16K_MONO_FORMAT } from '../../src/voice/protocol.ts';
import { createSession, sessionUserId, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { countMessages, createConversation } from '../../src/conversations/store.ts';
import { setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { createGameSession, pauseGame } from '../../src/voice/games-store.ts';
import { createAgentHarness, type AgentHarness, type ScriptStep } from './agent-harness.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from './test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
export type GameMode = 'none' | 'paused' | 'active';

export interface PairedStore {
  pg: TestDb;
  db: Db;
}

/** One frame the device received: its DTO type (audio_down for binary), the
 *  audio sequence, an error DTO's code, and when (performance.now() ms). */
export interface WireFrame {
  type: string;
  at: number;
  seq?: number;
  code?: string;
}

export interface PairedTurnRun {
  frames: WireFrame[];
  /** Journal events of the turn (the journal holds ids and counts only). */
  events: Array<Record<string, unknown>>;
  /** Messages stored in the conversation after the turn. */
  messages: number;
  /** The harness the turn's agent ran on (null when no agent was built). */
  harness: AgentHarness | null;
}

/** The script and controller the next createBobAgent call builds on. */
const next: { steps: readonly ScriptStep[]; abort: AbortController; harness: AgentHarness | null } = {
  steps: [], abort: new AbortController(), harness: null,
};

/** createBobAgent's stand-in: the harness agent over the turn's own tools. */
export function pairedAgent(opts: CreateBobAgentOptions = {}): ToolLoopAgent {
  const tools = { ...opts.capabilityTools, ...opts.memoryTools, ...opts.lateTools };
  next.harness = createAgentHarness(next.steps, { tools, abort: next.abort });
  return next.harness.agent;
}

/** A per-file test DB as the process's shared store (what getDb returns). */
export async function openPairedStore(): Promise<PairedStore> {
  const pg = await createTestDb();
  const db = asDb(pg);
  setSharedDb(Promise.resolve(db));
  return { pg, db };
}

export async function closePairedStore(store: PairedStore): Promise<void> {
  await closeTestDb(store.pg).catch(() => undefined);
}

/** A new account's paired MP3 cardputer, mid-turn in a stored conversation whose game is `mode`. */
export async function pairedSession(store: PairedStore, mode: GameMode): Promise<DeviceSession> {
  const { userId } = await addAccount(store.pg);
  const { id: conversationId } = await createConversation(store.db, userId, 'Paired turn');
  if (mode !== 'none') {
    const game = await createGameSession(store.db, userId, {
      conversationId, game: 'animal_riddles', players: [{ name: 'Sam', band: 'grown' }], state: {},
    });
    if (mode === 'paused') await pauseGame(store.db, userId, game.id, game.version);
  }
  const session = createSession({ kind: 'device', userId, deviceId: 'dev_paired', name: 'cardputer' });
  Object.assign(session, {
    stage: 'responding', turnRef: 'turn_paired', formatId: MP3_16K_MONO_FORMAT,
    activeConversationId: conversationId, audioChunks: [Buffer.alloc(32_000)], turnAbort: new AbortController(),
  });
  return session;
}

/** STT hears `heard`; TTS returns a small MP3 per sentence after `ttsMs`. */
export function stubSpeech(heard: string, ttsMs = 10): void {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(((0x7ff << 21) | (3 << 19) | (1 << 17) | (1 << 16) | (5 << 12) | (3 << 6)) >>> 0, 0);
  vi.mocked(transcribePcm).mockResolvedValue({ text: heard, model: 'stt-1', seconds: 1 });
  vi.mocked(synthesizeMp3).mockImplementation(async (text: string) => {
    await new Promise((resolve) => setTimeout(resolve, ttsMs));
    return { mp3: Buffer.concat([header, Buffer.alloc(text.length * 40)]) };
  });
}

/** Runs one turn of `session` through the real runTurn on `steps`. */
export async function runPairedTurn(store: PairedStore, session: DeviceSession, steps: readonly ScriptStep[], googleTools?: typeof appDeps.googleTools): Promise<PairedTurnRun> {
  const { runTurn } = await import('../../src/workflows/workflow-voice-turn.ts');
  next.steps = steps;
  next.abort = session.turnAbort ?? new AbortController();
  next.harness = null;
  const frames: WireFrame[] = [];
  const lines: string[] = [];
  const socket: Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send'> = {
    readyState: 1,
    bufferedAmount: 0,
    send: (data: unknown): void => {
      const at = performance.now();
      if (Buffer.isBuffer(data)) frames.push({ type: 'audio_down', at, seq: data.readUInt32BE(12) });
      else {
        const dto = JSON.parse(String(data)) as { type: string; payload?: { code?: string } };
        frames.push({ type: dto.type, at, ...(dto.payload?.code === undefined ? {} : { code: dto.payload.code }) });
      }
    },
  };
  setJournalSink((line) => lines.push(line));
  try {
    await runTurn({ ...appDeps.turn, googleTools }, socket as WebSocket, session, 'turn_paired');
  } finally {
    setJournalSink(null);
  }
  const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const userId = sessionUserId(session);
  const conversationId = session.activeConversationId;
  if (userId === undefined || conversationId === undefined) throw new Error('paired turn: the session lost its account or conversation');
  const messages = await countMessages(store.db, userId, conversationId);
  return { frames, events, messages, harness: next.harness };
}
