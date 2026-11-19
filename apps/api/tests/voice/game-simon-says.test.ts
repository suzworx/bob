// Simon Says (epic #460, unit G5; tool-contracts.md section 2): the trick rate,
// no two tricks in a row for 'little', the round end (12 commands or one player
// left), the whole-room confession, calm-only commands in quiet hours, seeded
// determinism, the 'little' copy rule, and a full round through the bound tools
// on a per-file database, and the S1 guard advancing a round the model tried to
// make up. No model, no network (the live proof is opt-in).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolLoopAgent, type Tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { type Band, type GameCallbacks, type GameSnapshot, type Player, offScriptGameReply, getGame } from '@bob/ai';
import { agentStopWhen, mulberry32, COMMANDS_PER_ROUND, commandLine, initSimon, openCommand, reduceSimon, saySimon, SIMON_CUES, SIMON_PACK, simonHostNotes, SIMON_SAYS_META, simonScores, simonTools, type SimonAction, type SimonState, type SimonStep } from '@bob/ai/testing';
import type { Db } from '../../src/platform/db/db.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { currentGame, getGameSession } from '../../src/voice/games-store.ts';
import { guardGameReply, resolveGameScope, type GameScope } from '../../src/voice/game-tools.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { liveGameAgent } from '../support/live-game-turn.ts';

const NEXT: SimonAction = { type: 'next' };

function players(band: Band, n = 1): Player[] {
  return Array.from({ length: n }, (_, i) => ({ name: ['Maya', 'Leo', 'Ava'][i] ?? `P${i}`, band }));
}

function start(seed: number, band: Band, n = 1, quiet = false): SimonState {
  return initSimon({ players: players(band, n), teams: false, band }, mulberry32(seed), quiet);
}

function run(s: SimonState, actions: SimonAction[], quiet = false): SimonStep[] {
  const steps: SimonStep[] = [];
  for (const action of actions) { const step = reduceSimon(s, action, quiet); steps.push(step); s = step.state; }
  return steps;
}

/** A full round of 12 commands: the start plus 11 simon_next. */
function round(seed: number, band: Band, quiet = false): SimonState[] {
  const first = start(seed, band, 2, quiet);
  return [first, ...run(first, Array.from({ length: COMMANDS_PER_ROUND - 1 }, () => NEXT), quiet).map((step) => step.state)];
}

describe('command balance', () => {
  it.each(['little', 'kid', 'grown'] as const)('about 30%% tricks for %s (within 5 points over 1,000 seeds)', (band) => {
    let tricks = 0;
    let total = 0;
    for (let seed = 0; seed < 1000; seed++) {
      const states = round(seed, band);
      tricks += states.filter((s) => !s.simon).length;
      total += states.length;
    }
    expect(total).toBe(12_000);
    expect(tricks / total).toBeGreaterThanOrEqual(0.25);
    expect(tricks / total).toBeLessThanOrEqual(0.35);
  });

  it("never two tricks in a row for 'little', even across a catch", () => {
    for (let seed = 0; seed < 1000; seed++) {
      const first = start(seed, 'little', 3);
      const steps = run(first, [NEXT, NEXT, { type: 'caught', players: [2] }, NEXT, NEXT, NEXT, NEXT, NEXT, NEXT]);
      const flags = [first, ...steps.map((step) => step.state)].map((s) => s.simon);
      for (let i = 1; i < flags.length; i++) expect(flags[i - 1] || flags[i], `seed ${seed} at ${i}`).toBe(true);
    }
  });

  it('never repeats a command within a round and stays inside the band', () => {
    for (let seed = 0; seed < 200; seed++) {
      const last = round(seed, 'little').at(-1)!;
      expect(new Set(last.used).size).toBe(COMMANDS_PER_ROUND);
      for (const i of last.used) expect(SIMON_PACK.commands[i]!.band).toBe('little');
    }
  });

  it('in quiet hours only calm commands are used', () => {
    let loud = 0;
    for (let seed = 0; seed < 300; seed++) {
      for (const band of ['little', 'kid', 'grown'] as const) {
        for (const i of round(seed, band, true).at(-1)!.used) expect(SIMON_PACK.commands[i]!.calm).toBe(true);
        loud += round(seed, band).at(-1)!.used.filter((i) => !SIMON_PACK.commands[i]!.calm).length;
      }
    }
    expect(loud).toBeGreaterThan(0);
  });

  it('is deterministic by seed', () => {
    expect(round(42, 'kid')).toEqual(round(42, 'kid'));
    expect(round(42, 'kid').at(-1)!.used).not.toEqual(round(43, 'kid').at(-1)!.used);
  });
});

