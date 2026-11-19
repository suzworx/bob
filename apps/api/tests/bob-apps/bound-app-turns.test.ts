import { createAppTurnExtension } from '../../src/bob-apps/app-turn-extension.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { createBobAgent } from '@bob/ai';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createAppDeps } from '../../src/app-deps.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, isWebSessionActive } from '../../src/platform/http/auth-guard.ts';
import { createRealAgent } from '../../src/voice/agent-adapters.ts';
import { webChat } from '../../src/conversations/chat-http.ts';
import { listConversations } from '../../src/conversations/store.ts';
import { createThread, postMessage } from '../../src/conversations/thread-store.ts';
import { createBobApp, getBobApp, mutateBobApp } from '../../src/bob-apps/store.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { runInvocation, type InvocationContext } from '../../src/workflows/workflow-thread-invocation.ts';
import { openAppConversation } from '../../src/workflows/workflow-app-conversation.ts';
import { memoryAvailable } from '../../src/memory/available.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { createAgentHarness, type AgentHarness } from '../support/agent-harness.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { addAccount, asDb, closeTestDb, createTestDb, withAdminAuth, type TestDb, type TestAccount } from '../support/test-db.ts';
import { packing } from './fixtures.ts';

// Keep the real factory and SDK agent; substitute only the canonical provider model.
const provider = vi.hoisted((): { model: unknown } => ({ model: undefined }));
vi.mock('ai', async (original) => {
  const actual = await original<typeof import('ai')>();
  const Agent = new Proxy(actual.ToolLoopAgent, {
    construct(target, args, newTarget): object {
      const settings = args[0] as Record<string, unknown>;
      return Reflect.construct(target, [{ ...settings, model: provider.model ?? settings.model }], newTarget) as object;
    },
  });
  return { ...actual, ToolLoopAgent: Agent };
});
vi.mock('../../src/memory/available.ts', () => ({ memoryAvailable: vi.fn(async () => false) }));
vi.mock('../../src/platform/logger.ts', async () => (await import('../helpers/journal-mock.ts')).loggerMock());

let pg: TestDb;
let db: Db;
let server: Server;
let origin: string;
let harness: AgentHarness;
const factory = vi.fn<typeof createBobAgent>((options) => createBobAgent(options));

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  const getDb = async () => db;
  const app = express();
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer }), [],
    (account) => isWebSessionActive(getDb, account)));
  app.post('/api/chat', webChat({ ...createAppDeps(), getDb, agent: createRealAgent({ createBobAgent: factory, bobAgent: () => createBobAgent() }) }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  origin = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  provider.model = undefined;
  harness = createAgentHarness([[{ type: 'text', text: 'Let us improve this app.' }]]);
  provider.model = harness.model;
  factory.mockClear();
  vi.mocked(memoryAvailable).mockClear();
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pg) await closeTestDb(pg);
});

/** Every prompt the scripted provider model received this test, as one string. */
function modelPrompts(): string {
  return JSON.stringify([...harness.model.doStreamCalls, ...harness.model.doGenerateCalls].map((call) => call.prompt));
}

async function activeApp(owner: TestAccount, spaceId?: string) {
  const app = await createBobApp(db, owner.userId, { definition: packing,
    state: { items: [{ id: 'saved', values: { label: 'Keep this record', packed: false } }] },
    mutationId: randomUUID(), ...(spaceId ? { spaceId } : {}) });
  return mutateBobApp(db, owner.userId, app.id, { operation: 'activate', expectedRevision: app.revision, mutationId: randomUUID() });
}

