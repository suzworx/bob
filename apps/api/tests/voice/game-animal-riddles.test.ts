// Animal Riddles (epic #460, unit G4; tool-contracts.md section 2): the judging
// table, the pure reducer (reveal, hints, skip), seeded determinism, the
// 'little' copy rule, and a full game through the bound tools on a per-file
// database (start -> 6 riddles -> end). No real model, no network.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolLoopAgent, type Tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { type Band, type Player, getGame } from '@bob/ai';
import { agentStopWhen, mulberry32, initRiddles, judgeGuess, reduceRiddles, riddleById, RIDDLE_PACK, sayStep, type RiddleAction, type RiddlesState } from '@bob/ai/testing';
import type { Db } from '../../src/platform/db/db.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { currentGame, getGameSession } from '../../src/voice/games-store.ts';
import { guardGameReply, resolveGameScope, type GameScope } from '../../src/voice/game-tools.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { liveGameAgent } from '../support/live-game-turn.ts';

const r = (id: string): ReturnType<typeof riddleById> => riddleById(id);

describe('judging table', () => {
  it.each([
    ['elephant', 'elephant', 'correct'], ['an elephant', 'elephant', 'correct'], ['elephants', 'elephant', 'correct'],
    ['elefant', 'elephant', 'correct'], ['Elephant!', 'elephant', 'correct'], ['is it the elephant', 'elephant', 'correct'],
    ['elepant', 'elephant', 'correct'], ['girafe', 'giraffe', 'correct'], ['bunnies', 'rabbit', 'correct'],
    ['a kitty', 'cat', 'correct'], ['puppies', 'dog', 'correct'], ['sea horse', 'seahorse', 'correct'],
    ['hippos', 'hippopotamus', 'correct'], ['octopuses', 'octopus', 'correct'], ['wolves', 'bear', 'wrong'],
    ['tortoise', 'turtle', 'correct'], ['ladybird', 'ladybug', 'correct'], ['polar bears', 'polar_bear', 'correct'],
    ['bear', 'polar_bear', 'close'], ['elphnt', 'elephant', 'close'], ['cat', 'dog', 'wrong'],
    ['bat', 'cat', 'wrong'], ['ct', 'cat', 'wrong'], ['lino', 'lion', 'wrong'], ['a', 'cat', 'wrong'],
  ] as const)('%s for %s is %s', (guess, id, want) => {
    expect(judgeGuess(guess, r(id))).toBe(want);
  });
});

/** A state whose first riddle is `id`, for one player of `band`. */
function stateFor(id: string, band: Band, players = 1): RiddlesState {
  const base = initRiddles({ players: Array.from({ length: players }, (_, i) => ({ name: `P${i}`, band })), teams: false, band }, mulberry32(1));
  return { ...base, riddles: [id, ...base.riddles.filter((x) => x !== id).slice(0, 5)] };
}

function run(s: RiddlesState, actions: RiddleAction[]): ReturnType<typeof reduceRiddles>[] {
  const steps: ReturnType<typeof reduceRiddles>[] = [];
  for (const action of actions) { const step = reduceRiddles(s, action); steps.push(step); s = step.state; }
  return steps;
}

