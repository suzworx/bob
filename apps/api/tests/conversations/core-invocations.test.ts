// core/invocations.ts tests (014, S14-T009). Real Postgres (local stack, as
// bob_server) with the real store, but a STUBBED agent factory -- never a real model. Covers the three
// rules (shared mode excludes private context, ordinary messages never reach
// here, idempotency), the busy path, and revocation-mid-generation.
const tracing = vi.hoisted(() => ({ active: false, finish: vi.fn() }));

import { createAppTurnExtension } from '../../src/bob-apps/app-turn-extension.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';
import { randomUUID } from 'node:crypto';
import { canonicalId } from '../../src/platform/ids.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace, revokeMember } from '../../src/spaces/store.ts';
import { createThread, listMessages, postMessage, tombstoneMessage } from '../../src/conversations/thread-store.ts';
import { claimInvocation, getInvocation } from '../../src/conversations/invocations-store.ts';
import { parseMentions } from '../../src/spaces/mentions.ts';
import * as memoryToolsModule from '@bob/ai';

// Stub the agent factory: core/invocations.ts imports createBobAgent, which
// must never build a real model in a unit test. The mock returns the mutable
// agentUnderTest, so each test controls what `generate` does.

// A developer .env with BOB_AI_STUB=1 must not switch core/invocations.ts's
// default createAgent for these tests: they assert the real (mocked) agent
// factory is always used.
vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  createBobAgent: vi.fn(),
  traceSpan: vi.fn(async (_name: string, attrs: unknown, run: () => Promise<unknown>) => {
    tracing.active = true;
    try { const result = await run(); await tracing.finish(attrs, result); return result; }
    finally { tracing.active = false; }
  }),
}) ) as Factory),
    ((async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bob/ai')>()),
  AI_STUB_MODE: false,
}) ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

import { createBobAgent, traceSpan } from '@bob/ai';
import { runInvocation, type InvocationContext } from '../../src/workflows/workflow-thread-invocation.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestDb,
} from '../support/test-db.ts';

const mockCreateAgent = createBobAgent as unknown as ReturnType<typeof vi.fn>;

/** The agent the mocked factory returns; each test may replace generate(). */
let agentUnderTest: {
  generate: (args: unknown) => Promise<{ text: string; toolCalls: unknown[] }>;
};

let pg: TestDb;
let db: Db;

beforeEach(() => {
  tracing.finish.mockReset();
  mockCreateAgent.mockClear();
  mockCreateAgent.mockImplementation(() => agentUnderTest);
});

// Read as a space member: ai_invocations_select is is_space_member(space_id),
// so a raw bob_server read (no jwt claims) sees zero rows under FORCE RLS.
// The owner is a member of every space these tests create and is never
// revoked, so it legitimately sees every invocation counted here.
async function countInvocations(asUserId: string): Promise<number> {
  const rows = await withUser(db, asUserId, (tx) =>
    tx.query<{ total: unknown }>(`SELECT COUNT(*)::int AS total FROM bob.ai_invocations`),
  );
  return Number(rows[0]!.total);
}

