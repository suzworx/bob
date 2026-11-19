/**
 * GAMES-GUARD finding 2: in a web game turn the model's text is held until
 * guardGameReply has checked it, and only the checked text reaches the
 * reader; a normal web turn streams its upstream bytes unchanged.
 * Default suite: the gate alone, no model, no network. The turn-agent cases below stub the model and the database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';
import { z } from 'zod';
import { marketingTaskContext, marketingToolNames, taskContextText } from '@bob/ai';
import { createGameStreamGate } from '../../src/conversations/chat-stream.ts';
import { buildTurnAgent, startAgentReads, type BuildAgentInput } from '../../src/turn/chat-agent.ts';
import type { WebChatDeps } from '../../src/conversations/chat-tools.ts';
import type { ConversationScope } from '../../src/conversations/scope.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { CLOSED_IN_GAME, newGameTurnState, resolveGameScope } from '../../src/voice/game-tools.ts';
import { prepareToolPolicyFilter } from '../../src/tools/policy.ts';

// The turn agent's DB-bound helpers are replaced: the tests drive the scope and game branches directly.
vi.mock('../../src/voice/game-tools.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/voice/game-tools.ts')>()),
  resolveGameScope: vi.fn(),
}));
vi.mock('../../src/tools/policy.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/tools/policy.ts')>()),
  prepareToolPolicyFilter: vi.fn(async () => (tools: Record<string, Tool>) => tools),
}));
vi.mock('../../src/spaces/store.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/spaces/store.ts')>()),
  ensurePrivateSpace: vi.fn(async () => {
    throw new Error('spaces store unavailable');
  }),
}));

const sse = (part: Record<string, unknown>): string => `data: ${JSON.stringify(part)}\n\n`;
const text = (id: string, delta: string): string[] =>
  [sse({ type: 'text-start', id }), sse({ type: 'text-delta', id, delta }), sse({ type: 'text-end', id })];
const tool = sse({ type: 'tool-output-available', toolCallId: 't1', output: { ok: true, say: 'Toy says, hop!' } });
const finish = [sse({ type: 'finish-step' }), sse({ type: 'finish' }), 'data: [DONE]\n\n'];

/** Feeds the chunks, returning what the reader got (null chunks pass as they are). */
async function run(gate: ReturnType<typeof createGameStreamGate>, chunks: string[]): Promise<string> {
  let out = '';
  for (const chunk of chunks) out += (await gate.push(chunk)) ?? chunk;
  return out + await gate.end();
}

/** The stream's events, sorted: the same set in any order. */
function events(stream: string): string[] {
  return stream.split('\n\n').sort();
}

/** The text a reader assembles from the deltas it saw. */
function shown(stream: string): string {
  return stream.split('\n\n').filter((event) => event.startsWith('data: {'))
    .map((event) => JSON.parse(event.slice(6)) as { type: string; delta?: string })
    .filter((part) => part.type === 'text-delta').map((part) => part.delta).join('');
}

const probe = vi.fn(async () => ({ ok: true }));
const marketingTools = {
  marketing_probe: { description: 'probe', inputSchema: z.object({}), execute: probe },
} as unknown as Record<string, Tool>;
const privateScope = {
  conversationId: 'c1', spaceId: 'space_p', spaceKind: 'private', spaceName: null, spaceArchived: false, archivedAt: null, title: 'Chat',
} as ConversationScope;
// No model and no database: the agent is recorded, and its offered tools are the answer.
const fakeDeps = {
  agent: { create: vi.fn((options: unknown) => ({ options })) },
  deviceSessions: { forAccount: () => [] },
  timersChanged: () => {},
} as unknown as WebChatDeps;

function turnInput(overrides: Partial<BuildAgentInput>): BuildAgentInput {
  return {
    deps: fakeDeps,
    db: {} as Db,
    userId: 'u1',
    conversationId: 'c1',
    turnId: 't1',
    surface: 'web_text',
    agentSignal: new AbortController().signal,
    reads: startAgentReads({ deps: fakeDeps, db: {} as Db, userId: 'u1', conversationId: 'c1', timeZone: 'UTC', timings: {} }),
    waits: {},
    toolGate: Promise.resolve(),
    scope: privateScope,
    retrieval: null,
    block: null,
    userMessageAnchor: 'm1',
    timeZone: 'UTC',
    onGameTurn: () => {},
    ...overrides,
  };
}

async function offeredFor(overrides: Partial<BuildAgentInput>): Promise<Record<string, Tool>> {
  return (await buildTurnAgent(turnInput(overrides))).offeredToolMap;
}

