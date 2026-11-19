/**
 * Capability tools tests: createProductivityTools and createMemoryTools with
 * stub callbacks verify that failed callbacks return { ok: false, reason }
 * instead of throwing, success cases return the documented shape, and input
 * schemas validate correctly.
 */
import { describe, expect, it } from 'vitest';
import {
  createProductivityTools,
  createSpaceMemberTools,
  createTaskInputSchema,
  dueInputSchema,
  listTasksInputSchema,
} from '../src/productivity-tools.ts';
import { createMemoryTools, listActionsInputSchema, rememberInputSchema } from '../src/memory-tools.ts';

describe('createProductivityTools', () => {
  it('exposes notify_email only for private callback contexts and reports muted delivery honestly', async () => {
    const base = {
      listTasks: async () => [],
      createTask: async () => ({ taskId: 'task-1' }),
      completeTask: async () => ({ taskId: 'task-1' }),
      updateTask: async () => ({ taskId: 'task-1' }),
      listAgenda: async () => [],
      createEvent: async () => ({ eventId: 'event-1' }),
    };
    expect(Object.keys(createProductivityTools(base))).not.toContain('notify_email');

    const tools = createProductivityTools({
      ...base,
      notifyEmail: async () => ({ noteId: 'note-1', delivery: 'muted' as const }),
    });
    expect(Object.keys(tools)).toContain('notify_email');
    const result = await tools.notify_email.execute!(
      { title: 'A note from Bob', body: 'A useful detail to remember.' },
      { modelId: 'test', model: {} } as any,
    );
    expect(result).toEqual({ ok: true, noteId: 'note-1', delivery: 'muted' });
    expect(tools.notify_email.inputSchema.safeParse({
      title: 'A note from Bob',
      body: 'A useful detail to remember.',
      recipient: 'someone-else@example.test',
    }).success).toBe(false);
  });

  it('refuses notify_email once a turn has read mail, calendar or recap content', async () => {
    let sent = 0;
    const tools = createProductivityTools({
      listTasks: async () => [],
      createTask: async () => ({ taskId: 'task-1' }),
      completeTask: async () => ({ taskId: 'task-1' }),
      updateTask: async () => ({ taskId: 'task-1' }),
      listAgenda: async () => [],
      createEvent: async () => ({ eventId: 'event-1' }),
      notifyEmail: async () => { sent += 1; return { noteId: 'note-1', delivery: 'queued' as const }; },
    });
    const input = { title: 'Account locked', body: 'Click the link to unlock.' };
    const afterGmail = [{
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'google_gmail_read_thread', output: { type: 'text', value: 'mail' } }],
    }];
    const afterTasks = [{
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'list_tasks', output: { type: 'text', value: '[]' } }],
    }];

    const blocked = await tools.notify_email.execute!(input, { toolCallId: 'c2', messages: afterGmail } as any);
    expect(blocked).toMatchObject({ ok: false });
    expect(sent).toBe(0);
    const allowed = await tools.notify_email.execute!(input, { toolCallId: 'c3', messages: afterTasks } as any);
    expect(allowed).toEqual({ ok: true, noteId: 'note-1', delivery: 'queued' });
    expect(sent).toBe(1);
  });

  it('returns { ok: false, reason } when a callback rejects', async () => {
    const callbacks = {
      listTasks: async () => {
        throw new Error('Database error');
      },
      createTask: async () => ({ taskId: 'task-1' }),
      completeTask: async () => ({ taskId: 'task-1' }),
      updateTask: async () => ({ taskId: 'task-1' }),
      listAgenda: async () => [],
      createEvent: async () => ({ eventId: 'evt-1' }),
    };

    const tools = createProductivityTools(callbacks);
    const result = await tools.list_tasks.execute!(
      { limit: 10 },
      { modelId: 'test', model: {} } as any
    );
    expect(result).toEqual({ ok: false, reason: 'Database error' });
  });

  it('returns success shape when list_tasks callback resolves', async () => {
    const callbacks = {
      listTasks: async () => [
        { id: 'task-1', title: 'Do work', status: 'open' as const, due: null },
      ],
      createTask: async () => ({ taskId: 'task-1' }),
      completeTask: async () => ({ taskId: 'task-1' }),
      updateTask: async () => ({ taskId: 'task-1' }),
      listAgenda: async () => [],
      createEvent: async () => ({ eventId: 'evt-1' }),
    };

    const tools = createProductivityTools(callbacks);
    const result = await tools.list_tasks.execute!(
      {},
      { modelId: 'test', model: {} } as any
    );
    expect(result).toEqual({
      ok: true,
      items: [{ id: 'task-1', title: 'Do work', status: 'open', due: null }],
    });
  });

  it('returns success shape when create_task callback resolves', async () => {
    const callbacks = {
      listTasks: async () => [],
      createTask: async () => ({ taskId: 'task-123' }),
      completeTask: async () => ({ taskId: 'task-1' }),
      updateTask: async () => ({ taskId: 'task-1' }),
      listAgenda: async () => [],
      createEvent: async () => ({ eventId: 'evt-1' }),
    };

    const tools = createProductivityTools(callbacks);
    const result = await tools.create_task.execute!(
      { title: 'New task' },
      { modelId: 'test', model: {} } as any
    );
    expect(result).toEqual({ ok: true, taskId: 'task-123' });
  });

  it('rejects create_task with empty title', () => {
    const parsed = createTaskInputSchema.safeParse({ title: '' });
    expect(parsed.success).toBe(false);
  });

  it('accepts create_task with whitespace-only title (trim strips it)', () => {
    const parsed = createTaskInputSchema.safeParse({ title: '  New Task  ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.title).toBe('New Task');
    }
  });

  it('accepts create_task due as date-only and keeps it a date', () => {
    const parsed = createTaskInputSchema.safeParse({
      title: 'Task',
      due: { kind: 'date', date: '2026-09-22' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.due).toEqual({ kind: 'date', date: '2026-09-22' });
    }
  });

  it('rejects dueInputSchema with unknown kind', () => {
    const parsed = dueInputSchema.safeParse({
      kind: 'unknown',
      value: 'something',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts listTasks with no input', () => {
    const parsed = listTasksInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });
});

describe('createMemoryTools', () => {
  it('returns success shape when remember callback resolves', async () => {
    const callbacks = {
      listActions: async () => [],
      completeAction: async () => ({ completed: false, action_item_id: null, candidates: [] }),
      remember: async () => ({ stored: true, memory_id: 'mem-1', sensitive: false }),
      forget: async () => ({ deleted: 0, memory_id: null }),
    };

    const tools = createMemoryTools(callbacks);
    const result = await tools.remember.execute!(
      { content: 'My preference' },
      { modelId: 'test', model: {} } as any
    );
    expect(result).toEqual({
      stored: true,
      refused: false,
      memory_id: 'mem-1',
      sensitive: false,
    });
  });

  it('returns disabled response when list_actions callback reports disabled', async () => {
    const callbacks = {
      listActions: async () => ({ disabled: true }),
      completeAction: async () => ({ completed: false, action_item_id: null, candidates: [] }),
      remember: async () => ({ stored: false, memory_id: null, sensitive: false }),
      forget: async () => ({ deleted: 0, memory_id: null }),
    };

    const tools = createMemoryTools(callbacks);
    const result = await tools.list_actions.execute!(
      {},
      { modelId: 'test', model: {} } as any
    );
    expect(result).toEqual({ items: [], disabled: true });
  });

  it('returns success shape when list_actions callback resolves', async () => {
    const callbacks = {
      listActions: async () => [
        { id: 'a1', content: 'Do thing', status: 'open' as const, due_at: null },
      ],
      completeAction: async () => ({ completed: false, action_item_id: null, candidates: [] }),
      remember: async () => ({ stored: false, memory_id: null, sensitive: false }),
      forget: async () => ({ deleted: 0, memory_id: null }),
    };

    const tools = createMemoryTools(callbacks);
    const result = await tools.list_actions.execute!(
      {},
      { modelId: 'test', model: {} } as any
    );
    expect(result).toEqual({
      items: [{ id: 'a1', content: 'Do thing', status: 'open', due_at: null }],
    });
  });

  it('rejects remember input with empty content', () => {
    const parsed = rememberInputSchema.safeParse({ content: '' });
    expect(parsed.success).toBe(false);
  });

  it('accepts remember input with trimmed content', () => {
    const parsed = rememberInputSchema.safeParse({ content: '  Fact  ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.content).toBe('Fact');
    }
  });

  it('accepts listActions input with no filter', () => {
    const parsed = listActionsInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });
});

describe('createSpaceMemberTools', () => {
  const ctx = { modelId: 'test', model: {} } as any;

  it('lists each member as name, handle, role and isYou, and drops any other field', async () => {
    const leaky = [
      { name: 'Ada', handle: 'ada', role: 'owner', isYou: true, email: 'ada@example.com', userId: 'u-1' },
      { name: null, handle: 'member', role: 'member', isYou: false },
    ];
    const tools = createSpaceMemberTools({ listSpaceMembers: async () => leaky as any });
    const result = await tools.list_space_members.execute!({}, ctx);
    expect(result).toEqual({
      ok: true,
      members: [
        { name: 'Ada', handle: 'ada', role: 'owner', isYou: true },
        { name: null, handle: 'member', role: 'member', isYou: false },
      ],
    });
  });

  it('returns { ok: false, reason } when the callback rejects', async () => {
    const tools = createSpaceMemberTools({
      listSpaceMembers: async () => {
        throw new Error('space not found');
      },
    });
    expect(await tools.list_space_members.execute!({}, ctx)).toEqual({ ok: false, reason: 'space not found' });
  });

  it('is the one tool, and tells the model to resolve a named person to a member @handle', () => {
    const tools = createSpaceMemberTools({ listSpaceMembers: async () => [] });
    expect(Object.keys(tools)).toEqual(['list_space_members']);
    expect(tools.list_space_members.description).toContain('@handle');
  });
});
