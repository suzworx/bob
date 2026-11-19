/**
 * list_space_members (owner gap 2026-10-06): a turn bound to a shared space can
 * name that space's ACTIVE members (name, @handle, role, isYou) and nothing
 * more -- no email, no user id. The web space conversation (a thread
 * invocation, runInvocation) offers it in a pair or group space; the personal
 * web chat (/api/chat) never does, and the binder answers a non-member like a
 * missing space. Real Postgres; the model is the SDK's MockLanguageModelV4 in a
 * real ToolLoopAgent, so the scripted turn runs the real tool on the real store.
 */
import { createAppTurnExtension } from '../../src/bob-apps/app-turn-extension.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';
import type { MockLanguageModelV4 as MockModel } from 'ai/test';

const state = vi.hoisted(() => ({ agentOpts: [] as Array<Record<string, unknown>> }));

vi.mock('../../src/memory/available.ts', () => ({ memoryAvailable: vi.fn(async () => false), resetMemoryAvailability: vi.fn() }));
vi.mock('@bob/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bob/ai')>();
  const { ToolLoopAgent, stepCountIs } = await import('ai');
  const { MockLanguageModelV4 } = await import('ai/test');
  type Options = MockModel['doGenerateCalls'][number];
  const usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0, text: 0, reasoning: 0 },
    totalTokens: 0,
  };
  /** Step 1 calls list_space_members when it is offered; step 2 names the members the tool returned. */
  const nextStep = (prompt: Options['prompt'], offered: boolean): { text: string } | { call: true } => {
    const last = prompt[prompt.length - 1];
    if (last?.role === 'tool') {
      const part = last.content.find((entry) => entry.type === 'tool-result');
      const output = part && 'output' in part ? (part.output as { type: string; value: unknown }) : null;
      const value = output?.type === 'json' ? (output.value as { members?: Array<{ name: string | null; isYou: boolean }> }) : {};
      const names = (value.members ?? []).map((member) => (member.isYou ? `${member.name} (you)` : member.name));
      return { text: `Members: ${names.join(', ')}` };
    }
    return offered ? { call: true } : { text: 'ok' };
  };
  const finish = (step: { text: string } | { call: true }) => {
    const unified = 'call' in step ? 'tool-calls' as const : 'stop' as const;
    return { finishReason: { unified, raw: unified }, usage };
  };
  return {
    ...actual,
    AI_STUB_MODE: false,
    debugLog: vi.fn(),
    createBobAgent: vi.fn((opts: Record<string, unknown>) => {
      state.agentOpts.push(opts);
      const tools = { ...(opts.capabilityTools as object), ...(opts.lateTools as object | undefined) } as Record<string, Tool>;
      const offered = 'list_space_members' in tools;
      const model = new MockLanguageModelV4({
        modelId: 'members-script',
        doGenerate: async ({ prompt }) => {
          const step = nextStep(prompt, offered);
          const content = 'call' in step
            ? [{ type: 'tool-call' as const, toolCallId: 'c1', toolName: 'list_space_members', input: '{}' }]
            : [{ type: 'text' as const, text: step.text }];
          return { content, warnings: [], ...finish(step) };
        },
        doStream: async ({ prompt }) => {
          const step = nextStep(prompt, offered);
          const parts = 'call' in step
            ? [{ type: 'tool-call' as const, toolCallId: 'c1', toolName: 'list_space_members', input: '{}' }]
            : [{ type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: step.text }, { type: 'text-end' as const, id: 't' }];
          return {
            stream: new ReadableStream({
              start(controller): void {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                for (const part of parts) controller.enqueue(part);
                controller.enqueue({ type: 'finish', ...finish(step) });
                controller.close();
              },
            }),
          };
        },
      });
      return new ToolLoopAgent({ model, tools, stopWhen: stepCountIs(4) });
    }),
  };
});

import { createSpaceMemberTools } from '@bob/ai';
import { webChat } from '../../src/conversations/chat-http.ts';
import { bindSpaceMemberCallbacks } from '../../src/conversations/space-member-callbacks.ts';
import { createThread, listMessages, postMessage } from '../../src/conversations/thread-store.ts';
import { runInvocation } from '../../src/workflows/workflow-thread-invocation.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { addMember, createSpace, ensurePrivateSpace, revokeMember } from '../../src/spaces/store.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { createAppDeps } from '../../src/app-deps.ts';
import { addAccount, asDb, closeTestDb, createTestDb, withAdminAuth, type TestDb } from '../support/test-db.ts';

const appDeps = createAppDeps();
const QUESTION = '@bob Who are the members in this space?';
let pg: TestDb;
let db: Db;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
});
afterAll(async () => {
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});
afterEach(() => {
  state.agentOpts = [];
});

/** An account with a display name and an email, so a leak of either would show. */
async function person(name: string): Promise<string> {
  const { userId } = await addAccount(pg);
  await withAdminAuth(pg, (admin) => admin.setProfile(userId, { name, email: `${name.toLowerCase()}.${userId.slice(0, 8)}@example.com` }));
  return userId;
}