describe('marketing tools on the turn agent (U5a)', () => {
  beforeEach(() => {
    probe.mockClear();
    vi.mocked(fakeDeps.agent.create).mockClear();
    vi.mocked(resolveGameScope).mockResolvedValue({ mode: 'none', tools: {}, turn: newGameTurnState() } as never);
  });

  it('offers the marketing tools on a live private conversation with a persisted anchor', async () => {
    expect(await offeredFor({ appTools: marketingTools })).toHaveProperty('marketing_probe');
  });

  it.each([
    ['a pair space', { ...privateScope, spaceKind: 'pair' }],
    ['a group space', { ...privateScope, spaceKind: 'group' }],
    ['no conversation scope', null],
    ['an archived space', { ...privateScope, spaceArchived: true }],
    ['an archived conversation', { ...privateScope, archivedAt: 1_700_000_000_000 }],
  ] as const)('offers none on %s', async (_label, scope) => {
    expect(await offeredFor({ scope: scope as ConversationScope | null, appTools: marketingTools })).not.toHaveProperty('marketing_probe');
  });

  it('offers none without a persisted user message anchor', async () => {
    expect(await offeredFor({ userMessageAnchor: null, appTools: marketingTools })).not.toHaveProperty('marketing_probe');
  });

  it('offers none while a game is active, and none when the denied path passes no tools', async () => {
    vi.mocked(resolveGameScope).mockResolvedValueOnce({ mode: 'active', tools: {}, turn: newGameTurnState() } as never);
    expect(await offeredFor({ appTools: marketingTools })).not.toHaveProperty('marketing_probe');
    expect(await offeredFor({})).not.toHaveProperty('marketing_probe');
  });

  it('offers none on a live private scope whose space id is null', async () => {
    expect(await offeredFor({ scope: { ...privateScope, spaceId: null } as ConversationScope, appTools: marketingTools })).not.toHaveProperty(
      'marketing_probe',
    );
  });

  it('never restores a marketing tool that the source policy filter excludes', async () => {
    vi.mocked(prepareToolPolicyFilter).mockResolvedValueOnce((tools: Record<string, Tool>) =>
      Object.fromEntries(Object.entries(tools).filter(([name]) => name !== 'marketing_probe')),
    );
    const offered = await offeredFor({ appTools: marketingTools });
    expect(offered).not.toHaveProperty('marketing_probe');
    expect(offered).toHaveProperty('currentDateTime');
  });

  it('gives a degraded fallback agent no marketing tools, even when they were provided', async () => {
    vi.mocked(fakeDeps.agent.create).mockImplementationOnce(() => {
      throw new Error('agent setup failed');
    });
    const built = await buildTurnAgent(turnInput({ appTools: marketingTools }));
    expect(vi.mocked(fakeDeps.agent.create).mock.calls).toHaveLength(2);
    expect(built.offeredToolMap).toEqual({});
    const fallback = vi.mocked(fakeDeps.agent.create).mock.calls[1]?.[0] as Record<string, unknown>;
    expect(fallback).not.toHaveProperty('capabilityTools');
    expect(fallback).not.toHaveProperty('lateTools');
  });

  it('runs the marketing tools until a game opens mid-turn, then refuses them', async () => {
    const turn = newGameTurnState();
    vi.mocked(resolveGameScope).mockResolvedValueOnce({ mode: 'none', tools: {}, turn } as never);
    const run = (await offeredFor({ appTools: marketingTools })).marketing_probe!.execute!;
    const options = { toolCallId: 't1', messages: [] } as never;
    expect(await run({}, options)).toEqual({ ok: true });
    turn.gameTurn = true;
    expect(await run({}, options)).toEqual(CLOSED_IN_GAME);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('Marketing workflow task context on the turn agent', () => {
  const workflowTools: Record<string, Tool> = {
    marketing_context: { description: 'Reads authorized Marketing context', inputSchema: z.object({}), execute: probe },
  };
  const taskContext = marketingTaskContext('posts');
  const contextToolNames = [...marketingToolNames];
  const recordedOptions = (): Record<string, unknown> => vi.mocked(fakeDeps.agent.create).mock.calls.at(-1)?.[0] as Record<string, unknown>;

  beforeEach(() => {
    vi.mocked(fakeDeps.agent.create).mockClear();
    vi.mocked(resolveGameScope).mockResolvedValue({ mode: 'none', tools: {}, turn: newGameTurnState() } as never);
  });

  it.each(['posts', 'campaign'] as const)('passes typed %s context separately from personal memory', async (intent) => {
    const context = marketingTaskContext(intent);
    await buildTurnAgent({ ...turnInput({ appTools: workflowTools, block: 'Existing private memory' }), taskContext: context, contextToolNames });
    expect(recordedOptions().taskContext).toEqual(context);
    expect(recordedOptions().memoryContext).toBe('Existing private memory');
    expect(Object.keys(recordedOptions().taskContext as object).sort()).toEqual(['lines', 'title']);
    // The rendered section is byte-identical to the pre-extension text (spec 015 U1).
    const focus = intent === 'posts'
      ? 'Build posts: favor creative drafting for the selected network and save requested drafts.'
      : 'Plan campaign: favor strategy and campaign planning, and save requested plan sections.';
    expect(taskContextText(context)).toBe(`[Active task]\nBob Marketing. ${focus}\nExplicit user instructions take precedence over this convenience context. Use only offered tools; this does not grant permissions.\n[End active task]`);
  });

  it.each([
    ['pair', { ...privateScope, spaceKind: 'pair' }],
    ['group', { ...privateScope, spaceKind: 'group' }],
    ['missing scope', null],
    ['unscoped private conversation', { ...privateScope, spaceId: null }],
    ['archived conversation', { ...privateScope, archivedAt: 1_700_000_000_000 }],
    ['archived space', { ...privateScope, spaceArchived: true }],
  ] as const)('omits task context for %s', async (_label, scope) => {
    await buildTurnAgent({ ...turnInput({ scope: scope as ConversationScope | null, appTools: workflowTools }), taskContext, contextToolNames });
    expect(recordedOptions()).not.toHaveProperty('taskContext');
  });

  it('omits task context without a persisted user anchor or an offered Marketing map', async () => {
    await buildTurnAgent({ ...turnInput({ userMessageAnchor: null, appTools: workflowTools }), taskContext, contextToolNames });
    expect(recordedOptions()).not.toHaveProperty('taskContext');
    await buildTurnAgent({ ...turnInput({}), taskContext, contextToolNames });
    expect(recordedOptions()).not.toHaveProperty('taskContext');
    await buildTurnAgent({ ...turnInput({ appTools: marketingTools }), taskContext, contextToolNames });
    expect(recordedOptions()).not.toHaveProperty('taskContext');
    await buildTurnAgent({ ...turnInput({ appTools: workflowTools }) });
    expect(recordedOptions()).not.toHaveProperty('taskContext');
  });

  it('does not restore task context when policy removes the Marketing capability', async () => {
    vi.mocked(prepareToolPolicyFilter).mockResolvedValueOnce((tools: Record<string, Tool>) =>
      Object.fromEntries(Object.entries(tools).filter(([name]) => name !== 'marketing_context')),
    );
    await buildTurnAgent({ ...turnInput({ appTools: workflowTools }), taskContext, contextToolNames });
    expect(recordedOptions()).not.toHaveProperty('taskContext');
  });

  it('omits task context for active games and degraded construction', async () => {
    vi.mocked(resolveGameScope).mockResolvedValueOnce({ mode: 'active', tools: {}, turn: newGameTurnState() } as never);
    await buildTurnAgent({ ...turnInput({ appTools: workflowTools }), taskContext, contextToolNames });
    expect(recordedOptions()).not.toHaveProperty('taskContext');
    vi.mocked(prepareToolPolicyFilter).mockRejectedValueOnce(new Error('policy unavailable'));
    await buildTurnAgent({ ...turnInput({ appTools: workflowTools }), taskContext, contextToolNames });
    expect(recordedOptions()).not.toHaveProperty('taskContext');
    expect(recordedOptions()).not.toHaveProperty('capabilityTools');
  });
});

describe('web game stream gate (finding 2)', () => {
  it('a normal turn streams every chunk unchanged and never checks', async () => {
    const check = vi.fn(async (t: string) => t);
    const gate = createGameStreamGate(() => false, check);
    for (const chunk of [...text('0', 'Remind you to buy milk at 5.'), ...finish]) expect(await gate.push(chunk)).toBeNull();
    expect(await gate.end()).toBe('');
    expect(check).not.toHaveBeenCalled();
  });

  it('an invented command is never shown: the reader gets the checked text only', async () => {
    const check = vi.fn(async () => 'Toy says, hop!');
    const out = await run(createGameStreamGate(() => true, check), [...text('0', 'Toy says, flap like a bird!'), ...finish]);
    expect(out).not.toContain('flap');
    expect(shown(out)).toBe('Toy says, hop!');
    expect(check).toHaveBeenCalledExactlyOnceWith('Toy says, flap like a bird!');
    expect(out.indexOf('hop')).toBeLessThan(out.indexOf('"type":"finish"'));
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('a reply that passes is sent as the model wrote it, released before finish', async () => {
    const chunks = [tool, ...text('0', 'Great! Toy says, hop!'), ...finish];
    const out = await run(createGameStreamGate(() => true, async (t) => t), chunks);
    expect(events(out)).toEqual(events(chunks.join('')));
    expect(shown(out)).toBe('Great! Toy says, hop!');
    expect(out.indexOf('text-end')).toBeLessThan(out.indexOf('"type":"finish"'));
  });

  it('a game started mid-turn holds only the text after it', async () => {
    let started = false;
    const gate = createGameStreamGate(() => started, async () => "Let's play! Toy says, hop!");
    let out = '';
    for (const chunk of text('0', "Let's play! ")) out += (await gate.push(chunk)) ?? chunk;
    started = true;
    for (const chunk of [tool, ...text('1', 'Toy says, spin!'), ...finish]) out += (await gate.push(chunk)) ?? chunk;
    out += await gate.end();
    expect(out).not.toContain('spin');
    expect(shown(out)).toBe("Let's play! Toy says, hop!");
  });

  it('an event split across chunks is sent once and whole', async () => {
    const whole = [...text('0', 'Toy says, hop!'), ...finish].join('');
    const halves = [whole.slice(0, 17), whole.slice(17, 60), whole.slice(60)];
    const out = await run(createGameStreamGate(() => true, async (t) => t), halves);
    expect(events(out)).toEqual(events(whole));
    expect(shown(out)).toBe('Toy says, hop!');
  });
});
