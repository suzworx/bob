/**
 * Tool descriptions (#411; the compact set is the only set since SIMPLIFY-U5A).
 * The wire view (name + description + input schema JSON, hashed per tool) is
 * pinned byte-identical, every disambiguation guard is kept, and a locked
 * character budget stops later edits from silently re-growing it.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asSchema } from 'ai';
import type { Tool } from 'ai';
import { createCurrentDateTimeTool } from '../src/tools.ts';
import { createMemoryTools } from '../src/memory-tools.ts';
import { createProductivityTools, createSpaceMemberTools } from '../src/productivity-tools.ts';
import { createVoiceTools } from '../src/voice-tools.ts';
import { createTimerTools } from '../src/timer-tools.ts';
import { createDeviceTools } from '../src/device-tools.ts';

/** Callbacks are never invoked: only descriptions and schemas are read. */
const stub = new Proxy({}, {
  get: (_target, property) => property === 'notifyEmail' ? undefined : async (): Promise<object> => ({}),
}) as never;

interface WireTool {
  description: string;
  parameters: string;
}

/** Builds every tool group the way measure-prompt.mts does and serializes it as sent. */
async function wireView(): Promise<Record<string, WireTool>> {
  const registry: Record<string, Tool> = {
    currentDateTime: createCurrentDateTimeTool('UTC'),
    ...createMemoryTools(stub),
    ...createProductivityTools(stub),
    ...createSpaceMemberTools(stub),
    ...createVoiceTools(stub),
    ...createTimerTools(stub),
    ...createDeviceTools(stub),
  };
  const view: Record<string, WireTool> = {};
  for (const [name, entry] of Object.entries(registry)) {
    const schema = await asSchema(entry.inputSchema).jsonSchema;
    view[name] = { description: entry.description ?? '', parameters: JSON.stringify(schema) };
  }
  return view;
}

function totalChars(view: Record<string, WireTool>): number {
  return Object.values(view).reduce((sum, entry) => sum + entry.description.length, 0);
}

/** Budget for the sum of description characters (#447 added the memory/reminder time boundary;
 *  +91 for remember's canonical-voice rule, MEMORY_CONTENT_STYLE_SHORT; +181 for the task assign/reassign rule;
 *  +194 for list_space_members; +225 for the create_event away/unavailable sentence and the create_reminder
 *  per-day sentence, #898; -14 for the create_event wording fix, #898 c1; +179 for the create_event
 *  "remember that" calendar-block sentence and the create_reminder not-for-absence sentence, TOOLS-AVAIL2;
 *  +122 for remember's own calendar-block-not-a-memory sentence, TOOLS-AVAIL2 c1; +513 for the
 *  same plan-my-week/day guidance, compact wording, PLAN-GUIDE (#898); +90 for PLAN-GUIDE2's
 *  compact-wording rewording of the same list_tasks/list_agenda guidance; +208 for
 *  PLAN-DAY's compact-wording resolve-without-asking line and "propose a time"/"offering
 *  to schedule" rewording of the same list_tasks/list_agenda guidance; +95 for the
 *  same complete_task list_tasks sentence, compact wording, D2 of the #1007 probes; +150 for the express tool, BOB-EXPRESS-SCENES;
 *  +518 for the same tasks-vs-action-items wording, compact, #1046). */
const COMPACT_DESCRIPTION_BUDGET = 6010;
/**
 * Guard phrases each description must keep (issue #411, Scope 3b):
 * every "use X instead" pointer, every "once" / "repeatedly" guard, the
 * ISO-offset example, and the never-guess / ask-first / candidate guards.
 */
const GUARDS: Record<string, string[]> = {
  create_reminder: ['use create_task instead', '2026-09-23T18:00:00+05:30', 'Call it once per reminder', '`repeat` only when'],
  cancel_reminder: ['never cancel them all', 'ask which one'],
  create_note: ['use append_note'],
  append_note: ['existing note', 'Not for a new note'],
  search: ['`kinds` only when'],
  remember: ['Use only when the person asks you to keep something', 'use create_reminder instead'],
  forget: ['three candidates', 'instead of deleting'],
  list_actions: ['not tasks', 'use list_tasks'],
  complete_action: ['three candidates', 'not tasks', 'use complete_task instead', 'means an action item'],
  list_tasks: ['Not for past events or calendar slots', 'call this and list_agenda', 'ask at most one follow-up'],
  create_task: ['Call it once per task', 'never call it repeatedly', 'creates duplicates', 'stays a date', 'use update_task'],
  complete_task: ['actually finished', 'only mentioned', 'list_tasks', 'never ask the person for an id', 'not complete_action', 'same name'],
  update_task: ['list_tasks', 'never guess', 'Use complete_task to finish a task', 'assign or reassign', 'only from the assignee a result returns'],
  list_agenda: ['Not for task or note content', 'call this and list_tasks', 'ask at most one follow-up'],
  create_event: ['Use only when the person gave the time', 'ask for the missing details first'],
  list_space_members: ['resolve a named person to a member @handle', 'never guess a handle'],
  set_timer: ['Call it once per timer', 'use set_alarm instead'],
  set_alarm: ['use set_timer instead'],
  cancel_timer: ['list_timers', 'Never guess an id'],
  set_volume: ['Give at least one'],
  set_mode: ['"ptt"', '"wake"', '"announce_only"'],
  express: ['"love"', '"music"', '"celebrating"', 'every reply'],
};