describe('reducer', () => {
  it('the 3rd miss reveals the answer with no penalty and moves on', () => {
    const steps = run(stateFor('elephant', 'little'), [{ type: 'guess', guess: 'cat' }, { type: 'guess', guess: 'dog' }, { type: 'guess', guess: 'cow' }]);
    expect(steps.map((s) => s.result)).toEqual(['wrong', 'wrong', 'revealed']);
    expect(steps[0]!.clue).toBe(r('elephant').clues[1]);
    expect(steps[2]!.state).toMatchObject({ index: 1, shown: 1, misses: 0, stars: [0] });
    expect(sayStep(steps[2]!, [])).toContain('It was an elephant!');
  });

  it('hints: up to 2, free for little; older players lose a star per hint', () => {
    const hint: RiddleAction = { type: 'hint' };
    const little = run(stateFor('cat', 'little'), [hint, hint, hint, { type: 'guess', guess: 'cat' }]);
    expect(little.map((s) => s.result)).toEqual(['hint', 'hint', 'no_more_hints', 'correct']);
    expect(little.map((s) => s.clue)).toEqual([r('cat').clues[1], r('cat').clues[2], undefined, undefined]);
    expect(little[3]!.points).toBe(1);
    const kid = run(stateFor('octopus', 'kid'), [hint, { type: 'guess', guess: 'octopus' }]);
    expect(kid[1]).toMatchObject({ result: 'correct', points: 2 });
    expect(run(stateFor('octopus', 'kid'), [{ type: 'guess', guess: 'octopus' }])[0]!.points).toBe(3);
  });

  it('skip reveals and moves to the next riddle; the 6th closes the game', () => {
    const steps = run(stateFor('cat', 'little'), Array.from({ length: 6 }, (): RiddleAction => ({ type: 'skip' })));
    expect(steps.every((s) => s.result === 'revealed')).toBe(true);
    expect(steps.map((s) => s.ended)).toEqual([false, false, false, false, false, true]);
    expect(sayStep(steps[5]!, [{ name: 'Maya', band: 'little' }])).toMatch(/Play again\?$/);
  });

  it('is deterministic by seed, never repeats a riddle, and serves each player their own band', () => {
    const players: Player[] = [{ name: 'Maya', band: 'little' }, { name: 'Leo', band: 'kid' }];
    const opts = { players, teams: false, band: 'little' as const };
    expect(initRiddles(opts, mulberry32(42))).toEqual(initRiddles(opts, mulberry32(42)));
    expect(initRiddles(opts, mulberry32(42)).riddles).not.toEqual(initRiddles(opts, mulberry32(43)).riddles);
    for (let seed = 0; seed < 200; seed++) {
      const s = initRiddles(opts, mulberry32(seed));
      expect(new Set(s.riddles).size).toBe(6);
      s.riddles.forEach((id, i) => expect(r(id).band).toBe(players[i % 2]!.band));
    }
  });
});

