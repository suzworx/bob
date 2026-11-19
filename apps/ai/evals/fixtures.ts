/**
 * Eval fixture loading for the Braintrust suites (spec 009, D4). Each suite
 * has a Zod schema; fixtures live as JSON in data/<name>.json and are
 * validated at load, failing loudly on schema errors (Constitution IV).
 *
 * The braintrust CLI bundles eval files to CommonJS and evaluates them with
 * `__filename`/`__dirname` set to the original source file, where
 * `import.meta.url` is empty -- so resolution uses the repo-root-relative
 * path first (npm scripts run from the root), then the bundle __dirname
 * (the source data/ directory) and a bare cwd-relative data/ path.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { AgendaItem, TaskSummary } from '../src/productivity-tools.ts';

/** A single voice-reply fixture: a spoken-style user question. */
interface VoiceReplyCase {
  input: string;
}

/** A single tool-selection fixture: a request plus the tools it should call. */
export interface ToolCase {
  input: string;
  expected: string[];
  category: 'single' | 'no_tool' | 'confusable' | 'follow_up' | 'stt_noise';
  prior?: { role: 'user' | 'assistant'; content: string }[];
  args?: Record<string, Record<string, unknown>>;
  own_zone?: boolean;
}

/** One prior turn in a continuity fixture. */
interface ContinuityTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** A continuity fixture: prior turns plus a question needing an earlier fact. */
interface ContinuityCase {
  input: {
    turns: ContinuityTurn[];
    question: string;
  };
  expected: string;
}

/** A quality fixture: a question plus a reference answer. */
interface QualityCase {
  input: string;
  expected: string;
}

export const voiceReplyCaseSchema = z.object({
  input: z.string().min(1),
});

/** Tool-selection fixture categories (#410): the X1 fixture mix. */
const toolCaseCategorySchema = z.enum(['single', 'no_tool', 'confusable', 'follow_up', 'stt_noise']);
type ToolCaseCategory = z.infer<typeof toolCaseCategorySchema>;

/** One prior turn before a follow-up request. */
const toolPriorTurnSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1),
  })
  .strict();

/**
 * A tool-selection fixture: `expected` lists the tools in call order (empty
 * means no call); `args` pins only the listed parameters per tool, e.g.
 * { "set_mode": { "mode": "wake" } }; `own_zone` marks a request for the
 * user's own local time, where calling currentDateTime is recorded separately.
 */
export const toolCaseSchema = z
  .object({
    input: z.string().min(1),
    expected: z.array(z.string().min(1)),
    category: toolCaseCategorySchema,
    prior: z.array(toolPriorTurnSchema).min(1).optional(),
    args: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    own_zone: z.boolean().optional(),
  })
  .strict();

const continuityTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});

export const continuityCaseSchema = z.object({
  input: z.object({
    turns: z.array(continuityTurnSchema).min(1),
    question: z.string().min(1),
  }),
  expected: z.string().min(1),
});

/** #750: an advice question, the earlier turns of its conversation, and the memory block. */
export const adviceCaseSchema = z.object({
  input: z.string().min(1),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1) })).default([]),
  memory: z.string().min(1).optional(),
});

/** A seed task due today + dayOffset days (date-only); no dayOffset means no due, same as a real task. */
const taskSeedSchema = z
  .object({
    title: z.string().min(1),
    status: z.enum(['open', 'completed']).default('open'),
    dayOffset: z.number().int().optional(),
  })
  .strict();

/** A seed calendar event spanning startTime to endTime (local "HH:mm") on today + dayOffset days. */
const eventSeedSchema = z
  .object({
    title: z.string().min(1),
    dayOffset: z.number().int(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/),
    endTime: z.string().regex(/^\d{2}:\d{2}$/),
  })
  .strict();

/** A planning fixture's tasks/agenda picture, resolved to real tool output by resolvePlanningSeed. */
const planningSeedSchema = z
  .object({
    tasks: z.array(taskSeedSchema).default([]),
    agenda: z.array(eventSeedSchema).default([]),
  })
  .strict();
export type PlanningSeed = z.infer<typeof planningSeedSchema>;

