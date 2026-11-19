// SCEN-LIVE: pre-release live scenarios. A TEXT utterance stands in for STT on
// the real device-turn path (runTurn: real agent, tools, memory, Space and
// account zone), then each scenario asserts on the ROWS the turn saved. Only
// STT and TTS are replaced. See docs/testing/live-scenarios.md.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Rows, ScenarioResult, TurnOutcome } from './harness.ts';
import type { TestDb } from '../support/test-db.ts';
import type { DeviceSession } from '../../src/voice/session-handlers.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const stt = vi.hoisted(() => ({ text: '' }));
vi.mock('../../src/voice/audio/stt-tts.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/voice/audio/stt-tts.ts')>()),
  isEmptyTurn: () => false,
  isTooShortTurn: () => false,
  transcribePcm: async () => ({ text: stt.text, model: 'scenario-text', seconds: 1 }),
  synthesizePcm: async () => ({ pcm: Buffer.alloc(3200), sourceRateHz: 16_000 }),
  synthesizeMp3: async () => ({ mp3: Buffer.alloc(0) }),
}));

const KEY = process.env.AI_GATEWAY_API_KEY ?? '';
const MODEL = process.env.BOB_CHAT_MODEL ?? 'openai/gpt-4o'; // the @bob/ai config.ts default
const REPEATS = Math.max(1, Number(process.env.SCENARIO_REPEATS ?? 2) || 2);
const LA = 'America/Los_Angeles';
const IST = 'Asia/Kolkata';
// Fixed "now": Tue 2026-10-06 10:07 PDT (UTC-7) = 22:37 IST (UTC+5:30).
const NOW = Date.parse('2026-10-06T17:07:00Z');
const at = (iso: string): number => Date.parse(iso);

type Check = (rows: Rows, out: TurnOutcome, before: Rows) => string | null; // null = pass
interface Scenario { id: string; zone: string; text: string; check: Check }

const none = (rows: Rows, ...kinds: Array<keyof Rows>): string | null => {
  const hit = kinds.filter((k) => rows[k].length > 0);
  return hit.length === 0 ? null : `unexpected ${hit.map((k) => `${k}=${rows[k].length}`).join(' ')}`;
};
const dueAt = (label: string, expected: number, title: RegExp): Check => (rows) => {
  const hit = [...rows.reminders, ...rows.tasks].find((r) => title.test(r.title) && r.dueAt === expected);
  if (hit) return null;
  const got = [...rows.reminders, ...rows.tasks].map((r) => `${r.title}@${r.dueAt === null ? 'none' : new Date(r.dueAt).toISOString()}`);
  return `no reminder/task ${label} (${new Date(expected).toISOString()}); got [${got.join('; ')}]`;
};
const reminderAt = (expected: number, title: RegExp): Check => (rows, out, before) => {
  const hit = rows.reminders.find((r) => title.test(r.title) && r.dueAt === expected);
  const got = rows.reminders.map((r) => `${r.title}@${r.dueAt === null ? 'none' : new Date(r.dueAt).toISOString()}`);
  return (hit ? null : `no reminder at ${new Date(expected).toISOString()}; got [${got.join('; ')}]`) ?? none(rows, 'memories');
};

