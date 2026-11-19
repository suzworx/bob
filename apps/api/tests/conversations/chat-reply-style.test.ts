/**
 * FMT-U2 (#898): every caller of createBobAgent names its surface. The web
 * route picks 'voice' or 'text' from the request origin; a Space invocation
 * always gets 'group' (a shared-thread reply, never addressed as a person).
 * A tool-wiring failure retries with zero tools while preserving voice style.
 * TG-AGENT-HARNESS: every agent here is
 * the real-SDK harness, never a hand-written stream/generate double.
 */
import { createAppTurnExtension } from '../../src/bob-apps/app-turn-extension.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// memory off: a real retrieval would reach the embedder; this test only cares what replyStyle each surface sets.
vi.mock('../../src/memory/available.ts', () => ({ memoryAvailable: vi.fn(async () => false), resetMemoryAvailability: vi.fn() }));
vi.mock('../../src/platform/logger.ts', async () => (await import('../helpers/journal-mock.ts')).loggerMock());

import { createBobAgent, type CreateBobAgentOptions } from '@bob/ai';
import type { AgentImpl, AgentPort } from '../../src/voice/agent-port.ts';
import { webChat } from '../../src/conversations/chat-http.ts';
import { createAppDeps } from '../../src/app-deps.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createThread, postMessage } from '../../src/conversations/thread-store.ts';
import { runInvocation, type InvocationContext } from '../../src/workflows/workflow-thread-invocation.ts';
import { createAgentHarness, words } from '../support/agent-harness.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); setSharedDb(Promise.resolve(db)); });
afterAll(async () => { await closeDb().catch(() => undefined); await closeTestDb(pg).catch(() => undefined); });

/** A fake agent port whose `create` records the options each web turn built; the agent itself is a real-SDK harness agent. */
function fakeAgentPort(): { port: AgentPort; calls: CreateBobAgentOptions[] } {
  const calls: CreateBobAgentOptions[] = [];
  const agent = createAgentHarness([words('answer')]).agent as unknown as AgentImpl;
  const port: AgentPort = {
    kind: 'real',
    base: () => agent,
    create: (opts) => { calls.push(opts); return agent; },
    createInvocation: (opts) => { calls.push(opts); return agent as never; },
    withOfferedTools: (given) => given,
  };
  return { port, calls };
}

/** The normal tool wiring fails; only a deliberately tool-free retry can reply. */
function failingToolWiringPort(): { port: AgentPort; calls: CreateBobAgentOptions[] } {
  const calls: CreateBobAgentOptions[] = [];
  const agent = createAgentHarness([words('answer')]).agent as unknown as AgentImpl;
  const port: AgentPort = {
    kind: 'real',
    base: () => { throw new Error('Unfiltered singleton must not run'); },
    create: (opts) => {
      calls.push(opts);
      if (calls.length === 1) throw new Error('wiring broke');
      return agent;
    },
    createInvocation: (opts) => { calls.push(opts); return agent as never; },
    withOfferedTools: (given) => given,
  };
  return { port, calls };
}

function response() {
  const listeners: Record<string, () => void> = {};
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    writableEnded: false,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
    write(chunk: Buffer | string) { this.chunks.push(String(chunk)); },
    end() { this.writableEnded = true; listeners.close?.(); },
    json(body: unknown) { this.chunks.push(JSON.stringify(body)); },
    on(event: string, handler: () => void) { listeners[event] = handler; },
  };
}

const userMessage = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', text }] });

describe('web chat: reply style by surface (#898)', () => {
  it.each([
    ['web_text', 'chat'],
    ['web_voice', 'web_voice'],
  ] as const)('origin %s builds the agent on the %s row', async (origin, expected) => {
    const { userId } = await addAccount(pg);
    const { port, calls } = fakeAgentPort();
    const deps = { ...createAppDeps(), agent: port };
    const result = response();
    await webChat(deps)(
      { body: { message: userMessage(randomUUID(), 'who are you'), origin }, on: vi.fn(), account: { userId, sessionId: 's1', exp: Math.floor(Date.now() / 1000) + 3600 } } as never,
      result as never,
    );
    expect(result.statusCode).toBe(200);
    expect(calls[0]).toMatchObject({ mode: expected });
  });

  it('a degraded web voice turn retries with zero tools and preserves voice reply style', async () => {
    const { userId } = await addAccount(pg);
    const { port, calls } = failingToolWiringPort();
    const deps = { ...createAppDeps(), agent: port };
    const result = response();
    await webChat(deps)(
      { body: { message: userMessage(randomUUID(), 'who are you'), origin: 'web_voice' }, on: vi.fn(), account: { userId, sessionId: 's1', exp: Math.floor(Date.now() / 1000) + 3600 } } as never,
      result as never,
    );
    expect(result.statusCode).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ mode: 'web_voice_degraded' });
    expect(createBobAgent(calls[1]).tools).toEqual({});
    expect(result.chunks.join('')).toContain('answer');
  });
});

describe('space invocation: reply style (#898)', () => {
  it("builds the agent on the 'group' row", async () => {
    const owner = await addAccount(pg);
    const actor = await addAccount(pg);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Family' });
    await addMember(db, owner.userId, space.id, actor.userId, 'member');
    const thread = await createThread(db, owner.userId, { spaceId: space.id, title: 'Grocery' });
    const msg = await postMessage(db, actor.userId, { threadId: thread.id, body: '@bob add milk', clientMessageId: randomUUID() });
    const ctx: InvocationContext = { actorUserId: actor.userId, spaceId: space.id, threadId: thread.id, triggerMessageId: msg.message.id, contextHighWater: msg.message.sequence };
    const calls: CreateBobAgentOptions[] = [];
    const createAgent = (opts?: CreateBobAgentOptions) => { calls.push(opts ?? {}); return createAgentHarness([words('done')]).agent; };
    await runInvocation(ctx, { appTurnTools: createAppTurnExtension(saveAppIdea), db, createAgent });
    expect(calls[0]).toMatchObject({ mode: 'group' });
  });
});