describe('tool descriptions', () => {
  it('keeps every tool name, description and input schema byte-identical', async () => {
    const view = await wireView();
    const digests = Object.fromEntries(
      Object.entries(view).map(([name, entry]) => [
        name,
        createHash('sha256')
          .update(JSON.stringify({ name, description: entry.description, parameters: entry.parameters }))
          .digest('hex')
          .slice(0, 16),
      ]),
    );
    expect({ totalChars: totalChars(view), digests }).toMatchInlineSnapshot(`
      {
        "digests": {
          "append_note": "666e0c30ef50f1df",
          "cancel_reminder": "63aa31b2ec069878",
          "cancel_timer": "4f8ee5c30abfae8e",
          "complete_action": "de50e3f91e09dc5a",
          "complete_task": "26b7fec981d14e0f",
          "create_event": "46490e4cde49975f",
          "create_note": "872dc1d8836b0b98",
          "create_reminder": "c4b875b04ee6fc99",
          "create_task": "2f3db89c2337177b",
          "currentDateTime": "c66fa42e9e744e7d",
          "express": "a9fb5e9bfc6d69d2",
          "forget": "6cd9340c8f37d131",
          "list_actions": "7868e54f896bc25c",
          "list_agenda": "a3fe9d293ba52cb0",
          "list_reminders": "a2e8cf2aa140f76a",
          "list_space_members": "930f27da5bf6b226",
          "list_tasks": "d85edc6e2dfcc320",
          "list_timers": "225d3ff5e1450e47",
          "read_inbox": "92a1919f5d1ac15b",
          "read_note": "4ef2adfe892b9e99",
          "remember": "1ed7ac9ad69a4c7d",
          "search": "03abc5a0a8fb7468",
          "set_alarm": "45fdbca4b8003249",
          "set_mode": "d35c426bf1a8093d",
          "set_timer": "85ed6be531d805d6",
          "set_volume": "d2184ba5d0e3541f",
          "update_task": "abc6839ea73ace2f",
        },
        "totalChars": 6008,
      }
    `);
  });

  it('keeps every disambiguation guard phrase', async () => {
    const view = await wireView();
    for (const [name, phrases] of Object.entries(GUARDS)) {
      expect(view[name], name).toBeDefined();
      for (const phrase of phrases) {
        expect(view[name]!.description, `${name}: ${phrase}`).toContain(phrase);
      }
    }
  });

  it('stays within the locked character budget', async () => {
    expect(totalChars(await wireView())).toBeLessThanOrEqual(COMPACT_DESCRIPTION_BUDGET);
  });
});

/**
 * #447 memory/reminder contract: a memory carries no time, a reminder always
 * does. Pinned through the data (the input schemas) and the tools pointing at
 * each other; no user phrasing is asserted.
 */
describe('memory and reminder time boundary (#447)', () => {
  it(`remember takes no time and create_reminder requires one`, async () => {
    const view = await wireView();
    const remember = JSON.parse(view.remember!.parameters) as {
      properties: Record<string, unknown> & { kind: { enum: string[] } };
    };
    const reminder = JSON.parse(view.create_reminder!.parameters) as { required: string[] };
    expect(Object.keys(remember.properties).sort()).toEqual(['content', 'kind', 'sensitive']);
    expect(remember.properties.kind.enum).toEqual(['fact', 'preference']);
    // RELIABLE: `when` may be left out only for an hourly repeat (the schema refines the rest).
    expect(reminder.required).toContain('text');
    expect(reminder.required).not.toContain('when');
    expect(view.remember!.description).toContain('create_reminder');
    expect(view.create_reminder!.description).toContain('memory');
    expect(view.create_reminder!.description).toContain('create_task');
  });

  it(`create_reminder tells the model how to repeat by the hour, in its schema (#456)`, async () => {
    const view = await wireView();
    type Prop = { description?: string; enum?: string[]; minimum?: number; maximum?: number; properties?: Record<string, Prop> };
    const { properties } = JSON.parse(view.create_reminder!.parameters) as { properties: Record<string, Prop> };
    expect(properties.repeat!.enum).toContain('hourly');
    expect(properties.every_hours).toMatchObject({ minimum: 1, maximum: 12 });
    expect(properties.every_hours!.description).toContain('repeat hourly');
    // RELIABLE: `from` came back as `from1` from gemini-2.5-flash; start/end did not.
    expect(Object.keys(properties.active_hours!.properties ?? {}).sort()).toEqual(['end', 'start']);
    expect(properties.active_hours!.description).toContain('08:00 to 22:00');
    expect(properties.active_hours!.description).toContain('needs no question about hours');
    expect(properties.when!.description).toContain('an hour from now');
  });
});

/**
 * #1046: tasks (the to-do list: create_task, list_tasks, complete_task) and
 * action items (follow-ups saved to memory: list_actions,
 * complete_action) are different stores. A live "mark <task> as done" picked
 * complete_action because its description called an action item a "task".
 * Each family's descriptions name the other family's tool and never call an
 * action item a task; a name that could be either
 * goes to the tasks first.
 */
describe('tasks vs action items (#1046)', () => {
  it(`never calls an action item a task and points each family at the other`, async () => {
    const view = await wireView();
    for (const name of ['list_actions', 'complete_action'] as const) {
      const description = view[name]!.description;
      expect(description, name).not.toMatch(/action items? \(tasks?\)/i);
      expect(description, name).toContain('not tasks');
      expect(description, name).toContain('saved to memory');
    }
    expect(view.list_actions!.description).toContain('use list_tasks');
    expect(view.complete_action!.description).toContain('use complete_task instead');
    expect(view.complete_task!.description).toContain('create_task');
    expect(view.complete_task!.description).toContain('not complete_action');
    expect(view.list_tasks!.description).toContain('complete_task');
  });
});