const SCENARIOS: Scenario[] = [
  { id: 'a', zone: LA, text: 'Hey Alexa, remember to go to park today at four p.m.', check: reminderAt(at('2026-10-06T23:00:00Z'), /park/i) },
  { id: 'b', zone: LA, text: 'remember to go to temple today at nine fifteen p.m.', check: reminderAt(at('2026-10-07T04:15:00Z'), /temple/i) },
  { id: 'c-la', zone: LA, text: 'remind me to have breakfast with eggs tomorrow at 9 a.m.', check: dueAt('09:00 PDT tomorrow', at('2026-10-07T16:00:00Z'), /breakfast|eggs/i) },
  { id: 'c-ist', zone: IST, text: 'remind me to have breakfast with eggs tomorrow at 9 a.m.', check: dueAt('09:00 IST tomorrow', at('2026-10-07T03:30:00Z'), /breakfast|eggs/i) },
  {
    id: 'd', zone: LA, text: "remember that my wife's name is Priya",
    check: (rows) => (rows.memories.some((m) => (m.kind === 'fact' || m.kind === 'preference') && /priya/i.test(m.content))
      ? none(rows, 'reminders', 'tasks') : `no fact/preference memory naming Priya; got ${JSON.stringify(rows.memories)}`),
  },
  {
    id: 'e', zone: LA, text: 'add buy milk to my list',
    check: (rows) => (rows.tasks.some((t) => /milk/i.test(t.title) && t.dueAt === null && t.dueDate === null)
      ? none(rows, 'reminders') : `no undated milk task; got ${JSON.stringify(rows.tasks)}`),
  },
  {
    id: 'f', zone: LA, text: 'set a timer for five minutes',
    check: (rows) => (rows.timers.some((t) => t.kind === 'timer' && Math.abs(t.firesAt - (NOW + 300_000)) <= 60_000)
      ? null : `no timer ending ~${new Date(NOW + 300_000).toISOString()}; got ${JSON.stringify(rows.timers)}`),
  },
  {
    id: 'g', zone: LA, text: 'what time is it',
    check: (rows, out) => none(rows, 'reminders', 'tasks', 'memories', 'timers')
      ?? (/\b10[:.\s]?07\b|\bten[\s-]*o(h)?[\s-]*seven\b/i.test(out.reply) ? null : 'reply lacks 10:07'),
  },
  {
    // Runs in (a)'s session: the reply must name the park reminder AND that
    // reminder must exist, or "park" only came from the chat history.
    id: 'h', zone: LA, text: 'what reminders do I have',
    check: (rows, out, before) => (rows.reminders.some((r) => /park/i.test(r.title))
      ? (/park/i.test(out.reply) ? null : 'reply does not name the park reminder')
      : 'no park reminder row exists (scenario a saved none)')
      ?? (JSON.stringify(rows) === JSON.stringify(before) ? null : 'a read-only question wrote rows'),
  },
];

const results: ScenarioResult[] = [];
// Without a key the suite skips; vitest.scenarios.config.ts prints why.

describe.skipIf(!KEY)(`live scenarios on ${MODEL} x${REPEATS}`, () => {
  let h: typeof import('./harness.ts');
  let pg: TestDb;
  const sessionsA = new Map<number, { session: DeviceSession; userId: string }>();

  beforeAll(async () => {
    // #1041: never on the production key's budget.
    (await import('@bob/ai')).refuseProductionKey();
    h = await import('./harness.ts');
    const tdb = await import('../support/test-db.ts');
    const store = await import('../../src/platform/db/db.ts');
    pg = await tdb.createTestDb();
    await h.grantPlatformUsage(pg);
    store.setSharedDb(Promise.resolve(tdb.asDb(pg)));
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });

  afterAll(async () => {
    vi.useRealTimers();
    if (results.length > 0) {
      console.table(results.map((r) => ({ scenario: r.scenario, repeat: r.repeat, pass: r.pass, called_tools: r.called_tools, memory: r.memory_events.join(','), why: r.why })));
      console.log(`[scenarios] wrote ${h.writeResults(MODEL, results)}`);
    }
    await (await import('../../src/platform/db/db.ts')).closeDb().catch(() => undefined);
    if (pg) await (await import('../support/test-db.ts')).closeTestDb(pg).catch(() => undefined);
  });

  for (const s of SCENARIOS) {
    it(`${s.id}: ${s.text}`, async () => {
      const failures: string[] = [];
      for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
        let ctx = s.id === 'h' ? sessionsA.get(repeat) : undefined;
        if (!ctx) {
          const { addAccount } = await import('../support/test-db.ts');
          const { userId } = await addAccount(pg);
          await h.setAccountZone(pg, userId, s.zone);
          ctx = { session: h.newSession(userId), userId };
        }
        if (s.id === 'a') sessionsA.set(repeat, ctx);
        const before = await h.readRows(pg, ctx.userId);
        const out = await h.runTextTurn(ctx.session, s.text, (t) => { stt.text = t; });
        const rows = await h.readRows(pg, ctx.userId);
        // A degraded memory store is a harness fault, never a model result.
        const harnessFault = out.memoryEvents.some((e) => e.endsWith(':store_unavailable'));
        const why = harnessFault ? 'HARNESS: memory store unavailable'
          : out.failed ? 'turn failed' : (s.check(rows, out, before) ?? '');
        results.push({
          scenario: s.id, model: out.model ?? MODEL, repeat, zone: s.zone, pass: why === '', why,
          called_tools: out.calledTools, reply: out.reply, rows, input_tokens: out.inputTokens, output_tokens: out.outputTokens,
          memory_events: out.memoryEvents,
        });
        if (why !== '') failures.push(`repeat ${repeat}: ${why} [called_tools=${out.calledTools || 'none'}] reply="${out.reply}"`);
      }
      expect(failures, `scenario ${s.id} on ${MODEL}`).toEqual([]);
    });
  }
});