/** A group space: Ada owns it, Ben is an admin, Cy was revoked; Dee is an outsider. */
async function room(): Promise<{ ada: string; ben: string; cy: string; dee: string; spaceId: string }> {
  const [ada, ben, cy, dee] = [await person('Ada'), await person('Ben'), await person('Cy'), await person('Dee')];
  const spaceId = (await createSpace(db, ada, { kind: 'group', name: 'Family' })).id;
  await addMember(db, ada, spaceId, ben, 'admin');
  await addMember(db, ada, spaceId, cy, 'member');
  await revokeMember(db, ada, spaceId, cy);
  return { ada, ben, cy, dee, spaceId };
}

type MembersResult = { ok: boolean; reason?: string; members?: unknown[] };

async function listVia(userId: string, spaceId: string): Promise<MembersResult> {
  const tool = createSpaceMemberTools(bindSpaceMemberCallbacks(db, userId, spaceId)).list_space_members!;
  return (await tool.execute!({}, { toolCallId: 'c', messages: [], context: {} })) as MembersResult;
}

/** Asks Bob in a new thread of `spaceId` as `actor`; returns the reply body the thread saved. */
async function askInThread(actor: string, spaceId: string): Promise<string | undefined> {
  const thread = await createThread(db, actor, { spaceId, title: 'Who' });
  const posted = await postMessage(db, actor, { threadId: thread.id, body: QUESTION, clientMessageId: randomUUID() });
  const result = await runInvocation({
    actorUserId: actor, spaceId, threadId: thread.id, triggerMessageId: posted.message.id, contextHighWater: posted.message.sequence,
  }, { appTurnTools: createAppTurnExtension(saveAppIdea), db });
  expect(result).toMatchObject({ claimed: true, outcome: 'completed' });
  const { messages } = await listMessages(db, actor, thread.id, { limit: 50 });
  return messages.find((message) => message.authorUserId === null)?.body;
}

function offeredTools(): string[] {
  const opts = state.agentOpts.at(-1)!;
  return [...Object.keys((opts.capabilityTools as object | undefined) ?? {}), ...Object.keys((opts.lateTools as object | undefined) ?? {})];
}

describe('list_space_members binder', () => {
  it("returns the active members' name, handle, role and isYou -- never an email or id, never a revoked member", async () => {
    const r = await room();
    const result = await listVia(r.ben, r.spaceId);
    expect(result).toEqual({
      ok: true,
      members: [
        { name: 'Ada', handle: 'ada', role: 'owner', isYou: false },
        { name: 'Ben', handle: 'ben', role: 'admin', isYou: true },
      ],
    });
    const text = JSON.stringify(result);
    for (const id of [r.ada, r.ben, r.cy]) expect(text).not.toContain(id);
    expect(text).not.toContain('@example.com');
    expect(text).not.toContain('Cy');
  });

  it('a non-member, and a revoked member, get the same answer as a missing space', async () => {
    const r = await room();
    expect(await listVia(r.dee, r.spaceId)).toEqual({ ok: false, reason: 'space not found' });
    expect(await listVia(r.cy, r.spaceId)).toEqual({ ok: false, reason: 'space not found' });
  });
});

describe('web space conversation (thread invocation)', () => {
  it('"who are the members in this space?" calls list_space_members and the reply names them', async () => {
    const r = await room();
    const reply = await askInThread(r.ada, r.spaceId);
    expect(offeredTools()).toContain('list_space_members');
    expect(reply).toBe('Members: Ada (you), Ben');
  });

  it('a personal conversation does not offer it', async () => {
    const { userId } = await addAccount(pg);
    const conversation = await createConversation(db, userId, 'Personal');
    const res = { status() { return res; }, setHeader() {}, json() {}, end() {}, write() { return true; }, on() { return res; }, writableEnded: false };
    const message = { id: `msg-${randomUUID()}`, role: 'user', parts: [{ type: 'text', text: QUESTION }] };
    await webChat(appDeps)({ body: { id: conversation.id, message }, on: vi.fn(), account: { userId, sessionId: 's', exp: 1 } } as never, res as never);
    expect(offeredTools()).toContain('create_task');
    expect(offeredTools()).not.toContain('list_space_members');
  });
});

describe('personal web chat (/api/chat)', () => {
  it('does not offer it', async () => {
    const ada = await person('Ada');
    const conversation = await createConversation(db, ada, 'Personal');
    const res = { status() { return res; }, setHeader() {}, json() {}, end() {}, write() { return true; }, on() { return res; }, writableEnded: false };
    const message = { id: `msg-${randomUUID()}`, role: 'user', parts: [{ type: 'text', text: QUESTION }] };
    await webChat(appDeps)({ body: { id: conversation.id, message }, on: vi.fn(), account: { userId: ada, sessionId: 's', exp: 1 } } as never, res as never);
    expect(state.agentOpts).toHaveLength(1);
    expect(offeredTools()).toContain('create_task');
    expect(offeredTools()).not.toContain('list_space_members');
  });
});
