// core/invocations.ts stub-mode tests (CU-THREADS-1). AI_STUB_MODE mocked true:
// runInvocation must persist a canned reply with zero calls to the real agent
// factory, exactly like turn.ts and web-chat.ts's stub paths.
import { createAppTurnExtension } from '../../src/bob-apps/app-turn-extension.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createThread, listMessages, postMessage } from '../../src/conversations/thread-store.ts';
import { getInvocation } from '../../src/conversations/invocations-store.ts';


vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bob/ai')>()),
  AI_STUB_MODE: true,
}) ) as Factory),
    ((() => ({
  createBobAgent: vi.fn(),
}) ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

import { createBobAgent } from '@bob/ai';
import { agentConfigFromEnv, selectAgent, STUB_INVOCATION_REPLY } from '../../src/voice/agent-adapters.ts';
import { runInvocation, type InvocationContext } from '../../src/workflows/workflow-thread-invocation.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const mockCreateAgent = createBobAgent as unknown as ReturnType<typeof vi.fn>;

let pg: TestDb;
let db: Db;

beforeEach(() => {
  mockCreateAgent.mockClear();
});

describe('runInvocation in AI-stub mode', () => {
  let owner: { userId: string; sessionId: string };
  let actor: { userId: string; sessionId: string };
  let spaceId: string;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    owner = await addAccount(pg);
    actor = await addAccount(pg);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
    spaceId = space.id;
    await addMember(db, owner.userId, space.id, actor.userId, 'member');
  });

  afterAll(async () => {
    await closeTestDb(pg).catch(() => undefined);
  });

  /** A fresh thread with one assistant-addressed trigger message. */
  async function freshTrigger(body: string): Promise<InvocationContext> {
    const thread = await createThread(db, owner.userId, { spaceId, title: 'Fresh' });
    const msg = await postMessage(db, actor.userId, {
      threadId: thread.id,
      body,
      clientMessageId: randomUUID(),
    });
    return {
      actorUserId: actor.userId,
      spaceId,
      threadId: thread.id,
      triggerMessageId: msg.message.id,
      contextHighWater: msg.message.sequence,
    };
  }

  it('stub mode: completes with the canned reply and never builds the real agent', async () => {
    const ctx = await freshTrigger('@bob add milk to the grocery list');
    // The composition root picks the agent port once; the stub adapter is what AI-stub mode selects.
    const agent = selectAgent(agentConfigFromEnv(true, false));
    const result = await runInvocation(ctx, { appTurnTools: createAppTurnExtension(saveAppIdea), db, agent });

    expect(result.claimed).toBe(true);
    if (!result.claimed) return;
    expect(result.outcome).toBe('completed');
    expect(mockCreateAgent).not.toHaveBeenCalled();

    const { messages } = await listMessages(db, actor.userId, ctx.threadId, { limit: 200 });
    const replies = messages.filter((m) => m.authorUserId === null);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body).toBe(STUB_INVOCATION_REPLY);
    expect(replies[0]!.id).toBe(result.resultMessageId);

    const invocation = await getInvocation(db, actor.userId, result.invocation.id);
    expect(invocation.state).toBe('completed');
  });

  it('stub mode: an injected createAgent still wins', async () => {
    const ctx = await freshTrigger('@bob do something else');
    const createAgent = vi.fn(() => ({
      generate: async () => ({ text: 'Injected', toolCalls: [] }),
    })) as unknown as typeof createBobAgent;

    const result = await runInvocation(ctx, { appTurnTools: createAppTurnExtension(saveAppIdea), db, createAgent });

    expect(result.claimed).toBe(true);
    if (!result.claimed) return;
    const { messages } = await listMessages(db, actor.userId, ctx.threadId, { limit: 200 });
    const replies = messages.filter((m) => m.authorUserId === null);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body).toBe('Injected');
  });
});
