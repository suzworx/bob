// T008 (014, FR-008 → FR-012): the five capability tools and their Zod schemas,
// built over injected callbacks with no space/actor naming, plus the
// capabilityTools merge behaviour in the agent factory. Fakes only -- the real
// CommandContext-bound callbacks live in a later apps/api task.
import { describe, expect, it } from 'vitest';
import { createProductivityTools, type ProductivityCallbacks, createBobAgent, bobAgent, assistantTools, currentDateTimeTool } from '@bob/ai';
import { listTasksInputSchema, createTaskInputSchema, completeTaskInputSchema, updateTaskInputSchema, listAgendaInputSchema, createEventInputSchema } from '@bob/ai/testing';
import type { Tool } from 'ai';

const TOOL_NAMES = ['list_tasks', 'create_task', 'complete_task', 'update_task', 'list_agenda', 'create_event'];

/** Concrete tool shape so property access is not `Tool | undefined`. */
type ProductivityTools = {
  list_tasks: Tool;
  create_task: Tool;
  complete_task: Tool;
  update_task: Tool;
  list_agenda: Tool;
  create_event: Tool;
};

/** Runs one tool's execute against a concrete tool bag. */
async function run<T>(tools: ProductivityTools, name: keyof ProductivityTools, input: unknown): Promise<T> {
  const t = tools[name];
  return (t as unknown as { execute(i: unknown): Promise<T> }).execute(input);
}

/** A recording callback bag; each method can be overridden per test. */
function recordingCallbacks(overrides: Partial<ProductivityCallbacks> = {}) {
  const inputs: {
    listTasks: unknown[];
    createTask: unknown[];
    completeTask: unknown[];
    updateTask: unknown[];
    listAgenda: unknown[];
    createEvent: unknown[];
  } = {
    listTasks: [],
    createTask: [],
    completeTask: [],
    updateTask: [],
    listAgenda: [],
    createEvent: [],
  };
  const cb: ProductivityCallbacks = {
    listTasks: async (i) => {
      inputs.listTasks.push(i);
      return [];
    },
    createTask: async (i) => {
      inputs.createTask.push(i);
      return { taskId: 'task_1' };
    },
    completeTask: async (i) => {
      inputs.completeTask.push(i);
      return { taskId: 'task_1' };
    },
    updateTask: async (i) => {
      inputs.updateTask.push(i);
      return { taskId: 'task_1' };
    },
    listAgenda: async (i) => {
      inputs.listAgenda.push(i);
      return [];
    },
    createEvent: async (i) => {
      inputs.createEvent.push(i);
      return { eventId: 'evt_1' };
    },
    ...overrides,
  };
  return { cb, inputs };
}

describe('createProductivityTools', () => {
  it('returns the six tools with the expected snake_case names', () => {
    const tools = createProductivityTools(recordingCallbacks().cb);
    expect(Object.keys(tools)).toEqual(TOOL_NAMES);
    for (const name of TOOL_NAMES) {
      expect(typeof (tools[name] as Tool).execute).toBe('function');
    }
  });
});

