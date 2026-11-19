// T014 (010, US2): the action-item tools and their Zod schemas, plus the
// disabled callback bag (T-10) and agent-factory acceptance. Fakes only -- the
// real store-backed callbacks live in memory-callbacks.db.test.ts (test:db).
import { describe, expect, it } from 'vitest';
import { createMemoryTools, type ActionItemView, type CompleteActionCallbackResult, type CompleteActionInput, type ForgetCallbackResult, type ForgetInput, type ListActionsInput, type MemoryToolCallbacks, type RememberCallbackResult, type RememberInput, createBobAgent } from '@bob/ai';
import { completeActionInputSchema, completeActionOutputSchema, forgetInputSchema, forgetOutputSchema, listActionsInputSchema, listActionsOutputSchema, rememberInputSchema, rememberOutputSchema, type CompleteActionOutput, type ListActionsOutput, type RememberOutput, type ForgetOutput } from '@bob/ai/testing';
import { createMemoryCallbacks } from '../../src/memory/callbacks.ts';
import type { Db } from '../../src/platform/db/db.ts';
import type { Tool } from 'ai';

type ListTool = { execute(input: unknown, options: unknown): PromiseLike<ListActionsOutput> | ListActionsOutput };
type CompleteTool = {
  execute(input: unknown, options: unknown): PromiseLike<CompleteActionOutput> | CompleteActionOutput;
};
type RememberTool = {
  execute(input: unknown, options: unknown): PromiseLike<RememberOutput> | RememberOutput;
};
type ForgetTool = {
  execute(input: unknown, options: unknown): PromiseLike<ForgetOutput | string> | ForgetOutput | string;
};
type MemoryTools = {
  list_actions: ListTool;
  complete_action: CompleteTool;
  remember: RememberTool;
  forget: ForgetTool;
};

const listExecute = (tools: MemoryTools, input: unknown): Promise<ListActionsOutput> =>
  Promise.resolve(tools.list_actions.execute(input, {}));
const completeExecute = (tools: MemoryTools, input: unknown): Promise<CompleteActionOutput> =>
  Promise.resolve(tools.complete_action.execute(input, {}));
const rememberExecute = (tools: MemoryTools, input: unknown): Promise<RememberOutput | string> =>
  Promise.resolve(tools.remember.execute(input, {}));
const forgetExecute = (tools: MemoryTools, input: unknown): Promise<ForgetOutput | string> =>
  Promise.resolve(tools.forget.execute(input, {}));

const item = (id: string, overrides: Partial<ActionItemView> = {}): ActionItemView => ({
  id,
  content: 'buy milk',
  status: 'open',
  due_at: null,
  ...overrides,
});

/** A recording callback bag; the agent can drive each callback's result. */
function recordingCallbacks(results: {
  list?: () => ActionItemView[] | { disabled: true };
  complete?: (input: CompleteActionInput) => CompleteActionCallbackResult;
  remember?: (input: RememberInput) => RememberCallbackResult | Promise<RememberCallbackResult>;
  forget?: (input: ForgetInput) => ForgetCallbackResult | Promise<ForgetCallbackResult>;
}): MemoryToolCallbacks & {
  listInputs: ListActionsInput[];
  completeInputs: CompleteActionInput[];
  rememberInputs: RememberInput[];
  forgetInputs: ForgetInput[];
} {
  const listInputs: ListActionsInput[] = [];
  const completeInputs: CompleteActionInput[] = [];
  const rememberInputs: RememberInput[] = [];
  const forgetInputs: ForgetInput[] = [];
  return {
    listInputs,
    completeInputs,
    rememberInputs,
    forgetInputs,
    listActions: async (input) => {
      listInputs.push(input);
      return results.list ? results.list() : [];
    },
    completeAction: async (input) => {
      completeInputs.push(input);
      if (results.complete) return results.complete(input);
      return { completed: true, action_item_id: 'act_1' };
    },
    remember: async (input) => {
      rememberInputs.push(input);
      if (results.remember) return results.remember(input);
      return { stored: true, memory_id: 'mem_1', sensitive: false };
    },
    forget: async (input) => {
      forgetInputs.push(input);
      if (results.forget) return results.forget(input);
      return { deleted: 1, memory_id: 'mem_1' };
    },
  };
}

