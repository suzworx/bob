// Device turn-lifecycle spans (LF-DEV-C): turn_start, turn_end and cancel
// open a milestone span carrying the device turn_ref as turnId, so the
// device-side lifecycle joins the agent trace and the journal lines.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

const spanCtl = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; attrs: unknown }>,
}));

vi.mock('@bob/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@bob/ai')>();
  return {
    ...original,
    traceSpan: vi.fn((name: string, attrs: unknown, fn: () => unknown) => {
      spanCtl.calls.push({ name, attrs });
      return fn();
    }),
  };
});

import { createAppDeps } from '../../src/app-deps.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import { V2_VERSION, type ClientControlDto } from '../../src/voice/protocol.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb } from '../../src/platform/db/db.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const appDeps = createAppDeps();
type Fake = { readyState: number; send: ReturnType<typeof vi.fn> };
let pg: TestDb;
let journal: string[];
let userId: string;

const control = (type: string, extra: Record<string, unknown> = {}): ClientControlDto =>
  ({ v: V2_VERSION, type, id: 'test_ctrl_000001', payload: {}, ...extra }) as unknown as ClientControlDto;

function pairedSession(): { socket: Fake; session: DeviceSession } {
  const socket: Fake = { readyState: 1, send: vi.fn() };
  const session = createSession({ kind: 'device', userId, deviceId: crypto.randomUUID(), name: 'Card' });
  Object.assign(session, { stage: 'ready' });
  return { socket, session };
}

function spanNames(): string[] {
  return spanCtl.calls.map((call) => call.name);
}

function spanAttrs(name: string): Record<string, unknown> {
  return (spanCtl.calls.find((c) => c.name === name)?.attrs ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  pg = await createTestDb();
  setSharedDb(Promise.resolve(asDb(pg)));
  ({ userId } = await addAccount(pg));
  journal = [];
  setJournalSink((line) => journal.push(line));
});

afterAll(async () => {
  setJournalSink(null);
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

describe('device turn-lifecycle spans', () => {
  beforeEach(() => {
    spanCtl.calls.length = 0;
  });

  it('turn_start opens a span carrying the device turn_ref', async () => {
    const { socket, session } = pairedSession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_span01' }), vi.fn());
    expect(session.stage).toBe('capturing');
    expect(spanNames()).toContain('device-turn-started');
    expect(spanAttrs('device-turn-started')).toMatchObject({ workflowNamespace: session.id, tags: ['device'], metadata: { turn_id: 'turn_span01' } });
    expect(journal.join('\n')).toContain('"event":"v2.turn_started"');
  });

  it('turn_end opens a span carrying the device turn_ref', async () => {
    const { socket, session } = pairedSession();
    Object.assign(session, { stage: 'capturing', turnRef: 'turn_span02', nextUplinkSeq: 1 });
    const onTurnEnd = vi.fn();
    await handleControl(
      appDeps,
      socket as unknown as WebSocket,
      session,
      control('turn_end', { turn_ref: 'turn_span02', seq: 0 }),
      onTurnEnd,
    );
    expect(session.stage).toBe('responding');
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(spanNames()).toContain('device-turn-ended');
    expect(spanAttrs('device-turn-ended')).toMatchObject({ workflowNamespace: session.id, tags: ['device'], metadata: { turn_id: 'turn_span02' } });
    expect(spanAttrs('turn-pipeline')).toMatchObject({ workflowNamespace: session.id, turnId: 'turn_span02' });
  });

  it('cancel opens a span and leaves the session ready', async () => {
    const { socket, session } = pairedSession();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('cancel'), vi.fn());
    expect(session.stage).toBe('ready');
    expect(spanNames()).toContain('device-turn-cancelled');
    expect(spanAttrs('device-turn-cancelled')).toMatchObject({ workflowNamespace: session.id, tags: ['device'] });
    expect(journal.join('\n')).toContain('"event":"v2.cancelled"');
  });
});