/**
 * #898: a planning request ("Plan my week using my tasks and events") plus
 * `seed`, the tasks/agenda picture resolvePlanningSeed (PLAN-SEED) turns into
 * the real list_tasks/list_agenda output tool-agent.ts's stubs return for
 * this fixture -- replacing the earlier trick of carrying that picture as
 * fake prior turns in history, which left the model's own (correct) tool
 * call contradicting the conversation. An omitted `seed` resolves to the
 * empty picture, same as today's stub.
 */
export const planningCaseSchema = z.object({
  input: z.string().min(1),
  memory: z.string().min(1).optional(),
  seed: planningSeedSchema.default({ tasks: [], agenda: [] }),
});
export type PlanningCase = z.infer<typeof planningCaseSchema>;

/**
 * Resolves a planning fixture's seed to the real list_tasks/list_agenda
 * output shape, with real ISO dates in the current week relative to `now`
 * (default the moment this runs): the eval agent has no fixed clock, so
 * "today" is whenever the suite runs, not a date baked into the fixture.
 */
export function resolvePlanningSeed(
  seed: PlanningSeed,
  now: Date = new Date(),
): { tasks: TaskSummary[]; agenda: AgendaItem[] } {
  const dayAt = (dayOffset: number): Date => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + dayOffset);
    return date;
  };
  const tasks: TaskSummary[] = seed.tasks.map((task, index) => ({
    id: `seed-task-${index}`,
    title: task.title,
    status: task.status,
    due: task.dayOffset === undefined ? null : dayAt(task.dayOffset).toISOString().slice(0, 10),
  }));
  // "HH:mm" (enforced by eventSeedSchema's regex): sliced by fixed width, not split+destructure,
  // since noUncheckedIndexedAccess types a destructured array element as possibly undefined.
  const hourMinute = (time: string): [number, number] => [Number(time.slice(0, 2)), Number(time.slice(3, 5))];
  const agenda: AgendaItem[] = seed.agenda.map((event, index) => {
    const [startHour, startMinute] = hourMinute(event.startTime);
    const [endHour, endMinute] = hourMinute(event.endTime);
    const start = dayAt(event.dayOffset);
    start.setUTCHours(startHour, startMinute, 0, 0);
    const end = dayAt(event.dayOffset);
    end.setUTCHours(endHour, endMinute, 0, 0);
    return { id: `seed-event-${index}`, title: event.title, startIso: start.toISOString(), endIso: end.toISOString() };
  });
  return { tasks, agenda };
}

export const qualityCaseSchema = z.object({
  input: z.string().min(1),
  expected: z.string().min(1),
});

/** Resolves the fixture file for a suite, preferring the repo-root path. */
function resolveFixturePath(name: string): string {
  const candidates = [
    resolve(process.cwd(), 'apps/ai/evals/data', `${name}.json`),
    ...(typeof __dirname === 'undefined' ? [] : [resolve(__dirname, 'data', `${name}.json`)]),
    resolve(process.cwd(), 'data', `${name}.json`),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}

/**
 * Loads and validates data/<name>.json against the suite schema. Throws with
 * the file path and first issues when the file is missing, invalid JSON, or
 * does not match the schema, so a fixture mistake fails the suite loudly.
 */
export function loadFixtures<C>(name: string, schema: z.ZodType<C>): C[] {
  const file = resolveFixturePath(name);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `Failed to read eval fixture ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = schema.array().safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Eval fixture ${file} failed schema validation: ${details}`);
  }
  return parsed.data;
}

/**
 * Fails fast when the eval environment cannot produce a real agent reply
 * (Constitution V): no gateway key, or system-test stub mode switched on.
 * Scoring stub output would fabricate a score, so the suites refuse to run.
 */
export function assertEvalPreconditions(): void {
  if ((process.env.AI_GATEWAY_API_KEY ?? '') === '') {
    throw new Error(
      'Eval suites need AI_GATEWAY_API_KEY to call the real agent. Refusing to run: ' +
        'without the key the BOB_SYSTEM_TEST stub would be scored instead of a real reply.',
    );
  }
  if (process.env.BOB_SYSTEM_TEST === '1') {
    throw new Error(
      'BOB_SYSTEM_TEST=1 switches the agent to the system-test stub. Refusing to run ' +
        'evals: stub output must never be scored.',
    );
  }
}
/** Synthetic personality scenarios, with a semantic rubric and optional brevity ceiling. */
export const helpfulnessCaseSchema = z.object({
  input: z.string().min(1),
  expected: z.string().min(1),
  maxWords: z.number().int().positive().optional(),
}).strict();