describe('listActionsInputSchema', () => {
  it('accepts {} and a valid status', () => {
    expect(listActionsInputSchema.parse({})).toEqual({});
    expect(listActionsInputSchema.parse({ status: 'open' })).toEqual({ status: 'open' });
    expect(listActionsInputSchema.parse({ status: 'done' })).toEqual({ status: 'done' });
    expect(listActionsInputSchema.parse({ status: 'dropped' })).toEqual({ status: 'dropped' });
  });

  it('rejects an unknown status and extra keys (strict)', () => {
    expect(() => listActionsInputSchema.parse({ status: 'pending' })).toThrow();
    expect(() => listActionsInputSchema.parse({ nope: true })).toThrow();
  });
});

describe('completeActionInputSchema', () => {
  it('accepts exactly one of id or query', () => {
    expect(completeActionInputSchema.parse({ id: 'act_1' })).toEqual({ id: 'act_1' });
    expect(completeActionInputSchema.parse({ query: ' buy milk ' })).toEqual({ query: 'buy milk' });
  });

  it('rejects both, neither, an empty query, and extra keys', () => {
    expect(() => completeActionInputSchema.parse({ id: 'a', query: 'b' })).toThrow(/exactly one/);
    expect(() => completeActionInputSchema.parse({})).toThrow(/exactly one/);
    expect(() => completeActionInputSchema.parse({ query: '   ' })).toThrow();
    expect(() => completeActionInputSchema.parse({ id: 'a', nope: true })).toThrow();
  });
});

describe('rememberInputSchema', () => {
  it('accepts plain content, a kind, due on action_item, and sensitive', () => {
    expect(rememberInputSchema.parse({ content: ' prefers chai ' })).toEqual({
      content: 'prefers chai',
    });
    expect(
      rememberInputSchema.parse({
        content: 'lunch with dana',
        kind: 'action_item',
        due: '2026-09-18T13:00:00Z',
        sensitive: true,
      }),
    ).toMatchObject({ kind: 'action_item', sensitive: true });
  });

  it('rejects empty/oversized content, a bare due on a non-action kind is accepted at parse, and extra keys', () => {
    expect(() => rememberInputSchema.parse({ content: '   ' })).toThrow();
    expect(() => rememberInputSchema.parse({ content: 'x'.repeat(2001) })).toThrow();
    expect(() => rememberInputSchema.parse({ content: 'hi', due: 'not-a-date' })).toThrow();
    expect(() => rememberInputSchema.parse({ content: 'hi', nope: true })).toThrow();
  });
});

describe('forgetInputSchema', () => {
  it('accepts exactly one of id or query', () => {
    expect(forgetInputSchema.parse({ id: 'mem_1' })).toEqual({ id: 'mem_1' });
    expect(forgetInputSchema.parse({ query: ' buy milk ' })).toEqual({ query: 'buy milk' });
  });

  it('rejects both, neither, an empty query, and extra keys', () => {
    expect(() => forgetInputSchema.parse({ id: 'a', query: 'b' })).toThrow(/exactly one/);
    expect(() => forgetInputSchema.parse({})).toThrow(/exactly one/);
    expect(() => forgetInputSchema.parse({ query: '   ' })).toThrow();
    expect(() => forgetInputSchema.parse({ id: 'a', nope: true })).toThrow();
  });
});

describe('remember and forget output schemas', () => {
  it('rememberOutputSchema parses stored, refused and disabled forms', () => {
    expect(
      rememberOutputSchema.parse({ stored: true, refused: false, memory_id: 'a', sensitive: false }),
    ).toMatchObject({ stored: true });
    expect(
      rememberOutputSchema.parse({
        stored: false,
        refused: true,
        memory_id: null,
        sensitive: false,
      }).refused,
    ).toBe(true);
    expect(
      rememberOutputSchema.parse({
        stored: false,
        refused: false,
        memory_id: null,
        sensitive: false,
        disabled: true,
      }).disabled,
    ).toBe(true);
  });

  it('forgetOutputSchema parses deleted and disabled forms', () => {
    expect(forgetOutputSchema.parse({ deleted: 1, memory_id: 'a' })).toMatchObject({ deleted: 1 });
    expect(forgetOutputSchema.parse({ deleted: 0, memory_id: null, disabled: true })).toMatchObject({
      deleted: 0,
      disabled: true,
    });
  });
});