describe('round end', () => {
  it('ends after 12 commands on the next simon_next, and those still in are champions', () => {
    const states = round(7, 'kid');
    expect(states.at(-1)!.count).toBe(12);
    const end = reduceSimon(states.at(-1)!, NEXT);
    expect(end).toMatchObject({ result: 'ended', ended: true });
    expect(simonScores(end.state)).toEqual([12, 12]);
    expect(saySimon(states.at(-1)!, end, players('kid', 2))).toMatch(/That's all 12 commands! Our Simon champions are Maya and Leo! Play again\?$/);
  });

  it('ends when one player is left, naming only the champion', () => {
    const first = start(3, 'kid', 3);
    const [a, b] = run(first, [{ type: 'caught', players: [0] }, { type: 'caught', players: [2] }]);
    expect(a).toMatchObject({ ended: false, caught: [0] });
    expect(b).toMatchObject({ ended: true, caught: [2] });
    expect(simonScores(b!.state)).toEqual([0, 2, 1]);
    expect(saySimon(a!.state, b!, players('kid', 3))).toMatch(/Ava, you're out this round\..*Our Simon champion is\.\.\. Leo! Play again\?$/);
  });

  it('a no-name confession counts for the whole room; solo, one catch ends the round', () => {
    const group = reduceSimon(start(5, 'little', 2), { type: 'caught', players: 'all' });
    expect(group).toMatchObject({ ended: true, caught: [0, 1] });
    expect(saySimon(start(5, 'little', 2), group, players('little', 2))).toContain('Simon tricked everybody');
    expect(reduceSimon(start(5, 'little', 1), { type: 'caught', players: 'all' })).toMatchObject({ ended: true, caught: [0] });
  });
});

describe("'little' copy never says wrong or no", () => {
  it('on every path: commands, catches on a trick or a Simon command, every ending', () => {
    const says: string[] = [];
    for (let seed = 0; seed < 100; seed++) {
      for (const n of [1, 2, 3]) {
        const paths: SimonAction[][] = [
          Array.from({ length: COMMANDS_PER_ROUND }, () => NEXT),
          [NEXT, { type: 'caught', players: [0] }, NEXT, { type: 'caught', players: [1] }],
          [NEXT, NEXT, { type: 'caught', players: 'all' }],
        ];
        for (const path of paths) {
          let s = start(seed, 'little', n);
          for (const action of path) {
            const step = reduceSimon(s, action);
            says.push(saySimon(s, step, players('little', n)));
            if (step.ended) break;
            s = step.state;
          }
        }
      }
    }
    expect(says.length).toBeGreaterThan(1000);
    for (const say of says) expect(say).not.toMatch(/\b(wrong|no)\b/i);
  });
});

type Out = Record<string, unknown> & { ok: boolean; say: string; reason?: string; host_notes?: string; view?: Record<string, unknown> };
async function call(tools: Record<string, Tool>, name: string, input: unknown = {}): Promise<Out> {
  const exec = tools[name]?.execute as ((i: unknown, o: unknown) => Promise<Out>) | undefined;
  if (exec === undefined) throw new Error(`tool ${name} not in scope`);
  return exec(input, { toolCallId: 't1', messages: [] });
}

describe('the quiet-hours hook on the tools', () => {
  it('a bound quiet() serves only calm commands', async () => {
    let snap: GameSnapshot<SimonState> = { game: 'simon_says', seed: 1, players: players('kid', 2), turnIndex: 0, scores: [0, 0], state: start(9, 'kid', 2, true), version: 1 };
    const cb: GameCallbacks<SimonState> = {
      current: async () => snap,
      commit: async (next) => { snap = { ...snap, state: next.state, scores: next.scores, version: snap.version + 1 }; return snap; },
      speaker: () => null,
    };
    const tools = simonTools(cb, { quiet: () => true });
    for (let i = 0; i < COMMANDS_PER_ROUND - 1; i++) expect(await call(tools, 'simon_next')).toMatchObject({ ok: true });
    expect(snap.state.used).toHaveLength(12);
    for (const i of snap.state.used) expect(SIMON_PACK.commands[i]!.calm).toBe(true);
  });
});

const T0 = Date.parse('2030-01-01T12:00:00Z');
let pg: TestDb;
let db: Db;
let clock = T0;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});
afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