describe('capability tool input schemas stay narrow (no space/actor/user naming)', () => {
  const FORBIDDEN = ['space_id', 'actor_id', 'user_id', 'audience'];

  /** Walks a Zod object/discriminated-union shape collecting every property key. */
  function collectKeys(schema: unknown, acc: Set<string> = new Set()): Set<string> {
    const s = schema as { shape?: Record<string, unknown>; options?: unknown[] };
    if (!s || typeof s !== 'object') return acc;
    if (s.shape) {
      for (const [key, child] of Object.entries(s.shape)) {
        acc.add(key);
        collectKeys(child, acc);
      }
    }
    if (Array.isArray(s.options)) {
      for (const opt of s.options) collectKeys(opt, acc);
    }
    return acc;
  }

  it('exposes no key that names whose data to touch', () => {
    const schemas = [
      listTasksInputSchema,
      createTaskInputSchema,
      completeTaskInputSchema,
      updateTaskInputSchema,
      listAgendaInputSchema,
      createEventInputSchema,
    ];
    for (const schema of schemas) {
      const keys = [...collectKeys(schema)];
      for (const forbidden of FORBIDDEN) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });
});

describe('a rejecting callback returns { ok: false } instead of throwing', () => {
  const boom = (): ProductivityCallbacks =>
    recordingCallbacks({
      listTasks: async () => {
        throw new Error('db down');
      },
      createTask: async () => {
        throw new Error('db down');
      },
      completeTask: async () => {
        throw new Error('db down');
      },
      updateTask: async () => {
        throw new Error('db down');
      },
      listAgenda: async () => {
        throw new Error('db down');
      },
      createEvent: async () => {
        throw new Error('db down');
      },
    }).cb;

  async function execute(name: keyof ProductivityTools, input: unknown): Promise<Record<string, unknown>> {
    const tools = createProductivityTools(boom()) as ProductivityTools;
    return run<Record<string, unknown>>(tools, name, input);
  }

  it('every tool returns a structured failure on a rejected callback', async () => {
    await expect(execute('list_tasks', {})).resolves.toMatchObject({ ok: false, reason: 'db down' });
    await expect(execute('create_task', { title: 'x' })).resolves.toMatchObject({ ok: false });
    await expect(execute('complete_task', { taskId: 'task_1' })).resolves.toMatchObject({ ok: false });
    await expect(execute('update_task', { taskId: 'task_1', title: 'x' })).resolves.toMatchObject({
      ok: false,
    });
    await expect(execute('list_agenda', { fromIso: 'a', toIso: 'b' })).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      execute('create_event', { title: 'x', startIso: 'a', endIso: 'b', zone: 'UTC' }),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe('a date-only due stays date-only', () => {
  it('passes through as kind: date and never acquires a time', async () => {
    const { cb, inputs } = recordingCallbacks();
    const tools = createProductivityTools(cb) as ProductivityTools;
    const out = await run<{ ok: boolean; taskId: string }>(tools, 'create_task', {
      title: 'milk',
      due: { kind: 'date', date: '2026-09-20' },
    });
    expect(out).toMatchObject({ ok: true, taskId: 'task_1' });
    const received = inputs.createTask[0] as { due: Record<string, unknown> };
    expect(received.due).toEqual({ kind: 'date', date: '2026-09-20' });
    expect(received.due).not.toHaveProperty('at');
    expect(received.due).not.toHaveProperty('zone');
  });
});

describe('update_task', () => {
  it('passes a date-only due through unchanged, with no at or zone', async () => {
    const { cb, inputs } = recordingCallbacks();
    const tools = createProductivityTools(cb) as ProductivityTools;
    const out = await run<{ ok: boolean; taskId: string }>(tools, 'update_task', {
      taskId: 'task_1',
      due: { kind: 'date', date: '2026-10-01' },
    });
    expect(out).toMatchObject({ ok: true, taskId: 'task_1' });
    const received = inputs.updateTask[0] as { due: Record<string, unknown> };
    expect(received.due).toEqual({ kind: 'date', date: '2026-10-01' });
    expect(received.due).not.toHaveProperty('at');
    expect(received.due).not.toHaveProperty('zone');
  });

  it('passes due: null and notes: null through as null', async () => {
    const { cb, inputs } = recordingCallbacks();
    const tools = createProductivityTools(cb) as ProductivityTools;
    const out = await run<{ ok: boolean; taskId: string }>(tools, 'update_task', {
      taskId: 'task_1',
      notes: null,
      due: null,
    });
    expect(out).toMatchObject({ ok: true, taskId: 'task_1' });
    const received = inputs.updateTask[0] as { notes: unknown; due: unknown };
    expect(received.notes).toBeNull();
    expect(received.due).toBeNull();
  });

  it('with only a taskId returns { ok: false, reason: "nothing to change" } without calling the callback', async () => {
    const { cb, inputs } = recordingCallbacks();
    const tools = createProductivityTools(cb) as ProductivityTools;
    const out = await run<{ ok: boolean; reason?: string }>(tools, 'update_task', { taskId: 'task_1' });
    expect(out).toEqual({ ok: false, reason: 'nothing to change' });
    expect(inputs.updateTask).toHaveLength(0);
  });

  it('rejects an unknown key like spaceId', () => {
    expect(updateTaskInputSchema.safeParse({ taskId: 't', spaceId: 's' }).success).toBe(false);
  });
});

describe('createBobAgent with no options stays config-identical to bobAgent', () => {
  it('is identical when capabilityTools is absent', () => {
    const factory = (createBobAgent() as unknown as { settings: Record<string, unknown> }).settings;
    const singleton = (bobAgent as unknown as { settings: Record<string, unknown> }).settings;
    expect(factory.model).toBe(singleton.model);
    expect(factory.instructions).toBe(singleton.instructions);
    expect(factory.tools).toBe(singleton.tools);
    expect(factory.telemetry).toBe(singleton.telemetry);
    expect(factory.tools).toBe(assistantTools);
  });
});

describe('capability tool merge in the agent factory', () => {
  it('merges capability tools alongside the assistant tools', () => {
    const agent = createBobAgent({ capabilityTools: { list_tasks: currentDateTimeTool } });
    const settings = (agent as unknown as { settings: Record<string, unknown> }).settings;
    const names = Object.keys(settings.tools as Record<string, unknown>);
    expect(names).toContain('list_tasks');
  });

  it('throws when a capability tool name clashes with an assistant tool, naming it', () => {
    const opts = { capabilityTools: { currentDateTime: currentDateTimeTool } };
    expect(() => createBobAgent(opts)).toThrow(/currentDateTime/);
    expect(() => createBobAgent(opts)).toThrow(/clash/i);
  });
});