async function privateTurn(owner: TestAccount, installationId: string): Promise<Response> {
  return fetch(`${origin}/api/chat`, { method: 'POST', headers: {
    authorization: `Bearer ${await signToken(owner)}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ message: { id: `msg_${randomUUID()}`, role: 'user', parts: [{ type: 'text', text: 'Improve this checklist' }] },
    appBinding: { installationId, mode: 'refine' } }) });
}

async function team() {
  const owner = await addAccount(pg);
  const member = await addAccount(pg);
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'App team' });
  await addMember(db, owner.userId, space.id, member.userId, 'member');
  return { owner, member, space };
}

async function sharedContext(actor: TestAccount, spaceId: string, threadId: string, installationId?: string): Promise<InvocationContext> {
  const { message } = await postMessage(db, actor.userId, { threadId, body: 'Improve our checklist', clientMessageId: randomUUID() });
  return { actorUserId: actor.userId, sessionId: actor.sessionId, spaceId, threadId, triggerMessageId: message.id, contextHighWater: message.sequence,
    ...(installationId ? { appBinding: { installationId, mode: 'refine' as const } } : {}) };
}

it('admits a valid private generic app through the real web handler to Apps read/revise tools', async () => {
  const owner = await addAccount(pg);
  const app = await activeApp(owner);
  const response = await privateTurn(owner, app.installationId);
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(body).toContain('Let us improve this app.');
  const options = factory.mock.calls.at(-1)?.[0];
  expect(options?.mode).toBe('bound_app');
  // The bound scope, as the built agent offers it: only the Apps delegate over the open app, and a chat-window reply.
  expect(Object.keys(factory.mock.results.at(-1)?.value.tools ?? {})).toEqual(['currentDateTime', 'apps_agent']);
  expect(modelPrompts()).toContain('This reply is read in a chat window.');
  expect(options?.memoryTools).toEqual({});
  expect(options?.lateTools).toEqual({});
  expect(options?.memoryContext).toBeUndefined();
  expect(Object.keys(options?.capabilityTools ?? {})).toEqual(expect.arrayContaining(['read_bob_app', 'revise_bob_app']));
  expect(Object.keys(options?.capabilityTools ?? {}).every((name) => ['read_bob_app', 'revise_bob_app', 'save_app_idea', 'currentDateTime'].includes(name))).toBe(true);
  for (const name of ['create_campaign', 'propose_marketing_config', 'list_bob_apps', 'propose_bob_app']) {
    expect(Object.keys(options?.capabilityTools ?? {})).not.toContain(name);
  }
  expect(harness.calls()).toBeGreaterThan(0);
  expect((await getBobApp(db, owner.userId, app.id)).state).toEqual(app.state);
});

it('admits a member bound to the canonical shared generic app thread without personal memory', async () => {
  const { owner, member, space } = await team();
  const app = await activeApp(owner, space.id);
  const opened = await openAppConversation(db, member.userId, app.id);
  const context = await sharedContext(member, space.id, opened.conversationId, app.installationId);
  const generate = vi.spyOn(harness.model, 'doGenerate');
  await expect(runInvocation(context, { appTurnTools: createAppTurnExtension(saveAppIdea), db, createAgent: factory })).resolves.toMatchObject({ claimed: true, outcome: 'completed' });
  expect(generate).toHaveBeenCalled();
  expect(factory.mock.calls[0]?.[0]).toMatchObject({ mode: 'shared_generic_app_refine', memoryTools: {} });
  expect(modelPrompts()).toContain('This reply is posted in a shared group thread.');
  expect(Object.keys(factory.mock.calls[0]?.[0]?.capabilityTools ?? {})).toEqual(expect.arrayContaining(['read_bob_app', 'revise_bob_app']));
  expect(memoryAvailable).not.toHaveBeenCalled();
});

it('refuses a shared app on private chat before personal context or a model call', async () => {
  const { owner, space } = await team();
  const app = await activeApp(owner, space.id);
  const before = await listConversations(db, owner.userId);
  const response = await privateTurn(owner, app.installationId);
  await response.text();
  expect(response.status).toBe(404);
  expect(memoryAvailable).not.toHaveBeenCalled();
  expect(factory).not.toHaveBeenCalled();
  expect(harness.calls()).toBe(0);
  expect(await listConversations(db, owner.userId)).toEqual(before);
});

for (const audience of ['private', 'other-group'] as const) {
  it(`refuses an accessible ${audience} app binding on a different shared thread before a model call`, async () => {
    const { owner, space } = await team();
    const other = audience === 'other-group' ? await createSpace(db, owner.userId, { kind: 'group', name: 'Other app team' }) : null;
    const app = await activeApp(owner, other?.id);
    const thread = await createThread(db, owner.userId, { spaceId: space.id, title: 'Current team' });
    const context = await sharedContext(owner, space.id, thread.id, app.installationId);
    await expect(runInvocation(context, { appTurnTools: createAppTurnExtension(saveAppIdea), db, createAgent: factory })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    expect(harness.calls()).toBe(0);
    expect(await withUser(db, owner.userId, (tx) => tx.query('select id from bob.ai_invocations where conversation_id=$1', [thread.id]))).toEqual([]);
  });
}

it('keeps an ordinary unbound group invocation working through the real SDK', async () => {
  const { owner, space } = await team();
  const thread = await createThread(db, owner.userId, { spaceId: space.id, title: 'Ordinary group' });
  const context = await sharedContext(owner, space.id, thread.id);
  const generate = vi.spyOn(harness.model, 'doGenerate');
  await expect(runInvocation(context, { appTurnTools: createAppTurnExtension(saveAppIdea), db, createAgent: factory })).resolves.toMatchObject({ outcome: 'completed' });
  expect(generate).toHaveBeenCalledOnce();
  expect(factory.mock.calls[0]?.[0]).toMatchObject({ mode: 'group', memoryTools: {} });
  expect(modelPrompts()).toContain('This reply is posted in a shared group thread.');
});

it('refuses a tombstoned sender message before returning an existing bound invocation', async () => {
  const { owner, member, space } = await team();
  const app = await activeApp(owner, space.id);
  const opened = await openAppConversation(db, member.userId, app.id);
  const context = await sharedContext(member, space.id, opened.conversationId, app.installationId);
  await expect(runInvocation(context, { appTurnTools: createAppTurnExtension(saveAppIdea), db, createAgent: factory })).resolves.toMatchObject({ outcome: 'completed' });
  await withUser(db, member.userId, (tx) => tx.query('update bob.messages set tombstoned_at=now() where id=$1', [context.triggerMessageId]));
  factory.mockClear();
  await expect(runInvocation(context, { appTurnTools: createAppTurnExtension(saveAppIdea), db, createAgent: factory })).rejects.toThrow('app_source_unavailable');
  expect(factory).not.toHaveBeenCalled();
});

it('refuses another member’s source before loading app context or calling the model', async () => {
  const { owner, member, space } = await team();
  const app = await activeApp(owner, space.id);
  const opened = await openAppConversation(db, member.userId, app.id);
  const context = await sharedContext(owner, space.id, opened.conversationId, app.installationId);
  await expect(runInvocation({ ...context, actorUserId: member.userId, sessionId: member.sessionId }, { appTurnTools: createAppTurnExtension(saveAppIdea), db, createAgent: factory })).rejects.toThrow();
  expect(factory).not.toHaveBeenCalled();
});

for (const audience of ['private', 'shared'] as const) {
  it(`executes the real bounded Apps child read/proposal on a ${audience} turn`, async () => {
    const { owner, member, space } = await team();
    const app = await activeApp(owner, audience === 'shared' ? space.id : undefined);
    const definition = { ...packing, title: 'A brighter checklist' };
    harness = createAgentHarness([
      [{ type: 'tool', name: 'apps_agent', input: { task: 'Rename this checklist' } }],
      [{ type: 'tool', name: 'read_bob_app', input: {} }],
      [{ type: 'tool', name: 'revise_bob_app', input: { expectedRevision: app.revision, definition } }],
      [{ type: 'text', text: 'Saved the proposed title.' }],
      [{ type: 'text', text: 'Your proposal is ready to review.' }],
    ]);
    provider.model = harness.model;
    if (audience === 'private') {
      const response = await privateTurn(owner, app.installationId);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Your proposal is ready to review.');
    } else {
      const opened = await openAppConversation(db, member.userId, app.id);
      const context = await sharedContext(member, space.id, opened.conversationId, app.installationId);
      expect(await runInvocation(context, { appTurnTools: createAppTurnExtension(saveAppIdea), db, createAgent: factory })).toMatchObject({ outcome: 'completed' });
    }
    const saved = await getBobApp(db, owner.userId, app.id);
    expect(saved.pendingDefinition).toEqual(definition);
    expect(saved.definition).toEqual(packing);
    expect(saved.state).toEqual(app.state);
    expect(saved.revision).toBe(app.revision + 1);
    expect(harness.calls()).toBe(5);
  });
}

for (const change of ['source', 'session'] as const) {
  it(`does not persist a generated bound reply after its ${change} is revoked`, async () => {
    const { owner, member, space } = await team();
    const app = await activeApp(owner, space.id);
    const opened = await openAppConversation(db, member.userId, app.id);
    const context = await sharedContext(member, space.id, opened.conversationId, app.installationId);
    let reached: () => void = () => undefined; let release: () => void = () => undefined;
    const pending = new Promise<void>((done) => { reached = done; });
    const released = new Promise<void>((done) => { release = done; });
    const generate = harness.model.doGenerate.bind(harness.model);
    vi.spyOn(harness.model, 'doGenerate').mockImplementation(async (options) => { reached(); await released; return generate(options); });
    const running = runInvocation(context, { appTurnTools: createAppTurnExtension(saveAppIdea), db, createAgent: factory });
    try {
      await pending;
      if (change === 'source') await withUser(db, member.userId, (tx) => tx.query('update bob.messages set tombstoned_at=now() where id=$1', [context.triggerMessageId]));
      else await withAdminAuth(pg, (admin) => admin.endSession(member.sessionId));
      release();
      expect(await running).toMatchObject({ outcome: 'cancelled', resultMessageId: null });
    } finally { release(); await Promise.allSettled([running]); }
  });
}