describe('createMemoryTools remember', () => {
  it('stores plain content and calls the callback once (T-01)', async () => {
    const cbs = recordingCallbacks({});
    const tools = createMemoryTools(cbs) as unknown as MemoryTools;
    const out = await rememberExecute(tools, { content: 'prefers chai over coffee' });
    expect(cbs.rememberInputs).toEqual([{ content: 'prefers chai over coffee' }]);
    expect(out).toEqual({ stored: true, refused: false, memory_id: 'mem_1', sensitive: false });
  });

  it('refuses secret-shaped content without calling the callback or journaling (T-02)', async () => {
    const tail = Array.from({ length: 24 }, () => 'a').join('');
    const secretContent = ['sk-', tail].join('');
    let journalLines: string[] = [];
    const callbacks = createMemoryCallbacks(
      { query: async () => [] } as unknown as Db,
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      {
        isAvailable: async () => true,
        journal: (event, fields) => journalLines.push(JSON.stringify({ event, ...fields })),
      },
    );
    const cbs = recordingCallbacks({ remember: () => callbacks.remember({ content: secretContent }) });
    const tools = createMemoryTools(cbs) as unknown as MemoryTools;
    const out = await rememberExecute(tools, { content: secretContent });
    expect(out).toEqual({ stored: false, refused: true, memory_id: null, sensitive: false });
    expect(cbs.rememberInputs).toEqual([]);
    expect(journalLines).toEqual([]);
  });

  it('passes sensitive through to the callback (T-03)', async () => {
    const cbs = recordingCallbacks({});
    const tools = createMemoryTools(cbs) as unknown as MemoryTools;
    const out = await rememberExecute(tools, {
      content: 'sees doctor patel',
      sensitive: true,
    });
    expect(cbs.rememberInputs[0]).toEqual({ content: 'sees doctor patel', sensitive: true });
    expect(out).toMatchObject({ sensitive: false });
  });

  it('accepts an action item with a due date (T-04)', async () => {
    const cbs = recordingCallbacks({});
    const tools = createMemoryTools(cbs) as unknown as MemoryTools;
    const out = await rememberExecute(tools, {
      content: 'email dana by friday',
      kind: 'action_item',
      due: '2026-09-18T00:00:00Z',
    });
    expect(cbs.rememberInputs[0]).toMatchObject({ kind: 'action_item' });
    expect(out).toMatchObject({ stored: true });
  });

  it('maps a disabled callback to the short memory-off result (T-10)', async () => {
    const cbs = recordingCallbacks({ remember: () => ({ disabled: true }) });
    const tools = createMemoryTools(cbs) as unknown as MemoryTools;
    const out = await rememberExecute(tools, { content: 'buy milk' });
    expect(out).toEqual({
      stored: false,
      refused: false,
      memory_id: null,
      sensitive: false,
      disabled: true,
    });
  });
});

describe('createMemoryTools forget', () => {
  it('forgets by id and by query (T-06)', async () => {
    const cbs = recordingCallbacks({});
    const tools = createMemoryTools(cbs) as unknown as MemoryTools;
    const outId = await forgetExecute(tools, { id: 'mem_1' });
    expect(cbs.forgetInputs[0]).toEqual({ id: 'mem_1' });
    expect(outId).toEqual({ deleted: 1, memory_id: 'mem_1' });

    const outQuery = await forgetExecute(tools, { query: 'buy milk' });
    expect(cbs.forgetInputs[1]).toEqual({ query: 'buy milk' });
    expect(outQuery).toEqual({ deleted: 1, memory_id: 'mem_1' });
  });

  it('turns below-threshold candidates into disambiguation text (T-15)', async () => {
    const cbs = recordingCallbacks({
      forget: () => ({
        deleted: 0,
        memory_id: null,
        candidates: [
          { id: 'a', content: 'buy milk' },
          { id: 'b', content: 'buy oat milk' },
          { id: 'c', content: 'buy soy milk' },
        ],
      }),
    });
    const tools = createMemoryTools(cbs) as unknown as MemoryTools;
    const out = await forgetExecute(tools, { query: 'milk' });
    expect(typeof out).toBe('string');
    expect(out as string).toContain('buy oat milk');
    expect(out as string).toContain('a');
  });

  it('maps a disabled callback to the short memory-off result (T-10)', async () => {
    const cbs = recordingCallbacks({ forget: () => ({ disabled: true }) });
    const tools = createMemoryTools(cbs) as unknown as MemoryTools;
    const out = await forgetExecute(tools, { id: 'mem_1' });
    expect(out).toEqual({ deleted: 0, memory_id: null, disabled: true });
  });
});