describe("'little' copy never says wrong or no", () => {
  it('on every result path, for every little riddle', () => {
    const players: Player[] = [{ name: 'Maya', band: 'little' }];
    const paths: RiddleAction[][] = [
      [{ type: 'guess', guess: 'zzz' }, { type: 'guess', guess: 'qqq' }, { type: 'guess', guess: 'xxx' }],
      [{ type: 'hint' }, { type: 'hint' }, { type: 'hint' }, { type: 'guess', guess: 'zzz' }],
      [{ type: 'skip' }],
    ];
    const says: string[] = [];
    for (const riddle of RIDDLE_PACK.riddles.filter((x) => x.band === 'little')) {
      for (const path of paths) says.push(...run(stateFor(riddle.id, 'little'), path).map((step) => sayStep(step, players)));
      says.push(sayStep(reduceRiddles(stateFor(riddle.id, 'little'), { type: 'guess', guess: riddle.answer }), players));
      if (riddle.answer.length >= 6) says.push(sayStep(reduceRiddles(stateFor(riddle.id, 'little'), { type: 'guess', guess: riddle.answer.slice(0, -2) }), players));
    }
    const ending = run(stateFor('cat', 'little'), Array.from({ length: 6 }, (): RiddleAction => ({ type: 'guess', guess: 'zzz' })).flatMap((a) => [a, a, a]));
    says.push(...ending.map((step) => sayStep(step, players)));
    expect(says.length).toBeGreaterThan(200);
    for (const say of says) expect(say).not.toMatch(/\b(wrong|no)\b/i);
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

type Out = Record<string, unknown> & { ok: boolean; say: string; reason?: string; expect_reply?: boolean; view?: Record<string, unknown> };
async function call(tools: Record<string, Tool>, name: string, input: unknown = {}): Promise<Out> {
  const exec = tools[name]?.execute as ((i: unknown, o: unknown) => Promise<Out>) | undefined;
  if (exec === undefined) throw new Error(`tool ${name} not in scope`);
  return exec(input, { toolCallId: 't1', messages: [] });
}

async function fresh(): Promise<{ userId: string; conversationId: string; scope: () => Promise<GameScope> }> {
  const { userId } = await addAccount(pg);
  const { id: conversationId } = await createConversation(db, userId, 'Riddle time');
  clock = T0;
  const scope = (): Promise<GameScope> => resolveGameScope(db, userId,
    { conversationId, deviceId: null, timeZone: 'UTC', now: () => clock, seed: () => 1234 });
  return { userId, conversationId, scope };
}

describe('a full game through the bound tools', () => {
  it('is registered as a real game for list_games', () => {
    expect(getGame('animal_riddles')).toMatchObject({ title: 'Animal Riddles', definition: { id: 'animal_riddles' } });
  });

  it('start -> 6 riddles (right, misspelt, hint, 3 misses, skip) -> end, with stars stored and players emptied', async () => {
    const f = await fresh();
    // Maya says she is 6: the server makes that the little band, whatever band the model sends.
    const started = await call((await f.scope()).tools, 'start_game', { game: 'animal_riddles', players: [{ name: 'Maya', age: 6, band: 'kid' }] });
    expect(started).toMatchObject({ ok: true, view: { game: 'animal_riddles', status: 'prompt', progress: { n: 1, of: 6 } } });
    const opened = (await currentGame(db, f.userId, f.conversationId, clock))!;
    const id = opened.id;
    expect(opened.players).toEqual([{ name: 'Maya', band: 'little' }]);
    expect(opened.state).toMatchObject({ tone: 'little' });
    // Riddle 1 is spoken at the start and ends like every later riddle, so a child hears it without a screen.
    const firstClue = riddleById((opened.state as RiddlesState).riddles[0]!).clues[0];
    expect(started.say).toBe(`Let's play Animal Riddles! ${firstClue} Who am I?`);
    const answer = async (): Promise<string> => {
      const row = await currentGame(db, f.userId, f.conversationId, clock);
      const s = row!.state as RiddlesState;
      return riddleById(s.riddles[s.index]!).answer;
    };
    const tools = async (): Promise<Record<string, Tool>> => {
      clock += 20_000;
      const scope = await f.scope();
      expect(scope.mode).toBe('active');
      return scope.tools;
    };
    // 1: right first time.
    const first = await call(await tools(), 'riddle_guess', { guess: await answer() });
    expect(first).toMatchObject({ ok: true, expect_reply: true, speak_verbatim: true, view: { progress: { n: 2 } } });
    expect(first.say).toMatch(/Riddle 2 of 6\..*Who am I\?$/);
    // 2: misspelt (one letter dropped from a long answer is still right; short answers are exact).
    const two = await answer();
    const misspelt = two.length >= 5 ? `${two.slice(0, 2)}${two.slice(3)}` : two;
    expect(await call(await tools(), 'riddle_guess', { guess: `the ${misspelt}s` })).toMatchObject({ ok: true, view: { progress: { n: 3 } } });
    // 3: a hint, then right.
    const hinted = await call(await tools(), 'riddle_hint');
    expect(hinted).toMatchObject({ ok: true, view: { hints: { used: 1, of: 2 } } });
    expect(hinted.say).toMatch(/^Here's another clue/);
    await call(await tools(), 'riddle_guess', { guess: await answer() });
    // 4: three misses reveal it, gently.
    const misses = [];
    for (const guess of ['zzz', 'qqq', 'xxx']) misses.push(await call(await tools(), 'riddle_guess', { guess }));
    expect(misses[0]).toMatchObject({ ok: true, view: { status: 'feedback' } });
    expect(misses[2]!.say).toMatch(/^It was an? /);
    for (const miss of misses) expect(miss.say).not.toMatch(/\b(wrong|no)\b/i);
    // 5: "I don't know" -> skip.
    expect((await call(await tools(), 'riddle_skip')).say).toMatch(/^It was an? .*Riddle 6 of 6/);
    // 6: right, which ends the game.
    const last = await call(await tools(), 'riddle_guess', { guess: await answer() });
    expect(last).toMatchObject({ ok: true, view: { status: 'ended', scores: [{ name: 'Maya', points: 4 }] } });
    expect(last.say).toMatch(/you got 4 stars! Play again\?$/);
    expect(await getGameSession(db, f.userId, id, clock)).toMatchObject({ status: 'ended', players: [], scores: [4] });
    expect((await f.scope()).mode).toBe('none');
  });

  it('in a group, a named answer out of turn is not_your_turn', async () => {
    const f = await fresh();
    await call((await f.scope()).tools, 'start_game', { game: 'animal_riddles', players: [{ name: 'Maya', band: 'little' }, { name: 'Leo', band: 'kid' }] });
    const out = await call((await f.scope()).tools, 'riddle_guess', { guess: 'cat', player: 'Leo' });
    expect(out).toMatchObject({ ok: false, reason: 'not_your_turn' });
    expect(out.say).toContain("Maya's turn");
  });
});

// Live proof (opt-in): BOB_LIVE_RIDDLES=1 BOB_CHAT_MODEL=anthropic/claude-haiku-5.5 with AI_GATEWAY_API_KEY.
// A real agent on the production one-step path (the scope's [Game turn] context and stopWhen, as generate.ts
// wires them; the active game's tools only; the reply through guardGameReply; the history keeps only the
// guarded text) plays 3 riddles against a scripted 6-year-old (right, wrong, hint). Per turn it records the
// model steps, the tool calls and the guard events; a play turn is right when its tool ran (or the guard ran
// it), the reply is not silent, and nothing spoken claims a verdict no tool gave. Written to
// $TMP/bob-live-riddles.json. Default runs skip it: no model, no network.
describe.runIf(process.env.BOB_LIVE_RIDDLES === '1')('live: a scripted 6-year-old plays 3 riddles', () => {
  it('drives the real model through the game, one model step per play turn', async () => {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const f = await fresh();
    let messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    const log: Array<Record<string, unknown>> = [];
    const usage = { input: 0, output: 0, cost: 0 };
    const state = async (): Promise<RiddlesState | null> =>
      (await currentGame(db, f.userId, f.conversationId, clock))?.state as RiddlesState | null ?? null;
    let startSay = '';
    let wrongSay = '';
    const say = async (text: string, expected: string | null): Promise<void> => {
      clock += 15_000;
      const scope = await f.scope();
      const before = await state();
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
      const events: Array<Record<string, string | number>> = [];
      const spoken = await guardGameReply(result.text, scope.turn, (_e, fields) => { events.push(fields); });
      messages = [...messages, { role: 'assistant', content: spoken }];
      const ranByGuard = events.some((e) => e.reason === 'no_tool' && e.advanced === 1);
      const called = expected === null || calls.some((c) => c.tool === expected) || ranByGuard;
      // Invented: a play turn spoken with no game tool say, so the words (a verdict, a clue) are the model's own.
      const invented = expected !== null && scope.mode === 'active' && scope.turn.says.length === 0;
      const silent = spoken.trim() === '';
      const startOut = result.steps.flatMap((s) => s.toolResults).find((r) => r.toolName === 'start_game')?.output as { say?: string } | undefined;
      if (startOut?.say !== undefined) startSay = startOut.say;
      if (/^a (dog|cat)\?$/u.test(text)) wrongSay = scope.turn.says[0] ?? '';
      const after = await state();
      log.push({
        user: text, mode: scope.mode, one_step: scope.oneStep !== undefined, steps: result.steps.length, expected, calls,
        guard: events, riddle: before?.riddles[before.index] ?? null, index_after: after?.index ?? null,
        verdict: called && !invented && !silent ? 'pass' : 'FAIL', invented, silent,
        model_reply: result.text.slice(0, 300), spoken: spoken.slice(0, 300),
      });
    };
    const answer = async (): Promise<string> => { const s = await state(); return riddleById(s!.riddles[s!.index]!).answer; };
    const index = async (): Promise<number> => (await state())?.index ?? 99;

    // The sentence from the real web chat: a 6-year-old says her age, so she must get the little band.
    await say("Let's play animal riddles! I'm Maya and I'm 6.", 'start_game');
    if ((await state()) === null) await say('Yes, animal riddles please!', 'start_game');
    const row = await currentGame(db, f.userId, f.conversationId, clock);
    const startCall = log.flatMap((entry) => entry.calls as Array<{ tool: string; input: unknown }>).find((c) => c.tool === 'start_game');
    // Three riddles: right first time; a wrong answer, then right; a hint, then right.
    const wrongGuess = async (): Promise<string> => ((await answer()) === 'dog' ? 'a cat?' : 'a dog?');
    const plan: Array<Array<[() => Promise<string>, string]>> = [
      [[async () => `${await answer()}!`, 'riddle_guess']],
      [[wrongGuess, 'riddle_guess'], [async () => `${await answer()}`, 'riddle_guess']],
      [[async () => 'Can I have a hint please?', 'riddle_hint'], [async () => `a ${await answer()}!`, 'riddle_guess']],
    ];
    for (let i = 0; i < plan.length; i++) {
      for (const [line, expected] of plan[i]!) {
        if (await index() !== i) break;
        await say(await line(), expected);
      }
      let guard = 0;
      while (await index() === i && guard++ < 2) await say(`${await answer()}`, 'riddle_guess');
    }
    await say("That's enough riddles for today, bye bye!", null);
    const gentle = [...RIDDLE_PACK.copy.encourage.little, ...RIDDLE_PACK.copy.close.little];
    const verdicts = {
      start_age_6: (startCall?.input as { players?: Array<{ age?: number }> } | undefined)?.players?.[0]?.age === 6,
      band_little: row?.players[0]?.band === 'little',
      riddle_1_who_am_i: /Who am I\?$/u.test(startSay),
      wrong_is_gentle: gentle.some((line) => wrongSay.startsWith(line)) && !/\b(wrong|no)\b/iu.test(wrongSay),
    };
    const cost = usage.cost > 0 ? usage.cost : (usage.input * 0.3 + usage.output * 2.5) / 1e6;
    writeFileSync(join(tmpdir(), 'bob-live-riddles.json'), JSON.stringify({ model: process.env.BOB_CHAT_MODEL, usage, cost, verdicts, startSay, wrongSay, log }, null, 2));
    expect(verdicts).toEqual({ start_age_6: true, band_little: true, riddle_1_who_am_i: true, wrong_is_gentle: true });
    expect(log.map((t) => t.verdict)).toEqual(log.map(() => 'pass'));
    const play = log.filter((t) => t.one_step === true && t.expected !== null);
    expect(play.map((t) => t.steps)).toEqual(play.map(() => 1));
    expect(cost).toBeLessThan(0.1);
  }, 600_000);
});

// RCA root cause 2 (docs/voice-latency-rca.md), as for Simon: every riddle turn is one model call. A guess's
// line depends on the server's judgement and riddle_skip's names the answer, so neither line is in the
// context (the answer never reaches the model before it is revealed): the model calls the tool and the
// guard speaks the tool's say. riddle_hint's line is known, so it is spoken from the context. Mock model only.
describe('one model step per riddle turn', () => {
  const USAGE = {
    inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0, text: 2, reasoning: 0 },
    totalTokens: 6,
  };
  type Step = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
  type Journal = (event: string, fields: Record<string, string | number>) => void;
  const toolStep = (text: string, toolName: string, input: unknown = {}): Step => ({
    content: [...(text === '' ? [] : [{ type: 'text' as const, text }]), { type: 'tool-call' as const, toolCallId: 'c1', toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: USAGE, warnings: [],
  });
  const textStep = (text: string): Step => ({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'end_turn' }, usage: USAGE, warnings: [] });
  const state = async (f: Awaited<ReturnType<typeof fresh>>): Promise<RiddlesState> =>
    (await currentGame(db, f.userId, f.conversationId, clock))!.state as RiddlesState;

  /** One device turn as generate.ts runs it: the scope's tools, its context and stop condition, then the guard. */
  async function turn(scope: GameScope, steps: Step[], journal: Journal = () => undefined, forced = true): Promise<{ reply: string; calls: number; choices: unknown[] }> {
    const model = new MockLanguageModelV4({ doGenerate: [...steps, textStep('unused')] });
    const oneStep = scope.oneStep;
    const agent = new ToolLoopAgent({
      model, tools: scope.tools, instructions: oneStep?.context ?? '',
      stopWhen: oneStep === undefined ? agentStopWhen : [agentStopWhen, oneStep.stopWhen],
      ...(oneStep === undefined || !forced ? {} : { prepareStep: oneStep.prepareStep }),
    });
    const result = await agent.generate({ prompt: 'is it a cat?' });
    return {
      reply: await guardGameReply(result.text, scope.turn, journal), calls: model.doGenerateCalls.length,
      choices: model.doGenerateCalls.map((call) => call.toolChoice),
    };
  }

  async function started(): Promise<Awaited<ReturnType<typeof fresh>>> {
    const f = await fresh();
    await call((await f.scope()).tools, 'start_game', { game: 'animal_riddles', players: [{ name: 'Maya', age: 6 }] });
    clock += 20_000;
    return f;
  }

  it("the context gives riddle_hint's exact line, names riddle_guess and riddle_skip, and never holds the answer", async () => {
    const f = await started();
    const scope = await f.scope();
    const s = await state(f);
    const riddle = riddleById(s.riddles[s.index]!);
    const context = scope.oneStep?.context ?? '';
    expect(context).toContain('riddle_guess');
    expect(context).toContain('riddle_skip');
    for (const name of [riddle.answer, ...riddle.aliases]) expect(context).not.toMatch(new RegExp(`\b${name}\b`, 'iu'));
    expect(await state(f)).toEqual(s);
    const hint = await call(scope.tools, 'riddle_hint');
    expect(context).toContain(hint.say);
  });

  it('a guess is one model call: the server judges it and its say is spoken', async () => {
    const f = await started();
    const s = await state(f);
    const answer = riddleById(s.riddles[s.index]!).answer;
    const events: Array<Record<string, string | number>> = [];
    const { reply, calls } = await turn(await f.scope(), [toolStep('', 'riddle_guess', { guess: answer })], (_e, fields) => { events.push(fields); });
    expect(calls).toBe(1);
    expect(reply).toMatch(/Riddle 2 of 6\..*Who am I\?$/u);
    expect((await state(f)).index).toBe(1);
    expect(events).toEqual([]);
  });

  it('a wrong guess with the model\'s own words is still one call, and only the server\'s say is spoken', async () => {
    const f = await started();
    const before = await state(f);
    const events: Array<Record<string, string | number>> = [];
    const { reply, calls } = await turn(await f.scope(), [toolStep('Yes, you got it!', 'riddle_guess', { guess: 'zzz' })], (_e, fields) => { events.push(fields); });
    expect(calls).toBe(1);
    expect(reply).toBe(sayStep(reduceRiddles(before, { type: 'guess', guess: 'zzz' }), [{ name: 'Maya', band: 'little' }]));
    expect(reply).not.toContain('you got it');
    expect((await state(f)).misses).toBe(1);
    expect(events).toEqual([{ reason: 'one_step', count: 1 }]);
  });

  it('skip is one model call and reveals the answer only in the tool say', async () => {
    const f = await started();
    const { reply, calls } = await turn(await f.scope(), [toolStep('', 'riddle_skip')]);
    expect(calls).toBe(1);
    expect(reply).toMatch(/^It was an? .*Riddle 2 of 6/u);
  });

  // The device turn forces a tool call (below), so this is the guard's net for a reply path that does not.
  it("the hint's line spoken from the context with no tool call still gives the clue, exactly once", async () => {
    const f = await started();
    const before = await state(f);
    const line = sayStep(reduceRiddles(before, { type: 'hint' }), [{ name: 'Maya', band: 'little' }]);
    const { reply, calls } = await turn(await f.scope(), [textStep(`Sure! ${line}`)], undefined, false);
    expect(calls).toBe(1);
    expect(reply).toBe(`Sure! ${line}`);
    expect(await state(f)).toMatchObject({ shown: 2, hints: 1 });
  });

  // Live finding (haiku, 2026-10-28): with no tool forced the model judged guesses itself ("Yes, a chicken!")
  // and even made up a riddle. The first model call of a play turn must call a tool; later steps are free.
  it('the first model call of a play turn must call a tool, so the model can never judge a guess itself', async () => {
    const f = await started();
    const { choices } = await turn(await f.scope(), [toolStep('', 'game_status'), textStep('You have 0 stars so far.')]);
    expect(choices).toEqual([{ type: 'required' }, { type: 'auto' }]);
  });

  it('a guess that fails its input check keeps a second step, so the turn is never silent', async () => {
    const f = await started();
    const { reply, calls } = await turn(await f.scope(), [toolStep('', 'riddle_guess', { guess: 'x'.repeat(60) }), textStep('Say that again?')]);
    expect(calls).toBe(2);
    expect(reply).toBe('Say that again?');
    expect((await state(f)).misses).toBe(0);
  });
});
