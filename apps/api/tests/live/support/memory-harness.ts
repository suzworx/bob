/**
 * The live memory suite's harness (#758): the production web chat route and
 * device turn, with the real agent, the real extraction worker (built by the
 * memories module exactly as server.ts builds it) and the real embedder, on a
 * per-file database on the local Supabase stack. Only speech is stubbed (the
 * device turn hears `text`; see stubSpeech) -- the suite is about memory.
 *
 * The test file must vi.mock `src/voice/audio/stt-tts.ts` as
 * paired-turn-invariants.test.ts does. Evidence printed on failure carries
 * ids, enums and counts only, never memory content.
 */
import type { WebSocket } from 'ws';
import type { WebSocketExpress } from 'websocket-express';
import { createAppDeps, type AppDeps } from '../../../src/app-deps.ts';
import { apiModules } from '../../../src/api-modules.ts';
import { webChat } from '../../../src/conversations/chat-http.ts';
import { createConversation } from '../../../src/conversations/store.ts';
import { runTurn } from '../../../src/workflows/workflow-voice-turn.ts';
import { createSession } from '../../../src/voice/session-handlers.ts';
import { MP3_16K_MONO_FORMAT } from '../../../src/voice/protocol.ts';
import { startMemoryRetrieval } from '../../../src/memory/retrieval.ts';
import { type MemoryExtractionWorker } from '../../../src/memory/extract.ts';
import { closeDb, setSharedDb, withUser, type Db } from '../../../src/platform/db/db.ts';
import { setJournalSink } from '../../../src/platform/logger.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../../support/test-db.ts';
import { stubSpeech } from '../../support/paired-turn.ts';

export type JournalEvent = { event: string } & Record<string, unknown>;
export interface MemoryRow { id: string; kind: string; content: string; superseded_by: string | null; surface: string | null }
export interface LiveStore { pg: TestDb; db: Db; deps: AppDeps; worker: MemoryExtractionWorker; events: JournalEvent[] }

export async function openLiveStore(): Promise<LiveStore> {
  const pg = await createTestDb();
  const db = asDb(pg);
  setSharedDb(Promise.resolve(db));
  const deps = createAppDeps();
  // The memories module builds the extraction worker (real extractor + embedder) as server.ts does.
  const app = { use: (): void => undefined, post: (): void => undefined } as unknown as WebSocketExpress;
  apiModules.find((module) => module.name === 'memories')?.mount?.(app, deps);
  if (deps.memoryWorker === undefined) throw new Error('live memory: the memories module built no extraction worker');
  const events: JournalEvent[] = [];
  setJournalSink((line) => events.push(JSON.parse(line) as JournalEvent));
  return { pg, db, deps, worker: deps.memoryWorker, events };
}

export async function closeLiveStore(store: LiveStore): Promise<void> {
  setJournalSink(null);
  await store.worker.stop().catch(() => undefined);
  await closeDb().catch(() => undefined);
  await closeTestDb(store.pg).catch(() => undefined);
}

export async function newAccount(store: LiveStore): Promise<string> {
  return (await addAccount(store.pg)).userId;
}

async function waitFor(store: LiveStore, from: number, event: string): Promise<JournalEvent> {
  for (let waited = 0; waited < 15_000; waited += 50) {
    const hit = store.events.slice(from).find((entry) => entry.event === event);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`live memory: no ${event} after the turn`);
}

/** One web chat turn through POST /api/chat's handler; returns the conversation id. Extraction runs to idle. */
export async function webTurn(store: LiveStore, userId: string, text: string, conversationId?: string): Promise<string> {
  const from = store.events.length;
  const response = {
    statusCode: 200, headersSent: false, writableEnded: false,
    status(code: number) { this.statusCode = code; return this; },
    setHeader: (): void => undefined, write: (): void => undefined, json: (): void => undefined,
    end() { this.writableEnded = true; }, on() { return this; },
  };
  await webChat(store.deps)({
    body: { ...(conversationId ? { id: conversationId } : {}), message: { id: `u-${crypto.randomUUID()}`, role: 'user', parts: [{ type: 'text', text }] } },
    on: (): void => undefined,
    account: { userId, sessionId: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 3600 },
  } as never, response as never);
  if (response.statusCode !== 200) throw new Error(`live memory: web turn answered ${response.statusCode}`);
  const persisted = await waitFor(store, from, 'v2.messages_persisted');
  await store.worker.idle();
  return String(persisted.id);
}

/** One device turn through the real runTurn (speech stubbed to hear `text`); returns the conversation id. */
export async function deviceTurn(store: LiveStore, userId: string, text: string, conversationId?: string): Promise<string> {
  const id = conversationId ?? (await createConversation(store.db, userId, 'Live device turn')).id;
  stubSpeech(text);
  const session = createSession({ kind: 'device', userId, deviceId: 'dev_live', name: 'cardputer' });
  Object.assign(session, {
    stage: 'responding', turnRef: 'turn_live', formatId: MP3_16K_MONO_FORMAT,
    activeConversationId: id, audioChunks: [Buffer.alloc(32_000)], turnAbort: new AbortController(),
  });
  const socket = { readyState: 1, bufferedAmount: 0, send: (): void => undefined };
  await runTurn(store.deps.turn, socket as unknown as WebSocket, session, 'turn_live', store.worker);
  await store.worker.idle();
  return id;
}

export async function currentRows(store: LiveStore, userId: string): Promise<MemoryRow[]> {
  return withUser(store.db, userId, (tx) => tx.query<MemoryRow>(
    `SELECT id, kind, content, superseded_by, surface FROM bob.memories
      WHERE user_id = $1 AND superseded_by IS NULL ORDER BY created_at`, [userId]));
}

const normalise = (text: string): string => text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The current rows whose normalised content carries every term. */
export function mentioning(rows: readonly MemoryRow[], ...terms: string[]): MemoryRow[] {
  return rows.filter((row) => terms.every((term) => normalise(row.content).includes(normalise(term))));
}

/** The ids the retrieval a turn runs returns for `query` (journal silenced). */
export async function retrievedIds(store: LiveStore, userId: string, query: string): Promise<string[]> {
  const { result } = startMemoryRetrieval(store.db, userId, query, { embedder: store.deps.embedder(), journal: () => undefined });
  return (await result).memories.map((memory) => memory.id);
}

const FIELDS = ['memory_id', 'kind', 'outcome', 'op', 'path', 'guard', 'dup_of', 'target_id', 'reason', 'route', 'count',
  'ops_add', 'ops_update', 'ops_supersede', 'ops_noop', 'surface', 'conversation_id', 'message_id', 'degraded'];

/** Writer-path evidence: memory journal events and current rows, ids/enums/counts only. */
export function evidence(events: readonly JournalEvent[], rows: readonly MemoryRow[]): string {
  const memoryEvents = events.filter((entry) => entry.event.startsWith('v2.memory_'))
    .map((entry) => `  ${entry.event} ${JSON.stringify(Object.fromEntries(FIELDS.filter((key) => key in entry).map((key) => [key, entry[key]])))}`);
  const groups = new Map<string, number>();
  const rowLines = rows.map((row) => {
    const key = normalise(row.content);
    if (!groups.has(key)) groups.set(key, groups.size + 1);
    return `  row ${row.id} kind=${row.kind} surface=${row.surface ?? '-'} content_group=G${groups.get(key)}`;
  });
  return ['journal:', ...memoryEvents, 'current rows:', ...rowLines].join('\n');
}