describe('remember/forget journal carries no content (T-13, FR-013)', () => {
  it('emits only metadata events; the remembered content never appears', async () => {
    // An empty store: findBestMatch returns no candidates, so remember takes the
    // add path and forget the candidates path. The journal is captured; content
    // must never reach it.
    const fakeTx = (): Db => ({
      async query<T>(sql: string): Promise<T[]> {
        if (sql.includes('INSERT INTO bob.memories')) {
          return [{
            id: 'mem-123456789-abcd-ef01',
            kind: 'fact',
            content: 'stored content',
            confidence: 0.8,
            sensitive: false,
            conversationId: null,
            messageId: null,
            surface: 'web_text',
            supersededBy: null,
            embeddingModel: null,
            embeddingDim: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            createdUs: Date.now() * 1000,
          }] as unknown as T[];
        }
        return [];
      },
      async tx<T>(fn: (d: Db) => Promise<T>): Promise<T> {
        return fn(fakeTx());
      },
    });
    const db: Db = {
      async query<T>(sql: string): Promise<T[]> {
        if (sql.includes('INSERT INTO bob.memories')) {
          return [{
            id: 'mem-123456789-abcd-ef01',
            kind: 'fact',
            content: 'stored content',
            confidence: 0.8,
            sensitive: false,
            conversationId: null,
            messageId: null,
            surface: 'web_text',
            supersededBy: null,
            embeddingModel: null,
            embeddingDim: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            createdUs: Date.now() * 1000,
          }] as unknown as T[];
        }
        return [];
      },
      async tx<T>(fn: (d: Db) => Promise<T>): Promise<T> {
        return fn(fakeTx());
      },
    };
    const userId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const journalLines: string[] = [];
    const callbacks = createMemoryCallbacks(db, userId, {
      isAvailable: async () => true,
      journal: (event, fields) => journalLines.push(JSON.stringify({ event, ...fields })),
    });

    const content = 'prefers chai over coffee';
    await callbacks.remember({ content });
    await callbacks.forget({ query: content });

    expect(journalLines.length).toBeGreaterThan(0);
    const joined = journalLines.join('\n');
    expect(joined).not.toContain(content);
    expect(joined).toContain('v2.memory_remembered');
    expect(joined).toContain('v2.memory_forget_candidates');
  });
});

describe('output schemas', () => {
  it('listActionsOutputSchema parses a view list with an optional disabled flag', () => {
    const out = listActionsOutputSchema.parse({
      items: [item('a'), item('b', { due_at: '2026-09-20T00:00:00.000Z', status: 'done' })],
    });
    expect(out.items).toHaveLength(2);
    expect(out.disabled).toBeUndefined();
    expect(
      listActionsOutputSchema.parse({ items: [], disabled: true }).disabled,
    ).toBe(true);
  });

  it('completeActionOutputSchema parses completed and candidate forms', () => {
    expect(completeActionOutputSchema.parse({ completed: true, action_item_id: 'a' })).toMatchObject({
      completed: true,
      action_item_id: 'a',
    });
    expect(
      completeActionOutputSchema.parse({
        completed: false,
        action_item_id: null,
        candidates: [{ id: 'a', content: 'buy milk' }],
      }).candidates,
    ).toHaveLength(1);
  });
});

describe('createMemoryTools list_actions', () => {
  it('defaults to open and passes the requested status through (T-08)', async () => {
    const cbs = recordingCallbacks({ list: () => [item('a'), item('b')] });
    const tools = createMemoryTools(cbs) as unknown as MemoryTools;
    const out = await listExecute(tools, {});
    expect(cbs.listInputs).toEqual([{}]);
    expect(out).toEqual({ items: [item('a'), item('b')] });

    const outDone = await listExecute(tools, { status: 'done' });
    expect(cbs.listInputs[1]).toEqual({ status: 'done' });
    expect(outDone.items).toHaveLength(2);
  });

  it('maps a disabled callback to a short non-error result (T-10)', async () => {
    const cbs = recordingCallbacks({ list: () => ({ disabled: true }) });
    const tools = createMemoryTools(cbs) as unknown as MemoryTools;
    const out = await listExecute(tools, {});
    expect(out).toEqual({ items: [], disabled: true });
  });
});