async function fresh(): Promise<{ userId: string; conversationId: string; scope: () => Promise<GameScope> }> {
  const { userId } = await addAccount(pg);
  const { id: conversationId } = await createConversation(db, userId, 'Simon time');
  clock = T0;
  const scope = (): Promise<GameScope> => resolveGameScope(db, userId,
    { conversationId, deviceId: null, timeZone: 'UTC', now: () => clock, seed: () => 1234 });
  return { userId, conversationId, scope };
}

async function tick(f: Awaited<ReturnType<typeof fresh>>): Promise<Record<string, Tool>> {
  clock += 10_000;
  const scope = await f.scope();
  expect(scope.mode).toBe('active');
  return scope.tools;
}

describe('a full round through the bound tools', () => {
  it('is registered as a real game for list_games', () => {
    expect(getGame('simon_says')).toMatchObject({ title: 'Simon Says', definition: { id: 'simon_says' } });
  });

  it('two players: start speaks command 1, three more, Leo is caught, Maya is champion; stored and emptied', async () => {
    const f = await fresh();
    const started = await call((await f.scope()).tools, 'start_game', { game: 'simon_says', players: [{ name: 'Maya', band: 'little' }, { name: 'Leo', band: 'little' }] });
    const opened = (await currentGame(db, f.userId, f.conversationId, clock))!;
    expect(started).toMatchObject({ ok: true, view: { game: 'simon_says', status: 'prompt', progress: { n: 1, of: 12 } } });
    expect(started.say).toBe(`Let's play Simon Says! ${commandLine(opened.state as SimonState)}`);
    for (let n = 2; n <= 4; n++) {
      const next = await call(await tick(f), 'simon_next');
      const s = (await currentGame(db, f.userId, f.conversationId, clock))!.state as SimonState;
      expect(next).toMatchObject({ ok: true, speak_verbatim: true, expect_reply: true, view: { progress: { n } } });
      expect(next.say.endsWith(commandLine(s))).toBe(true);
      expect(openCommand(s).band).toBe('little');
    }
    expect(await call(await tick(f), 'simon_caught', { players: ['Zed'] })).toMatchObject({ ok: false, reason: 'bad_input' });
    const caught = await call(await tick(f), 'simon_caught', { players: ['leo'] });
    expect(caught).toMatchObject({ ok: true, view: { status: 'ended', scores: [{ name: 'Maya', points: 4 }, { name: 'Leo', points: 3 }] } });
    expect(caught.say).toMatch(/Leo, you're out this round\..*Our Simon champion is\.\.\. Maya! Play again\?$/);
    expect(await getGameSession(db, f.userId, opened.id, clock)).toMatchObject({ status: 'ended', players: [], scores: [4, 3] });
    expect((await f.scope()).mode).toBe('none');
  });

  it('solo: 12 commands then simon_next ends the round with 12 points', async () => {
    const f = await fresh();
    await call((await f.scope()).tools, 'start_game', { game: 'simon_says' });
    for (let n = 2; n <= 12; n++) expect(await call(await tick(f), 'simon_next')).toMatchObject({ ok: true, view: { progress: { n } } });
    const end = await call(await tick(f), 'simon_next');
    expect(end).toMatchObject({ ok: true, view: { status: 'ended', scores: [{ points: 12 }] } });
    expect(end.say).toMatch(/You're a Simon champion! Play again\?$/);
  });
});

describe('host notes keep every command on the tools (S1, correction c3)', () => {
  it('after a trick, and after a catch that opens a trick, the note sends the model to a tool and forbids composing', () => {
    let tricks = 0;
    for (let seed = 0; seed < 200; seed++) {
      let s = start(seed, 'kid', 3);
      for (const action of [NEXT, { type: 'caught', players: [0] } as SimonAction, NEXT, NEXT]) {
        const step = reduceSimon(s, action);
        const note = simonHostNotes(step);
        expect(note.length).toBeLessThanOrEqual(300);
        if (step.ended) { expect(note).toContain('play_again'); break; }
        expect(note).toContain("You never create Simon commands");
        if (!step.state.simon) { tricks++; expect(note).toMatch(/call simon_next if nobody says they moved/); }
        s = step.state;
      }
    }
    expect(tricks).toBeGreaterThan(50);
  });
});

describe('the S1 guard on a real round (correction c4: wired into the reply path)', () => {
  const journal = (): void => undefined;
  const open = async (f: Awaited<ReturnType<typeof fresh>>): Promise<SimonState> =>
    (await currentGame(db, f.userId, f.conversationId, clock))!.state as SimonState;

  it('registers the "Simon says" cue and simon_next as the next-prompt tool', () => {
    expect(SIMON_SAYS_META.cues).toEqual(SIMON_CUES);
    expect(getGame('simon_says')).toMatchObject({ cues: ['Simon says'], advance: 'simon_next' });
  });

  it('keeps the start say, replaces a made-up command with the next one from the pack, and an extra one with the tool say', async () => {
    const f = await fresh();
    const first = await f.scope();
    const started = await call(first.tools, 'start_game', { game: 'simon_says', players: [{ name: 'Maya', age: 5 }, { name: 'Leo', age: 6 }] });
    expect(first.turn.cues).toEqual(SIMON_CUES);
    expect(await guardGameReply(`Hi Maya and Leo! ${started.say}`, first.turn, journal)).toBe(`Hi Maya and Leo! ${started.say}`);

    // No tool call, an invented command: the server gives the pack's next command instead.
    const invented = 'Great job! Simon says, flap your arms like a big bird!';
    clock += 10_000;
    const turn = (await f.scope()).turn;
    const count = (await open(f)).count;
    const said = await guardGameReply(invented, turn, journal);
    const after = await open(f);
    expect(after.count).toBe(count + 1);
    expect(said).not.toBe(invented);
    expect(said.endsWith(commandLine(after))).toBe(true);

    // The right tool, plus one more made-up command: only the tool's say is spoken.
    clock += 10_000;
    const third = await f.scope();
    const next = await call(third.tools, 'simon_next');
    expect(await guardGameReply(`${next.say} Simon says, spin around!`, third.turn, journal)).toBe(next.say);
    expect((await open(f)).count).toBe(count + 2);
  });

  // GAMES-GUARD finding 3: a cue counts only in a command's shape, never as the game's name.
  it('a reply that only names the game is on script and leaves the round where it was', async () => {
    for (const mention of [
      "We're playing Simon Says!", "Let's play Simon Says again with Leo.", 'Only move when you hear "Simon says"!',
      'Great job! That is how you play "Simon Says".', 'Time for Simon Says. Ready?',
    ]) expect(offScriptGameReply(mention, [], SIMON_CUES), mention).toBe(false);
    const f = await fresh();
    await call((await f.scope()).tools, 'start_game', { game: 'simon_says', players: [{ name: 'Maya', age: 5 }] });
    clock += 10_000;
    const count = (await open(f)).count;
    const title = "Yay, we're playing Simon Says! Ready for more?";
    expect(await guardGameReply(title, (await f.scope()).turn, journal)).toBe(title);
    expect((await open(f)).count).toBe(count);
  });

  it('a real invented command is off script, with or without the pack separator', () => {
    for (const invented of [
      'Simon says wiggle your ears!', 'Great job! Simon says, spin around!', 'Okay. simon SAYS: hop on one foot',
      'And Simon says, flap your arms!', 'Ready? Simon says touch the sky.',
    ]) expect(offScriptGameReply(invented, [], SIMON_CUES), invented).toBe(true);
    const given = 'Simon says, touch your nose!';
    expect(offScriptGameReply(`Nice! ${given}`, [given], SIMON_CUES)).toBe(false);
  });
});

// Live proof (opt-in): BOB_LIVE_SIMON=1 BOB_CHAT_MODEL=anthropic/claude-haiku-5.5 with AI_GATEWAY_API_KEY.
// Each turn runs the production one-step path (the scope's [Game turn] context and stopWhen, as generate.ts
// wires them, and only the active game's tools) and records its model steps; a play turn must be one step.
// The same scripted family (Maya and Leo; Leo owns up on the 2nd trick) plays 3 rounds in a row, each in a
// fresh conversation. Each reply goes through guardGameReply, the real reply path, and the history keeps
// only the guarded text, as turn.ts does. A turn is right when the expected tool ran (and not the other Simon
// tool), or when the guard replaced a made-up command with simon_next's. Written to $TMP/bob-live-simon.json.
describe.runIf(process.env.BOB_LIVE_SIMON === '1')('live: a scripted family plays 3 Simon Says rounds', () => {
  it('drives the real model through the game, 18/18 turns right, one model step per play turn', async () => {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const usage = { input: 0, output: 0, cost: 0 };
    const runs: Array<Array<Record<string, unknown>>> = [];
    for (let r = 0; r < 3; r++) {
      const f = await fresh();
      let messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      const log: Array<Record<string, unknown>> = [];
      const state = async (): Promise<SimonState | null> =>
        (await currentGame(db, f.userId, f.conversationId, clock))?.state as SimonState | null ?? null;
      const say = async (text: string, expected: string | null): Promise<void> => {
        clock += 15_000;
        const scope = await f.scope();
        const agent = liveGameAgent(scope);
        messages = [...messages, { role: 'user', content: text }];
        const result = await agent.generate({ messages } as never);
        usage.input += result.totalUsage.inputTokens ?? 0;
        usage.output += result.totalUsage.outputTokens ?? 0;
        for (const step of result.steps) {
          const cost = Number((step.providerMetadata as { gateway?: { cost?: string } } | undefined)?.gateway?.cost ?? 0);
          usage.cost += Number.isFinite(cost) ? cost : 0;
        }
        const calls = result.steps.flatMap((step) => step.toolCalls.map((c) => ({ tool: c.toolName, input: c.input })));
        const says = [...scope.turn.says];
        const events: Array<Record<string, string | number>> = [];
        const spoken = await guardGameReply(result.text, scope.turn, (_event, fields) => { events.push(fields); });
        messages = [...messages, { role: 'assistant', content: spoken }];
        const advanced = events.some((e) => (e.reason === 'off_script' || e.reason === 'no_tool') && e.advanced === 1);
        // Both Simon tools in one turn make one move, the first one called: that one must be the expected tool.
        const move = calls.find((c) => c.tool === 'simon_next' || c.tool === 'simon_caught')?.tool;
        const called = expected === 'simon_next' || expected === 'simon_caught' ? move === expected : calls.some((c) => c.tool === expected);
        const right = expected === null ? !calls.some((c) => c.tool === 'play_again' || c.tool === 'start_game')
          : called || (expected === 'simon_next' && calls.length === 0 && advanced);
        const after = await state();
        log.push({
          user: text, mode: scope.mode, one_step: scope.oneStep !== undefined, steps: result.steps.length, expected, calls, says,
          open: after === null ? null : { n: after.count, text: openCommand(after).text, simon: after.simon },
          off_script: offScriptGameReply(result.text, says, SIMON_CUES), guard: events, advanced,
          verdict: right ? (called || expected === null ? 'pass' : 'pass (guard)') : 'FAIL',
          model_reply: result.text.slice(0, 300), spoken: spoken.slice(0, 300),
        });
      };
      await say("Let's play Simon says! It's me Maya and my brother Leo.", 'start_game');
      let tricks = 0;
      for (let turn = 0; turn < 16; turn++) {
        const s = await state();
        if (s === null) break;
        if (s.simon) await say('Done! We did it.', 'simon_next');
        else if (++tricks === 1) await say("Ha, we didn't move! You can't trick us.", 'simon_next');
        else await say('Oops! Leo moved.', 'simon_caught');
      }
      await say('No thanks, bye bye!', null);
      runs.push(log);
    }
    const cost = usage.cost > 0 ? usage.cost : (usage.input * 0.3 + usage.output * 2.5) / 1e6;
    writeFileSync(join(tmpdir(), 'bob-live-simon.json'), JSON.stringify({ model: process.env.BOB_CHAT_MODEL, usage, cost, runs }, null, 2));
    expect(cost).toBeLessThan(0.15);
    for (const log of runs) expect(log.map((t) => String(t.verdict).startsWith('pass'))).toEqual(log.map(() => true));
    const play = runs.flat().filter((t) => t.one_step === true && (t.expected === 'simon_next' || t.expected === 'simon_caught'));
    expect(play.map((t) => t.steps)).toEqual(play.map(() => 1));
  }, 900_000);
});

// RCA root cause 2 (docs/voice-latency-rca.md): a Simon turn was two model calls, the tool call and then the
// line. The active scope now carries the lines the game tools would return, so the model calls the tool and
// speaks its line in the same message, and the loop ends after that tool. Mock model only: no network.
describe('one model step per Simon turn', () => {
  const journal = (): void => undefined;
  const USAGE = {
    inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0, text: 2, reasoning: 0 },
    totalTokens: 6,
  };
  type Step = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
  const toolStep = (text: string, toolName: string, input: unknown = {}): Step => ({
    content: [...(text === '' ? [] : [{ type: 'text' as const, text }]), { type: 'tool-call' as const, toolCallId: 'c1', toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: USAGE, warnings: [],
  });
  const textStep = (text: string): Step => ({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'end_turn' }, usage: USAGE, warnings: [] });
  const state = async (f: Awaited<ReturnType<typeof fresh>>): Promise<SimonState> =>
    (await currentGame(db, f.userId, f.conversationId, clock))!.state as SimonState;

  /** One device turn as generate.ts runs it: the scope's tools, its context and stop condition, then the guard. */
  async function turn(
    scope: GameScope, steps: Step[], log: (event: string, fields: Record<string, string | number>) => void = journal, forced = true,
  ): Promise<{ reply: string; calls: number; context: string; firstTools: string[] }> {
    const model = new MockLanguageModelV4({ doGenerate: [...steps, textStep('unused')] });
    const oneStep = scope.oneStep;
    const agent = new ToolLoopAgent({
      model, tools: scope.tools, instructions: oneStep?.context ?? '',
      stopWhen: oneStep === undefined ? agentStopWhen : [agentStopWhen, oneStep.stopWhen],
      ...(oneStep === undefined || !forced ? {} : { prepareStep: oneStep.prepareStep }),
    });
    const result = await agent.generate({ prompt: 'done!' });
    const firstTools = (model.doGenerateCalls[0]?.tools ?? []).map((t) => t.name).sort();
    return { reply: await guardGameReply(result.text, scope.turn, log), calls: model.doGenerateCalls.length, context: oneStep?.context ?? '', firstTools };
  }

  it('the context names the exact lines simon_next and simon_caught will return, before anything is stored', async () => {
    const f = await fresh();
    await call((await f.scope()).tools, 'start_game', { game: 'simon_says', players: [{ name: 'Maya', age: 5 }] });
    clock += 10_000;
    const scope = await f.scope();
    const before = await state(f);
    expect(scope.oneStep?.context).toBeDefined();
    expect(await state(f)).toEqual(before);
    const next = await call(scope.tools, 'simon_next');
    expect(scope.oneStep!.context).toContain(next.say);
    clock += 10_000;
    const later = await f.scope();
    const caught = await call(later.tools, 'simon_caught');
    expect(later.oneStep!.context).toContain(caught.say);
  });

  it('the model calls simon_next and speaks its line in the same message: one model call, the round moves on', async () => {
    const f = await fresh();
    await call((await f.scope()).tools, 'start_game', { game: 'simon_says', players: [{ name: 'Maya', age: 5 }] });
    clock += 10_000;
    const count = (await state(f)).count;
    const scope = await f.scope();
    const line = reduceSimon(await state(f), NEXT);
    const spoken = saySimon(await state(f), line, players('little'));
    const { reply, calls } = await turn(scope, [toolStep(`Great job! ${spoken}`, 'simon_next')]);
    expect(calls).toBe(1);
    expect(reply).toBe(`Great job! ${spoken}`);
    expect((await state(f)).count).toBe(count + 1);
    expect(reply.endsWith(commandLine(await state(f)))).toBe(true);
  });

  it('a tool call with no words, or with a line the tool did not return, speaks the tool say', async () => {
    const f = await fresh();
    await call((await f.scope()).tools, 'start_game', { game: 'simon_says', players: [{ name: 'Maya', age: 5 }] });
    clock += 10_000;
    const silent = await turn(await f.scope(), [toolStep('', 'simon_next')]);
    expect(silent.calls).toBe(1);
    expect(silent.reply.endsWith(commandLine(await state(f)))).toBe(true);
    clock += 10_000;
    const wrong = await turn(await f.scope(), [toolStep('Great listening! Next one!', 'simon_next')]);
    expect(wrong.calls).toBe(1);
    expect(wrong.reply.endsWith(commandLine(await state(f)))).toBe(true);
  });

  it('with several players a catch is one step too: the model names who moved, and the tool say is spoken', async () => {
    const f = await fresh();
    await call((await f.scope()).tools, 'start_game', { game: 'simon_says', players: [{ name: 'Maya', age: 5 }, { name: 'Leo', age: 6 }, { name: 'Ava', age: 6 }] });
    clock += 10_000;
    const row = (await currentGame(db, f.userId, f.conversationId, clock))!;
    const before = row.state as SimonState;
    const scope = await f.scope();
    // The catch's line names who moved, so the context has no line for it: the tool's say is spoken.
    expect(scope.oneStep!.context).toContain('simon_caught');
    expect(scope.oneStep!.context).not.toContain("you're out this round");
    const said = saySimon(before, reduceSimon(before, { type: 'caught', players: [1] }), row.players);
    const events: Array<Record<string, string | number>> = [];
    const { reply, calls } = await turn(scope, [toolStep('', 'simon_caught', { players: ['Leo'] })], (_e, fields) => { events.push(fields); });
    expect(calls).toBe(1);
    expect(reply).toBe(said);
    expect(reply).toContain("Leo, you're out this round.");
    expect((await state(f)).out).toEqual([null, before.count, null]);
    // A blank reply filled with the say is the designed path, not a replacement.
    expect(events).toEqual([]);
  });

  it('a game tool call that fails its input check keeps a second step, so the turn is never silent', async () => {
    const f = await fresh();
    await call((await f.scope()).tools, 'start_game', { game: 'simon_says', players: [{ name: 'Maya', age: 5 }, { name: 'Leo', age: 6 }] });
    clock += 10_000;
    const count = (await state(f)).count;
    const { reply, calls } = await turn(await f.scope(), [toolStep('', 'simon_caught', { players: ['x'.repeat(40)] }), textStep('Who moved?')]);
    expect(calls).toBe(2);
    expect(reply).toBe('Who moved?');
    expect((await state(f)).count).toBe(count);
  });

  it('a line spoken from the context with no tool call still moves the round on, exactly once', async () => {
    const f = await fresh();
    await call((await f.scope()).tools, 'start_game', { game: 'simon_says', players: [{ name: 'Maya', age: 5 }] });
    for (let i = 0; i < 4; i++) {
      clock += 10_000;
      const before = await state(f);
      const spoken = saySimon(before, reduceSimon(before, NEXT), players('little'));
      // The device turn forces a tool call; this is the guard's net for a reply path that does not.
      const { reply, calls } = await turn(await f.scope(), [textStep(`Yay! ${spoken}`)], journal, false);
      expect(calls).toBe(1);
      expect(reply).toBe(`Yay! ${spoken}`);
      expect((await state(f)).count).toBe(before.count + 1);
    }
  });

  // Live finding (haiku, 2026-10-28): told to call a tool, the model called start_game on "Done! We did it."
  // right after the start, and called simon_caught and simon_next together. The first call offers only the
  // game's moves and controls, and a turn makes one move.
  it("the first model call offers only the game's moves and controls, never start_game or play_again", async () => {
    const f = await fresh();
    await call((await f.scope()).tools, 'start_game', { game: 'simon_says', players: [{ name: 'Maya', age: 5 }] });
    clock += 10_000;
    const { firstTools } = await turn(await f.scope(), [toolStep('', 'simon_next')]);
    expect(firstTools).toEqual(['game_status', 'pause_game', 'simon_caught', 'simon_next', 'stop_game']);
  });

  it('simon_caught and simon_next called together make one move: the catch, with its next command', async () => {
    const f = await fresh();
    await call((await f.scope()).tools, 'start_game', { game: 'simon_says', players: [{ name: 'Maya', age: 5 }, { name: 'Leo', age: 6 }, { name: 'Ava', age: 6 }] });
    clock += 10_000;
    const row = (await currentGame(db, f.userId, f.conversationId, clock))!;
    const before = row.state as SimonState;
    const said = saySimon(before, reduceSimon(before, { type: 'caught', players: [1] }), row.players);
    const both: Step = {
      content: [
        { type: 'tool-call', toolCallId: 'c1', toolName: 'simon_caught', input: JSON.stringify({ players: ['Leo'] }) },
        { type: 'tool-call', toolCallId: 'c2', toolName: 'simon_next', input: '{}' },
      ],
      finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: USAGE, warnings: [],
    };
    const { reply, calls } = await turn(await f.scope(), [both]);
    expect(calls).toBe(1);
    expect(reply).toBe(said);
    expect((await state(f)).count).toBe(before.count + 1);
  });

  // Live finding (haiku, 6 of 6 rounds): after a trick, "we didn't move!" was judged a catch of everyone. The
  // tool's host note says how to judge a trick, but the history keeps only spoken text, so the next turn never
  // saw it: the one-step context carries the open command's host note.
  it("the context carries the open command's host note, so a trick's answer is judged by the game's rule", async () => {
    const f = await fresh();
    await call((await f.scope()).tools, 'start_game', { game: 'simon_says', players: [{ name: 'Maya', age: 7 }, { name: 'Leo', age: 8 }] });
    for (let i = 0; i < COMMANDS_PER_ROUND && (await state(f)).simon; i++) { clock += 10_000; await call((await f.scope()).tools, 'simon_next'); }
    expect((await state(f)).simon).toBe(false);
    clock += 10_000;
    expect((await f.scope()).oneStep!.context).toContain('call simon_next if nobody says they moved, even when nobody moved at all');
  });

  it('a paused game, and no game, carry no one-step context', async () => {
    const f = await fresh();
    expect((await f.scope()).oneStep).toBeUndefined();
    await call((await f.scope()).tools, 'start_game', { game: 'simon_says' });
    await call((await f.scope()).tools, 'pause_game');
    expect((await f.scope()).oneStep).toBeUndefined();
  });
});
