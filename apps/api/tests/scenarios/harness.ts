// SCEN-LIVE harness: one device turn from a TEXT utterance, and the rows it
// saved. Imported dynamically by live.scenario.ts only when a key is set:
// test-db.ts warms the local Supabase template at import time.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { runTurn } from '../../src/workflows/workflow-voice-turn.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { withUserRaw, type TestDb } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
export interface Rows {
  reminders: Array<{ title: string; dueAt: number | null; dueZone: string | null }>;
  tasks: Array<{ title: string; dueAt: number | null; dueDate: string | null }>;
  memories: Array<{ kind: string; content: string }>;
  timers: Array<{ kind: string; label: string | null; firesAt: number }>;
}

export interface TurnOutcome {
  reply: string;
  calledTools: string;
  failed: boolean;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  memoryEvents: string[];
}

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** Sets the account zone where production reads it: auth user_metadata.time_zone
 *  (bob_private.account_time_zone). auth.* is admin-only, as in test-db.ts. */
export async function setAccountZone(pg: TestDb, userId: string, zone: string): Promise<void> {
  const url = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
  await withAdmin(url, async (sql) => {
    await sql`update auth.users
      set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('time_zone', ${zone}::text)
      where id = ${userId}`;
  });
}

/** Restores the Supabase platform grants the template lacks: pg-template.ts
 *  restores the base schemas with --no-privileges, so role authenticated has no
 *  USAGE on `extensions` or `auth`. Every `::extensions.vector` cast (the
 *  remember insert) and match_memories' auth.uid() then fail "permission
 *  denied for schema ..." and memory silently degrades. The local stack's own
 *  database (and production) grant exactly this; the run's database must too. */
export async function grantPlatformUsage(pg: TestDb): Promise<void> {
  const url = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
  await withAdmin(url, async (sql) => {
    await sql`grant usage on schema auth, extensions to anon, authenticated, service_role`;
  });
}

/** Every reminder, task, memory and timer the account can see (RLS-scoped). */
export async function readRows(pg: TestDb, userId: string): Promise<Rows> {
  return withUserRaw(pg, userId, async (tx) => {
    const q = async <T>(sql: string): Promise<T[]> => (await tx.query<T>(sql)).rows;
    const reminders = await q<Record<string, unknown>>(`select title, floor(extract(epoch from due_at) * 1000)::bigint as "dueAt",
      due_zone as "dueZone" from bob.reminders where kind = 'reminder' order by created_at`);
    const tasks = await q<Record<string, unknown>>(`select title, floor(extract(epoch from due_at) * 1000)::bigint as "dueAt",
      to_char(due_date, 'YYYY-MM-DD') as "dueDate" from bob.tasks order by created_at`);
    const memories = await q<Record<string, unknown>>(`select kind, content from bob.memories order by created_at`);
    const timers = await q<Record<string, unknown>>(`select kind, title as label, floor(extract(epoch from due_at) * 1000)::bigint as "firesAt"
      from bob.reminders where kind <> 'reminder' order by created_at`);
    return {
      reminders: reminders.map((r) => ({ title: String(r.title), dueAt: num(r.dueAt), dueZone: r.dueZone === null ? null : String(r.dueZone) })),
      tasks: tasks.map((t) => ({ title: String(t.title), dueAt: num(t.dueAt), dueDate: t.dueDate === null ? null : String(t.dueDate) })),
      memories: memories.map((m) => ({ kind: String(m.kind), content: String(m.content) })),
      timers: timers.map((t) => ({ kind: String(t.kind), label: t.label === null ? null : String(t.label), firesAt: Number(t.firesAt) })),
    };
  });
}

/** A device session for one account, as server.ts builds it on pairing. */
export function newSession(userId: string): DeviceSession {
  return createSession({ kind: 'device', userId, deviceId: randomUUID(), name: 'Scenario' }) as DeviceSession;
}

/** Runs runTurn with `text` as the transcript (the caller's STT mock
 *  returns it via `setText`) and reads the reply and the agent journal. */
export async function runTextTurn(session: DeviceSession, text: string, setText: (t: string) => void): Promise<TurnOutcome> {
  const turnRef = `turn_scen${randomUUID().slice(0, 8)}`;
  const lines: string[] = [];
  const sent: unknown[] = [];
  const socket = { readyState: 1, bufferedAmount: 0, send: (data: unknown) => sent.push(data) };
  setText(text);
  Object.assign(session, { stage: 'responding', turnRef, audioChunks: [Buffer.alloc(32_000)] });
  setJournalSink((line) => lines.push(line));
  try {
    await runTurn(appDeps.turn, socket as unknown as WebSocket, session, turnRef);
  } finally {
    setJournalSink(null);
  }
  const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const agent = events.find((e) => e.event === 'v2.turn_stage_agent_completed') ?? {};
  const replyDto = sent
    .filter((d): d is string => typeof d === 'string')
    .map((d) => JSON.parse(d) as { type: string; payload?: { reply?: string } })
    .find((d) => d.type === 'reply_text');
  return {
    reply: replyDto?.payload?.reply ?? '',
    calledTools: typeof agent.called_tools === 'string' ? agent.called_tools : '',
    failed: events.some((e) => e.event === 'v2.turn_failed'),
    ...(typeof agent.model === 'string' ? { model: agent.model } : {}),
    inputTokens: Number(agent.input_tokens ?? 0),
    outputTokens: Number(agent.output_tokens ?? 0),
    // Memory journal events (names and reasons only): tells a store fault in
    // the harness apart from a model that never tried to save.
    memoryEvents: events
      .filter((e) => typeof e.event === 'string' && e.event.startsWith('v2.memory_'))
      .map((e) => `${String(e.event).slice('v2.memory_'.length)}${typeof e.reason === 'string' ? `:${e.reason}` : ''}`),
  };
}

export interface ScenarioResult {
  scenario: string; model: string; repeat: number; zone: string; pass: boolean; why: string;
  called_tools: string; reply: string; rows: Rows; input_tokens: number; output_tokens: number;
  memory_events: string[];
}

/** Writes data/scenarios/<model>-<timestamp>.json (data/ is git-ignored). */
export function writeResults(model: string, results: ScenarioResult[]): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = resolve(root, 'data', 'scenarios', `${model.replace(/[^A-Za-z0-9._-]/g, '_')}-${stamp}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ model, results }, null, 2)}\n`);
  return file;
}