describe('createMemoryTools complete_action', () => {
  it('completes by id (T-09)', async () => {
    const cbs = recordingCallbacks({
      complete: () => ({ completed: true, action_item_id: 'act_1' }),
    });
    const tools = createMemoryTools(cbs) as unknown as MemoryTools;
    const out = await completeExecute(tools, { id: 'act_1' });
    expect(cbs.completeInputs).toEqual([{ id: 'act_1' }]);
    expect(out).toEqual({ completed: true, action_item_id: 'act_1' });
  });

  it('completes by query and leaves the open list semantics to the callback (T-09)', async () => {
    const cbs = recordingCallbacks({
      complete: (input) => ({ completed: true, action_item_id: null }),
    });
    const tools = createMemoryTools(cbs) as unknown as MemoryTools;
    const out = await completeExecute(tools, { query: 'buy milk' });
    expect(cbs.completeInputs).toEqual([{ query: 'buy milk' }]);
    expect(out).toEqual({ completed: true, action_item_id: null });
  });

  it('returns below-threshold candidates so the agent can ask which one (T-09, T-15)', async () => {
    const cbs = recordingCallbacks({
      complete: () => ({
        completed: false,
        candidates: [
          { id: 'a', content: 'buy milk' },
          { id: 'b', content: 'buy oat milk' },
          { id: 'c', content: 'buy soy milk' },
        ],
      }),
    });
    const tools = createMemoryTools(cbs) as unknown as MemoryTools;
    const out = await completeExecute(tools, { query: 'milk' });
    expect(out.completed).toBe(false);
    expect(out.action_item_id).toBeNull();
    expect(out.candidates).toHaveLength(3);
  });

  it('maps a disabled callback to a non-error result (T-10)', async () => {
    const cbs = recordingCallbacks({ complete: () => ({ disabled: true }) });
    const tools = createMemoryTools(cbs) as unknown as MemoryTools;
    const out = await completeExecute(tools, { id: 'act_1' });
    expect(out).toEqual({ completed: false, action_item_id: null, disabled: true });
  });
});

describe('createMemoryCallbacks disabled bag (T-10)', () => {
  it('returns { disabled: true } with zero store calls when the store is off', async () => {
    // A fake Db that throws if any SQL runs -- the disabled path must never
    // reach the store (T-10). It also overrides the memoryAvailable guard.
    let calls = 0;
    const db: Db = {
      async query<T>(): Promise<T[]> {
        calls += 1;
        throw new Error('disabled bag must not query');
      },
      async tx<T>(): Promise<T> {
        calls += 1;
        throw new Error('disabled bag must not tx');
      },
    };
    const callbacks = createMemoryCallbacks(db, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      isAvailable: async () => false,
    });
    expect(await callbacks.listActions({})).toEqual({ disabled: true });
    expect(await callbacks.completeAction({ id: 'act_1' })).toEqual({ disabled: true });
    expect(await callbacks.completeAction({ query: 'buy milk' })).toEqual({ disabled: true });
    expect(await callbacks.remember({ content: 'buy milk' })).toEqual({ disabled: true });
    expect(await callbacks.forget({ id: 'act_1' })).toEqual({ disabled: true });
    expect(await callbacks.forget({ query: 'buy milk' })).toEqual({ disabled: true });
    expect(calls).toBe(0);
  });
});

describe('createBobAgent accepts the memory tools without a name clash', () => {
  it('merges remember, forget, list_actions and complete_action alongside the assistant tools', () => {
    const cbs = recordingCallbacks({});
    const tools = createMemoryTools(cbs) as unknown as Record<string, Tool>;
    expect(() => createBobAgent({ memoryTools: tools })).not.toThrow();
    const agent = createBobAgent({ memoryTools: tools });
    const settings = (agent as unknown as { settings: Record<string, unknown> }).settings;
    const names = Object.keys(settings.tools as Record<string, unknown>);
    expect(names).toContain('remember');
    expect(names).toContain('forget');
    expect(names).toContain('list_actions');
    expect(names).toContain('complete_action');
    expect(names).not.toContain('listActions'); // snake_case contract names only
  });
});