describe('runInvocation', () => {
  let owner: { userId: string; sessionId: string };
  let actor: { userId: string; sessionId: string };
  let spaceId: string;
  let threadId: string;
  let triggerId: string;
  let contextHighWater: number;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    owner = await addAccount(pg);
    actor = await addAccount(pg);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
    spaceId = space.id;
    await addMember(db, owner.userId, space.id, actor.userId, 'member');
    const thread = await createThread(db, owner.userId, { spaceId, title: 'Grocery' });
    threadId = thread.id;
    const msg = await postMessage(db, actor.userId, {
      threadId,
      body: '@bob add milk to the grocery list',
      clientMessageId: randomUUID(),
    });
    triggerId = msg.message.id;
    contextHighWater = msg.message.sequence;
  });

  afterAll(async () => {
    await closeTestDb(pg).catch(() => undefined);
  });

  function ctx(overrides: Partial<InvocationContext> = {}): InvocationContext {
    return {
      actorUserId: actor.userId,
      spaceId,
      threadId,
      triggerMessageId: triggerId,
      contextHighWater,
      ...overrides,
    };
  }

  /** A fresh thread with one assistant-addressed trigger message. */
  async function freshTrigger(body: string): Promise<{
    threadId: string;
    triggerId: string;
    highWater: number;
  }> {
    const thread = await createThread(db, owner.userId, { spaceId, title: 'Fresh' });
    const msg = await postMessage(db, actor.userId, {
      threadId: thread.id,
      body,
      clientMessageId: randomUUID(),
    });
    return { threadId: thread.id, triggerId: msg.message.id, highWater: msg.message.sequence };
  }

  it('completes: builds the agent, persists the reply and marks completed', async () => {
    agentUnderTest = { generate: async () => { expect(tracing.active).toBe(true); return { text: 'Done', toolCalls: [] }; } };
    tracing.finish.mockImplementation(async (attrs: { turnId: string }) => {
      const saved = await getInvocation(db, actor.userId, attrs.turnId);
      expect(saved.state).toBe('completed');
      expect(saved.resultMessageId).not.toBeNull();
    });
    const result = await runInvocation(ctx(), { appTurnTools: createAppTurnExtension(saveAppIdea), db });

    expect(result.claimed).toBe(true);
    if (!result.claimed) return;
    expect(result.outcome).toBe('completed');
    expect(tracing.finish).toHaveBeenCalledTimes(1);
    expect(tracing.active).toBe(false);
    expect(result.resultMessageId).not.toBeNull();

    // Agent built with the six capability tools plus list_space_members (a
    // group space) and an explicit DISABLED memory set (shared mode excludes
    // private context).
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    const arg = mockCreateAgent.mock.calls[0]![0] as {
      capabilityTools: Record<string, unknown>;
      memoryTools: Record<string, unknown>;
    };
    expect(Object.keys(arg.capabilityTools)).toEqual([
      'list_tasks',
      'create_task',
      'complete_task',
      'update_task',
      'list_agenda',
      'create_event',
      'list_space_members',
    ]);
    expect(arg.memoryTools).toEqual({});

    const invocation = await getInvocation(db, actor.userId, result.invocation.id);
    expect(invocation.state).toBe('completed');
    expect(vi.mocked(traceSpan)).toHaveBeenCalledWith('thread-invocation', expect.objectContaining({
      turnId: invocation.id, conversationId: canonicalId('conversation', threadId), conversationSource: 'explicit',
      metadata: { interface: 'thread', invocation_id: invocation.id, turn_id: invocation.id },
    }), expect.any(Function));
    expect(invocation.resultMessageId).toBe(result.resultMessageId);

    // The reply is a thread message with a null author, linked from the result.
    const { messages } = await listMessages(db, actor.userId, threadId, { limit: 200 });
    const replies = messages.filter((m) => m.authorUserId === null);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body).toBe('Done');
    expect(replies[0]!.id).toBe(result.resultMessageId);
  });

  it('shared mode excludes private context: memory retrieval is never invoked', async () => {
    agentUnderTest = { generate: async () => ({ text: 'ok', toolCalls: [] }) };
    const fresh = await freshTrigger('@bob no private memory');
    const memorySpy = vi.spyOn(memoryToolsModule, 'createMemoryTools');
    const result = await runInvocation(
      ctx({
        threadId: fresh.threadId,
        triggerMessageId: fresh.triggerId,
        contextHighWater: fresh.highWater,
      }),
      { appTurnTools: createAppTurnExtension(saveAppIdea), db },
    );
    expect(result.claimed).toBe(true);
    // The explicitly disabled memoryTools set ({}) proves no memory callback
    // was wired in, and the memory factory itself was never called.
    expect(memorySpy).not.toHaveBeenCalled();
    expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({ memoryTools: {} }));
    memorySpy.mockRestore();
  });

  it('ordinary messages never reach here: a plain post makes zero agent calls', async () => {
    mockCreateAgent.mockClear();
    expect(parseMentions('just plain conversation, no one addressed').addressesAssistant).toBe(false);
    const msg = await postMessage(db, actor.userId, {
      threadId,
      body: 'just plain conversation, no one addressed',
      clientMessageId: randomUUID(),
    });
    expect(msg.created).toBe(true);
    // Posting a plain message must make zero model calls (FR-008): the agent
    // factory was never invoked for it.
    expect(mockCreateAgent).not.toHaveBeenCalled();
    // And only an assistant-addressed body reports addressesAssistant true.
    expect(parseMentions('@bob add milk').addressesAssistant).toBe(true);
  });

  it('idempotency: the same trigger_message_id yields one invocation and one reply', async () => {
    agentUnderTest = { generate: async () => ({ text: 'again', toolCalls: [] }) };
    const triggerMsg = await postMessage(db, actor.userId, {
      threadId,
      body: '@bob remind me',
      clientMessageId: randomUUID(),
    });
    const first = await runInvocation(
      ctx({ triggerMessageId: triggerMsg.message.id, contextHighWater: triggerMsg.message.sequence }),
      { appTurnTools: createAppTurnExtension(saveAppIdea), db },
    );
    expect(first.claimed).toBe(true);
    const second = await runInvocation(
      ctx({ triggerMessageId: triggerMsg.message.id, contextHighWater: triggerMsg.message.sequence }),
      { appTurnTools: createAppTurnExtension(saveAppIdea), db },
    );
    expect(second).toMatchObject({ claimed: false, reason: 'duplicate' });
    if (!second.claimed && second.reason === 'duplicate' && first.claimed) {
      expect(second.invocation.id).toBe(first.invocation.id);
    }

    expect(await countInvocations(owner.userId)).toBe(3); // 2 from earlier tests + this one
    const { messages } = await listMessages(db, actor.userId, threadId, { limit: 200 });
    const replies = messages.filter((m) => m.authorUserId === null && m.body === 'again');
    expect(replies).toHaveLength(1);
  });

  it.each([
    ['the account zone', 'America/Los_Angeles', 'America/Los_Angeles'],
    ['UTC for an invalid zone', 'Not/AZone', 'UTC'],
    ['UTC when the account has none', undefined, 'UTC'],
  ])('passes the agent %s', async (_label, timeZone, expected) => {
    agentUnderTest = { generate: async () => ({ text: 'ok', toolCalls: [] }) };
    const fresh = await freshTrigger('@bob what is due today');
    await runInvocation(
      ctx({ threadId: fresh.threadId, triggerMessageId: fresh.triggerId, contextHighWater: fresh.highWater, timeZone }),
      { appTurnTools: createAppTurnExtension(saveAppIdea), db },
    );
    expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({ timeZone: expected }));
  });

  it('a tombstoned message is left out of the agent prompt', async () => {
    let captured: { messages: Array<{ content: string }> } | undefined;
    agentUnderTest = {
      generate: async (args: unknown) => {
        captured = args as { messages: Array<{ content: string }> };
        return { text: 'ok', toolCalls: [] };
      },
    };
    const thread = await createThread(db, owner.userId, { spaceId, title: 'Redacted prompt' });
    await postMessage(db, actor.userId, {
      threadId: thread.id,
      body: 'first',
      clientMessageId: randomUUID(),
    });
    const toDelete = await postMessage(db, actor.userId, {
      threadId: thread.id,
      body: 'delete me',
      clientMessageId: randomUUID(),
    });
    await tombstoneMessage(db, actor.userId, toDelete.message.id);
    const trigger = await postMessage(db, actor.userId, {
      threadId: thread.id,
      body: '@bob sum up',
      clientMessageId: randomUUID(),
    });

    const result = await runInvocation(
      ctx({
        threadId: thread.id,
        triggerMessageId: trigger.message.id,
        contextHighWater: trigger.message.sequence,
      }),
      { appTurnTools: createAppTurnExtension(saveAppIdea), db },
    );
    expect(result.claimed).toBe(true);

    const contents = captured!.messages.map((m) => m.content);
    expect(contents).not.toContain('delete me');
    expect(contents).toContain('first');
  });

  it('busy: returns busy when another invocation is already running in the thread', async () => {
    // Claim a row as running and leave it un-completed.
    await claimInvocation(db, actor.userId, {
      spaceId,
      threadId,
      triggerMessageId: randomUUID(),
      contextHighWater,
      membershipRevision: 1,
    });
    const triggerMsg = await postMessage(db, actor.userId, {
      threadId,
      body: '@bob do something else',
      clientMessageId: randomUUID(),
    });
    const result = await runInvocation(
      ctx({ triggerMessageId: triggerMsg.message.id, contextHighWater: triggerMsg.message.sequence }),
      { appTurnTools: createAppTurnExtension(saveAppIdea), db },
    );
    expect(result).toMatchObject({ claimed: false, reason: 'busy', invocation: null });
  });

  it('revocation-mid-generation cancels the invocation and persists NO reply', async () => {
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let generating = false;
    agentUnderTest = {
      generate: async () => {
        generating = true;
        await gate;
        return { text: 'should not persist', toolCalls: [] };
      },
    };

    const fresh = await freshTrigger('@bob sensitive plan');
    const invocationCtx = ctx({
      threadId: fresh.threadId,
      triggerMessageId: fresh.triggerId,
      contextHighWater: fresh.highWater,
    });

    const pending = runInvocation(invocationCtx, { appTurnTools: createAppTurnExtension(saveAppIdea), db });
    await vi.waitFor(() => expect(generating).toBe(true));

    // Remove the actor from the space while the model is "generating".
    await revokeMember(db, owner.userId, spaceId, actor.userId);
    release!();

    const result = await pending;
    expect(result.claimed).toBe(true);
    if (!result.claimed) return;
    expect(result.outcome).toBe('cancelled');
    expect(result.resultMessageId).toBeNull();

    // No reply was persisted.
    const { messages } = await listMessages(db, owner.userId, fresh.threadId, { limit: 200 });
    expect(messages.some((m) => m.authorUserId === null && m.body === 'should not persist')).toBe(false);

    const invocation = await getInvocation(db, owner.userId, result.invocation.id);
    expect(invocation.state).toBe('cancelled');
    expect(invocation.resultMessageId).toBeNull();
  });
});
