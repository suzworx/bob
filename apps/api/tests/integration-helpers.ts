/**
 * Integration harness (#551): boots the REAL server (createV2Server) on a free
 * loopback port on the per-file test database (tests/support/test-db.ts, the
 * local Supabase Postgres) with the AI stubbed, and gives each flow a web
 * token, a device URL and the journal. No network beyond 127.0.0.1, no model
 * keys: BOB_AI_STUB=1 stubs STT/agent/TTS, BOB_SYSTEM_TEST=1 adds the
 * loopback test-token issuer the web routes verify against.
 *
 * Env is set BEFORE any module that reads it loads (@bob/ai reads the stub
 * flag once at import): tests/integration-env.ts, a setupFiles entry, sets it
 * before a flow file's imports run (#735).
 */
import type { AddressInfo } from 'node:net';
import { SimDevice, type SimControlDto } from './helpers/sim-device.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from './support/test-db.ts';
import type { Db } from '../src/platform/db/db.ts';

import { DEVICE_SECRET } from './integration-env.ts';
export { DEVICE_SECRET, TRANSCRIPT } from './integration-env.ts';
export const MP3_FORMAT = 2;

export interface JournalEntry { event: string; [field: string]: unknown }

export interface IntegrationServer {
  baseUrl: string;
  wsUrl: string;
  pg: TestDb;
  db: Db;
  userId: string;
  token: string;
  journal: JournalEntry[];
  /** Fetches `path` on the server as the account, parsing the JSON body. */
  api: <T>(path: string, init?: RequestInit) => Promise<{ status: number; body: T }>;
  close: () => Promise<void>;
}

/** Waits until `predicate` holds, polling every 10 ms; rejects with `what` on timeout. */
export async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Journal entries named `event`, optionally only those from index `since` on. */
export function events(journal: JournalEntry[], event: string, since = 0): JournalEntry[] {
  return journal.slice(since).filter((entry) => entry.event === event);
}

/** A control envelope the way the firmware builds one. */
export function control(type: string, payload: Record<string, unknown> = {}, extra: { turn_ref?: string; seq?: number } = {}): SimControlDto {
  const id = `${type}_${Math.random().toString(36).slice(2, 14).padEnd(12, 'x')}`;
  return { v: 1, type, id, ...extra, payload };
}

/** Opens a legacy-secret device (acts as the account) and completes hello/welcome.
 *  #722: also waits out the welcome's timers_state read, which the server
 *  queues before the welcome reaches the socket, so a flow's next action is
 *  never raced by (or folded into) that read. */
export async function connectDevice(server: IntegrationServer): Promise<SimDevice> {
  const device = new SimDevice(server.wsUrl, { auth: DEVICE_SECRET });
  const opened = await device.open();
  if (!opened.connected) throw new Error(`device upgrade rejected with ${opened.status}`);
  device.sendControl(control('hello', { format_id: MP3_FORMAT }));
  await device.waitFor('welcome', 15_000);
  const { timersStateSettled } = await import('../src/voice/device-tools.ts');
  await timersStateSettled();
  return device;
}

export async function bootIntegrationServer(): Promise<IntegrationServer> {
  if (!(await import('@bob/ai')).AI_STUB_MODE) throw new Error('@bob/ai loaded before BOB_AI_STUB=1 was set: the integration server would call the real AI Gateway (#735). Set the stub env in tests/integration-env.ts (setupFiles), never after an import.');
  const { setJournalSink } = await import('../src/platform/logger.ts');
  const { closeDb, setSharedDb } = await import('../src/platform/db/db.ts');
  const { resolveDevAccount, DEV_ACCOUNT_ID } = await import('../src/account/dev-account.ts');
  const journal: JournalEntry[] = [];
  setJournalSink((line) => journal.push(JSON.parse(line) as JournalEntry));

  const pg = await createTestDb();
  const db = asDb(pg);
  await addAccount(pg, { id: DEV_ACCOUNT_ID });
  const userId = await resolveDevAccount(db);
  process.env.BOB_LEGACY_DEVICE_OWNER = userId;
  setSharedDb(Promise.resolve(db));

  const { createV2Server } = await import('../src/server.ts');
  const { server } = await createV2Server();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const issued = await fetch(`${baseUrl}/api/test-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (issued.status !== 200) throw new Error(`test-token answered ${issued.status}`);
  const token = ((await issued.json()) as { token: string }).token;

  const api = async <T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) };
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    const text = await response.text();
    return { status: response.status, body: (text === '' ? null : JSON.parse(text)) as T };
  };

  const close = async (): Promise<void> => {
    setJournalSink(null);
    server.closeAllConnections();
    // server.close() also drains the extraction worker before it calls back.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb().catch(() => undefined);
    await closeTestDb(pg).catch(() => undefined);
  };

  return { baseUrl, wsUrl: `ws://127.0.0.1:${port}/v2/cardputer`, pg, db, userId, token, journal, api, close };
}
