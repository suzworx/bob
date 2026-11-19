// web-invocations.ts route tests (014, S14-T009, contracts/api.md "Threads and
// messages"). A real HTTP server over the real Postgres test db with the real store. The `run`
// dependency is stubbed so no real model is called; the DB is real so trigger
// message resolution, the identity-leak rule and cancel authorisation are
// exercised against genuine store behaviour. Each state-changing route also has
// a failure-injection test.
import { createAppTurnExtension } from '../../src/bob-apps/app-turn-extension.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createThread, postMessage, postAssistantMessage } from '../../src/conversations/thread-store.ts';
import { claimInvocation } from '../../src/conversations/invocations-store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createInvocationsRouter } from '../../src/conversations/invocations-http.ts';
import { runInvocation, type InvocationResult } from '../../src/workflows/workflow-thread-invocation.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { journal } from '../../src/platform/logger.ts';
import { StoreConflictError, StoreNotFoundError } from '../../src/platform/db/db.ts';

vi.mock('../../src/platform/logger.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/platform/logger.ts')>()),
  ...(await import('../helpers/journal-mock.ts')).loggerMock(),
}));
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb,
} from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;

async function send(method: string, path: string, tok: string | null, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function tokenFor(account: TestAccount): Promise<string> {
  return signToken({ userId: account.userId, sessionId: account.sessionId });
}

describe('invocations HTTP API', () => {
  let owner: TestAccount;
  let member: TestAccount;
  let outsider: TestAccount;
  let ownerToken: string;
  let outsiderToken: string;
  let spaceId: string;
  let threadId: string;
  let triggerId: string;
  let run: ReturnType<typeof vi.fn>;
  const publish = vi.fn();

  /** A fresh thread with one assistant-addressed message (threads serialise one
   *  running invocation each, so each claim needs its own thread). */
  async function freshThreadTrigger(): Promise<{ threadId: string; triggerId: string }> {
    const thread = await createThread(db, owner.userId, { spaceId, title: 'Fresh' });
    const msg = await postMessage(db, owner.userId, {
      threadId: thread.id,
      body: '@bob do a thing',
      clientMessageId: randomUUID(),
    });
    return { threadId: thread.id, triggerId: msg.message.id };
  }

  /** Claims a running invocation in its own thread and returns its id. */
  async function claimInFreshThread(): Promise<string> {
    const { threadId: freshThread } = await freshThreadTrigger();
    const claim = await claimInvocation(db, owner.userId, {
      spaceId,
      threadId: freshThread,
      triggerMessageId: randomUUID(),
      contextHighWater: 1,
      membershipRevision: 1,
    });
    return claim.invocation.id;
  }

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    owner = await addAccount(pg);
    member = await addAccount(pg);
    outsider = await addAccount(pg);
    ownerToken = await tokenFor(owner);
    outsiderToken = await tokenFor(outsider);

    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
    spaceId = space.id;
    await addMember(db, owner.userId, space.id, member.userId, 'member');
    const thread = await createThread(db, owner.userId, { spaceId, title: 'Grocery' });
    threadId = thread.id;
    const msg = await postMessage(db, owner.userId, {
      threadId,
      body: '@bob add milk',
      clientMessageId: randomUUID(),
    });
    triggerId = msg.message.id;

    run = vi.fn();
    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use(
      '/api',
      createInvocationsRouter({ appTurnTools: createAppTurnExtension(saveAppIdea),
        getDb: () => Promise.resolve(db),
        run: run as unknown as typeof runInvocation,
        events: { publish },
      }),
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    await closeTestDb(pg).catch(() => undefined);
  });

  function completedResult(id: string, resultMessageId: string = randomUUID()): InvocationResult {
    return {
      claimed: true,
      invocation: {
        id,
        spaceId,
        threadId,
        actorUserId: owner.userId,
        triggerMessageId: triggerId,
        contextHighWater: 1,
        membershipRevision: 1,
        state: 'completed',
        resultMessageId,
        errorCode: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      outcome: 'completed',
      resultMessageId,
    };
  }

  it('POST dispatches and returns 202 with the invocation id', async () => {
    publish.mockClear();
    const invocationId = randomUUID();
    const reply = await postAssistantMessage(db, owner.userId, { threadId, spaceId }, invocationId, 'Shared reply');
    run.mockResolvedValue(completedResult(invocationId, reply.id));
    const res = await send('POST', `/api/threads/${threadId}/invocations`, ownerToken, {
      trigger_message_id: triggerId,
    });
    expect(res.status).toBe(202);
    expect((await res.json()) as { invocation_id: string }).toMatchObject({
      invocation_id: expect.any(String),
    });
    expect(publish.mock.calls.map(([userId]) => userId).sort()).toEqual([owner.userId, member.userId].sort());
    expect(publish).toHaveBeenCalledWith(member.userId, {
      type: 'thread.message_appended', thread_id: threadId, space_id: spaceId,
      message_id: reply.id, sequence: reply.sequence,
    });
  });

  it('POST returns 409 conflict when one is already running', async () => {
    run.mockResolvedValue({ claimed: false, reason: 'busy', invocation: null });
    const res = await send('POST', `/api/threads/${threadId}/invocations`, ownerToken, {
      trigger_message_id: triggerId,
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'conflict' },
    });
  });

  it.each([{}, { campaignId: null }, { campaignId: randomUUID() }])('POST preserves explicit app targeting %j', async (target) => {
    run.mockClear();
    run.mockResolvedValue({ claimed: false, reason: 'duplicate', invocation: completedResult(randomUUID()).invocation });
    const appBinding = { installationId: randomUUID(), mode: 'run', ...target };
    const res = await send('POST', `/api/threads/${threadId}/invocations`, ownerToken, {
      trigger_message_id: triggerId, appBinding,
    });
    expect(res.status).toBe(202);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ actorUserId: owner.userId, appBinding });
    expect(Object.hasOwn(run.mock.calls[0]?.[0].appBinding ?? {}, 'campaignId')).toBe(Object.hasOwn(target, 'campaignId'));
  });

  it('bound POST refuses another member’s trigger without dispatching', async () => {
    const message = await postMessage(db, member.userId, { threadId, body: 'A teammate message', clientMessageId: randomUUID() });
    run.mockClear();
    run.mockResolvedValue(completedResult(randomUUID()));
    const res = await send('POST', `/api/threads/${threadId}/invocations`, ownerToken, {
      trigger_message_id: message.message.id, appBinding: { installationId: randomUUID(), mode: 'run' },
    });
    expect(res.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it('POST maps changed binding conflicts to 409 without returning a saved invocation', async () => {
    run.mockRejectedValueOnce(new StoreConflictError('invocation binding changed'));
    const res = await send('POST', `/api/threads/${threadId}/invocations`, ownerToken, { trigger_message_id: triggerId });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'conflict' } });
  });

  it('rejects binding authority fields and refine-only intent confusion', async () => {
    run.mockClear();
    for (const appBinding of [
      { installationId: randomUUID(), mode: 'run', ownerId: owner.userId },
      { installationId: randomUUID(), mode: 'run', kind: 'marketing' },
      { installationId: randomUUID(), mode: 'refine', intent: 'posts' },
    ]) {
      expect((await send('POST', `/api/threads/${threadId}/invocations`, ownerToken, { trigger_message_id: triggerId, appBinding })).status).toBe(400);
    }
    expect(run).not.toHaveBeenCalled();
  });

  async function boundClaimInput(appBinding: { installationId: string; mode: 'run'; campaignId?: string | null }) {
    const fresh = await freshThreadTrigger();
    return { spaceId, threadId: fresh.threadId, triggerMessageId: fresh.triggerId, contextHighWater: 1, membershipRevision: 1, appBinding };
  }

  it.each([{}, { campaignId: null }, { campaignId: randomUUID() }])('persists normalized app targeting and reauthorizes identical retries %j', async (target) => {
    const input = await boundClaimInput({ installationId: randomUUID(), mode: 'run', ...target });
    const authorize = vi.fn(async () => undefined);
    const first = await claimInvocation(db, owner.userId, input, authorize);
    expect(first.invocation).toMatchObject({ appBinding: input.appBinding });
    const retry = await claimInvocation(db, owner.userId, input, authorize);
    expect(retry.claimed).toBe(false);
    expect(retry.invocation.id).toBe(first.invocation.id);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(Object.hasOwn(retry.invocation.appBinding ?? {}, 'campaignId')).toBe(Object.hasOwn(target, 'campaignId'));
  });

  it('requires bound claims to provide current transaction authorization', async () => {
    const input = await boundClaimInput({ installationId: randomUUID(), mode: 'run' });
    await expect(claimInvocation(db, owner.userId, input)).rejects.toThrow('authorization');
  });

  it('rejects a changed campaign target on the same actor and trigger', async () => {
    const input = await boundClaimInput({ installationId: randomUUID(), mode: 'run', campaignId: null });
    await claimInvocation(db, owner.userId, input, async () => undefined);
    await expect(claimInvocation(db, owner.userId, { ...input, appBinding: { ...input.appBinding, campaignId: randomUUID() } }, async () => undefined)).rejects.toBeInstanceOf(StoreConflictError);
  });

  it('distinguishes stored selection from explicit New on a retry', async () => {
    const input = await boundClaimInput({ installationId: randomUUID(), mode: 'run' });
    await claimInvocation(db, owner.userId, input, async () => undefined);
    await expect(claimInvocation(db, owner.userId, { ...input, appBinding: { ...input.appBinding, campaignId: null } }, async () => undefined)).rejects.toBeInstanceOf(StoreConflictError);
  });

  it('accepts identical binding data in a different property order', async () => {
    const input = await boundClaimInput({ installationId: randomUUID(), mode: 'run', campaignId: randomUUID() });
    const first = await claimInvocation(db, owner.userId, input, async () => undefined);
    const reordered = { campaignId: input.appBinding.campaignId, mode: input.appBinding.mode, installationId: input.appBinding.installationId };
    const retry = await claimInvocation(db, owner.userId, { ...input, appBinding: reordered }, async () => undefined);
    expect(retry.claimed).toBe(false);
    expect(retry.invocation.id).toBe(first.invocation.id);
  });

  it('refuses a formerly authorized duplicate before returning its saved row', async () => {
    const input = await boundClaimInput({ installationId: randomUUID(), mode: 'run' });
    await claimInvocation(db, owner.userId, input, async () => undefined);
    const denied = vi.fn(async () => { throw new StoreNotFoundError('app not found'); });
    await expect(claimInvocation(db, owner.userId, input, denied)).rejects.toBeInstanceOf(StoreNotFoundError);
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it('compares bindings after a concurrent claim without an aborted-transaction reread', async () => {
    const input = await boundClaimInput({ installationId: randomUUID(), mode: 'run', campaignId: null });
    const results = await Promise.allSettled([
      claimInvocation(db, owner.userId, input, async () => undefined),
      claimInvocation(db, owner.userId, { ...input, appBinding: { ...input.appBinding, campaignId: randomUUID() } }, async () => undefined),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure?.status === 'rejected' ? failure.reason : null).toBeInstanceOf(StoreConflictError);
  });

  it('POST returns 400 invalid_request for a Zod-rejected body', async () => {
    const res = await send('POST', `/api/threads/${threadId}/invocations`, ownerToken, {
      trigger_message_id: 'not-a-uuid',
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'invalid_request' },
    });
  });

  it('POST returns 404 when the trigger message is not in this thread', async () => {
    const other = await createThread(db, owner.userId, { spaceId, title: 'Other' });
    const otherMsg = await postMessage(db, owner.userId, {
      threadId: other.id,
      body: '@bob nope',
      clientMessageId: randomUUID(),
    });
    const res = await send('POST', `/api/threads/${threadId}/invocations`, ownerToken, {
      trigger_message_id: otherMsg.message.id,
    });
    expect(res.status).toBe(404);
  });

  it('GET returns the invocation state and result message id', async () => {
    const id = await claimInFreshThread();
    const res = await send('GET', `/api/invocations/${id}`, ownerToken);
    expect(res.status).toBe(200);
    expect(journal).toHaveBeenCalledWith('v2.invocation_read', expect.objectContaining({ invocation_id: id, turn_id: id }));
    expect((await res.json()) as { id: string; state: string }).toMatchObject({
      id,
      state: 'running',
    });
  });

  it('GET 404 for an id outside the audience equals a missing id', async () => {
    const id = await claimInFreshThread();
    const hidden = await send('GET', `/api/invocations/${id}`, outsiderToken);
    const missing = await send('GET', `/api/invocations/${randomUUID()}`, outsiderToken);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const a = (await hidden.json()) as { error: { code: string } };
    const b = (await missing.json()) as { error: { code: string } };
    expect(a).toEqual(b);
  });

  it('DELETE cancels the caller\u2019s own running invocation', async () => {
    const id = await claimInFreshThread();
    const res = await send('DELETE', `/api/invocations/${id}`, ownerToken);
    expect(res.status).toBe(200);
    expect(journal).toHaveBeenCalledWith('v2.invocation_cancelled', expect.objectContaining({ invocation_id: id, turn_id: id }));
    expect((await res.json()) as { id: string; state: string }).toMatchObject({
      id,
      state: 'cancelled',
    });
  });

  it('DELETE 404 for another actor\u2019s invocation (cancel is self-only)', async () => {
    const id = await claimInFreshThread();
    const res = await send('DELETE', `/api/invocations/${id}`, outsiderToken);
    expect(res.status).toBe(404);
  });

  it('401 without a token', async () => {
    const res = await send('POST', `/api/threads/${threadId}/invocations`, null, {
      trigger_message_id: triggerId,
    });
    expect(res.status).toBe(401);
  });

  it('failure-injection: POST from an outsider is 404 and never runs the agent', async () => {
    run.mockClear();
    const res = await send('POST', `/api/threads/${threadId}/invocations`, outsiderToken, {
      trigger_message_id: triggerId,
    });
    expect(res.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it('failure-injection: DELETE of a missing id is 404 and never touches a row', async () => {
    const res = await send('DELETE', `/api/invocations/${randomUUID()}`, ownerToken);
    expect(res.status).toBe(404);
  });

  // The account zone rides in the verified token's user_metadata. The shared
  // test signer cannot add claims, so this signs with its own key behind its
  // own guard -- the token is still verified before the route reads it.
  it('POST passes the account time zone from the verified token, UTC when absent', async () => {
    const issuer = 'https://zone.test/auth/v1';
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwks = createLocalJWKSet({ keys: [await exportJWK(publicKey)] });
    const sign = (claims: Record<string, unknown>): Promise<string> =>
      new SignJWT({ sub: owner.userId, session_id: owner.sessionId, role: 'authenticated', ...claims })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuedAt()
        .setIssuer(issuer)
        .setAudience('authenticated')
        .setExpirationTime('1h')
        .sign(privateKey);
    const zoneRun = vi.fn().mockResolvedValue(completedResult(randomUUID()));
    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks, issuer })));
    app.use('/api', createInvocationsRouter({ appTurnTools: createAppTurnExtension(saveAppIdea), getDb: () => Promise.resolve(db), run: zoneRun as unknown as typeof runInvocation }));
    const zoneServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const url = `http://127.0.0.1:${(zoneServer.address() as AddressInfo).port}`;
    const post = (tok: string): Promise<Response> =>
      fetch(`${url}/api/threads/${threadId}/invocations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify({ trigger_message_id: triggerId }),
      });
    try {
      expect((await post(await sign({ user_metadata: { time_zone: 'Asia/Kolkata' } }))).status).toBe(202);
      expect(zoneRun.mock.calls[0]![0]).toMatchObject({ timeZone: 'Asia/Kolkata' });
      expect((await post(await sign({}))).status).toBe(202);
      expect(zoneRun.mock.calls[1]![0]).toMatchObject({ timeZone: 'UTC' });
    } finally {
      zoneServer.close();
    }
  });
});
