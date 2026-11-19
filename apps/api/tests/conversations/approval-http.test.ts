// Ask Bob proposals over the REAL mounted server (#1191): create, read, approve and decline,
// owner-only, with the JWT guard in front. Every assertion is on the HTTP response.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createV2Server } from '../../src/server.ts';
import { closeDb, setSharedDb, withUser, type Db } from '../../src/platform/db/db.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;
let owner: TestAccount;
let other: TestAccount;
let ownerToken: string;
let otherToken: string;

const proposal = () => ({
  title: 'Move your design review',
  steps: [
    { action: 'move_event', title: 'Move Design review', subline: 'From 11:00 AM to 2:00 PM', params: { event_id: 'evt-secret-1' } },
    { action: 'notify_people', title: 'Notify Work crew' },
  ],
  changes: [{ label: 'Design review', before: 'Was 11:00 AM', after: 'Today, 2:00 PM' }],
  notify: [{ name: 'Work crew', detail: '2 people' }],
  reminder: { label: 'Fires before the event', offset_minutes: 10 },
});

async function issueToken(userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/test-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

function send(method: string, path: string, token: string | null, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function create(token = ownerToken): Promise<{ id: string }> {
  const res = await send('POST', '/api/approvals', token, proposal());
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

beforeAll(async () => {
  process.env.BOB_SYSTEM_TEST = '1';
  process.env.BOB_V2_HOST = '127.0.0.1';
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
  owner = await addAccount(pg);
  other = await addAccount(pg);
  const created = await createV2Server();
  server = created.server;
  await new Promise<void>((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(created.server.address() as AddressInfo).port}`;
  ownerToken = await issueToken(owner.userId);
  otherToken = await issueToken(other.userId);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb(pg).catch(() => undefined);
  await closeDb().catch(() => undefined);
  delete process.env.BOB_SYSTEM_TEST;
  delete process.env.BOB_V2_HOST;
});

describe('approvals HTTP API', () => {
  it('creates a pending proposal and returns the card without the step params', async () => {
    const res = await send('POST', '/api/approvals', ownerToken, proposal());
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(body.decided_at).toBeNull();
    expect(body.steps).toEqual([
      { action: 'move_event', title: 'Move Design review', subline: 'From 11:00 AM to 2:00 PM' },
      { action: 'notify_people', title: 'Notify Work crew' },
    ]);
    expect(JSON.stringify(body)).not.toContain('evt-secret-1');
  });

  it('reads it back for its owner and answers 404 for anyone else', async () => {
    const { id } = await create();
    const read = await send('GET', `/api/approvals/${id}`, ownerToken);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { id: string }).id).toBe(id);
    expect((await send('GET', `/api/approvals/${id}`, otherToken)).status).toBe(404);
    expect((await send('GET', '/api/approvals/00000000-0000-4000-8000-000000000000', ownerToken)).status).toBe(404);
  });

  it('rejects an unknown action, an extra key and a malformed id with 400', async () => {
    const unknownAction = { ...proposal(), steps: [{ action: 'wire_money', title: 'Send money' }] };
    expect((await send('POST', '/api/approvals', ownerToken, unknownAction)).status).toBe(400);
    expect((await send('POST', '/api/approvals', ownerToken, { ...proposal(), extra: true })).status).toBe(400);
    expect((await send('GET', '/api/approvals/not-a-uuid', ownerToken)).status).toBe(400);
  });

  it('answers 401 without a signed-in account on every route', async () => {
    const { id } = await create();
    expect((await send('POST', '/api/approvals', null, proposal())).status).toBe(401);
    expect((await send('GET', `/api/approvals/${id}`, null)).status).toBe(401);
    expect((await send('POST', `/api/approvals/${id}/approve`, null)).status).toBe(401);
    expect((await send('POST', `/api/approvals/${id}/decline`, null)).status).toBe(401);
  });

  it('declines a proposal once; deciding again is a 409', async () => {
    const { id } = await create();
    const declined = await send('POST', `/api/approvals/${id}/decline`, ownerToken);
    expect(declined.status).toBe(200);
    expect(((await declined.json()) as { status: string }).status).toBe('declined');
    expect((await send('POST', `/api/approvals/${id}/decline`, ownerToken)).status).toBe(409);
    expect((await send('POST', `/api/approvals/${id}/approve`, ownerToken)).status).toBe(409);
  });

  it('refuses another account on approve and decline without changing the proposal', async () => {
    const { id } = await create();
    expect((await send('POST', `/api/approvals/${id}/approve`, otherToken)).status).toBe(404);
    expect((await send('POST', `/api/approvals/${id}/decline`, otherToken)).status).toBe(404);
    const read = await send('GET', `/api/approvals/${id}`, ownerToken);
    expect(((await read.json()) as { status: string }).status).toBe('pending');
  });

  it('records a failed outcome when approved before any step action is connected', async () => {
    const { id } = await create();
    const res = await send('POST', `/api/approvals/${id}/approve`, ownerToken);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('failed');
    const rows = await withUser(db, owner.userId, (tx) =>
      tx.query<{ action: string; outcome: string }>(
        `SELECT action, outcome FROM heybob.xyzroval_audit WHERE proposal_id = $1 ORDER BY created_at, id`,
        [id],
      ),
    );
    expect(rows).toEqual([
      { action: 'decision', outcome: 'approved' },
      { action: 'move_event', outcome: 'failed' },
    ]);
  });
});
