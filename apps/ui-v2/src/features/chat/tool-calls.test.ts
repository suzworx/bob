import { describe, expect, it } from 'vitest';
import type { ToolUIPart, DynamicToolUIPart, TextUIPart } from 'ai';
import { isToolPart, toResourceRef, toToolCall } from './tool-calls';

describe('tool-calls', () => {
  // P0 shell-chat "Tool-call rendering": raw tool names and errorText never reach the reader.
  it('names a tool call in plain words, never its raw name or error text', () => {
    const running = toToolCall({ type: 'tool-create_task', toolCallId: 'p1', state: 'input-available', input: {} } as ToolUIPart);
    expect(running.name).toBe('Adding a task');
    const done = toToolCall({ type: 'tool-list_agenda', toolCallId: 'p2', state: 'output-available', input: {}, output: {} } as ToolUIPart);
    expect(done.name).toBe('Checked your calendar');
    const failed = toToolCall({
      type: 'tool-create_task',
      toolCallId: 'p3',
      state: 'output-error',
      input: {},
      errorText: 'TypeError: cannot read properties of undefined (create_task)',
    } as ToolUIPart);
    expect(failed.name).not.toContain('create_task');
    expect(failed.errorMessage).toBe("Couldn't finish that");
  });

  describe('toToolCall', () => {
    it('handles input-streaming state as pending', () => {
      const part: ToolUIPart = {
        type: 'tool-getWeather',
        toolCallId: 'tc1',
        state: 'input-streaming',
      } as ToolUIPart;

      const result = toToolCall(part);
      expect(result.status).toBe('pending');
      expect(result.name).toBe('Working on it');
      expect(result.key).toBe('tc1');
      expect(result.errorMessage).toBeUndefined();
    });

    it('handles input-available state as running', () => {
      const part: ToolUIPart = {
        type: 'tool-getWeather',
        toolCallId: 'tc2',
        state: 'input-available',
        input: { location: 'Seattle' },
      } as ToolUIPart;

      const result = toToolCall(part);
      expect(result.status).toBe('running');
      expect(result.name).toBe('Working on it');
    });

    it('handles approval-requested state as running', () => {
      const part: ToolUIPart = {
        type: 'tool-getWeather',
        toolCallId: 'tc3',
        state: 'approval-requested',
        input: { location: 'Seattle' },
        approval: { id: 'ap1' },
      } as ToolUIPart;

      const result = toToolCall(part);
      expect(result.status).toBe('running');
    });

    it('handles approval-responded state as running', () => {
      const part: ToolUIPart = {
        type: 'tool-getWeather',
        toolCallId: 'tc4',
        state: 'approval-responded',
        input: { location: 'Seattle' },
        approval: { id: 'ap2', approved: true },
      } as ToolUIPart;

      const result = toToolCall(part);
      expect(result.status).toBe('running');
    });

    it('handles output-available state as complete', () => {
      const part: ToolUIPart = {
        type: 'tool-getWeather',
        toolCallId: 'tc5',
        state: 'output-available',
        input: { location: 'Seattle' },
        output: { temperature: 65 },
      } as ToolUIPart;

      const result = toToolCall(part);
      expect(result.status).toBe('complete');
      expect(result.errorMessage).toBeUndefined();
    });

    it('handles output-error state as error with errorMessage', () => {
      const part: ToolUIPart = {
        type: 'tool-getWeather',
        toolCallId: 'tc6',
        state: 'output-error',
        input: { location: 'Seattle' },
        errorText: 'Network timeout',
      } as ToolUIPart;

      const result = toToolCall(part);
      expect(result.status).toBe('error');
      expect(result.errorMessage).toBe("Couldn't finish that");
    });

    it('handles output-denied state as error with Denied message', () => {
      const part: ToolUIPart = {
        type: 'tool-getWeather',
        toolCallId: 'tc7',
        state: 'output-denied',
        input: { location: 'Seattle' },
        approval: { id: 'ap3', approved: false },
      } as ToolUIPart;

      const result = toToolCall(part);
      expect(result.status).toBe('error');
      expect(result.errorMessage).toBe('Not allowed');
    });

    it('handles static tool part (type tool-getWeather)', () => {
      const part: ToolUIPart = {
        type: 'tool-getWeather',
        toolCallId: 'tc8',
        state: 'output-available',
        input: { location: 'NYC' },
        output: { temperature: 72 },
      } as ToolUIPart;

      const result = toToolCall(part);
      expect(result.name).toBe('Done');
      expect(result.status).toBe('complete');
    });

    it('handles dynamic tool part with toolName search', () => {
      const part: DynamicToolUIPart = {
        type: 'dynamic-tool',
        toolName: 'search',
        toolCallId: 'tc9',
        state: 'output-available',
        input: { query: 'typescript' },
        output: { results: [] },
      };

      const result = toToolCall(part);
      expect(result.name).toBe('Looked that up');
      expect(result.status).toBe('complete');
      expect(result.key).toBe('tc9');
    });
  });

  describe('isToolPart', () => {
    it('returns true for static tool parts', () => {
      const part: ToolUIPart = {
        type: 'tool-getWeather',
        toolCallId: 'tc1',
        state: 'output-available',
        input: {},
        output: {},
      } as ToolUIPart;

      expect(isToolPart(part)).toBe(true);
    });

    it('returns true for dynamic tool parts', () => {
      const part: DynamicToolUIPart = {
        type: 'dynamic-tool',
        toolName: 'search',
        toolCallId: 'tc2',
        state: 'output-available',
        input: {},
        output: {},
      };

      expect(isToolPart(part)).toBe(true);
    });

    it('returns false for non-tool parts', () => {
      const textPart: TextUIPart = { type: 'text', text: 'hello' };
      expect(isToolPart(textPart)).toBe(false);
    });
  });
});

describe('toResourceRef', () => {
  const done = (output: unknown, id = 'tc1'): ToolUIPart =>
    ({ type: 'tool-createTask', toolCallId: id, state: 'output-available', input: {}, output }) as ToolUIPart;

  it('links a created task to its space, with its title', () => {
    expect(toResourceRef(done({ taskId: 'tsk_1', spaceId: 'spc_1', title: 'Milk' }))).toEqual({
      key: 'tc1',
      kind: 'task',
      id: 'tsk_1',
      spaceId: 'spc_1',
      title: 'Milk',
    });
  });

  it('reads every kind of item the create and update tools return', () => {
    expect(toResourceRef(done({ eventId: 'e', spaceId: 's' }))?.kind).toBe('event');
    expect(toResourceRef(done({ noteId: 'n', spaceId: 's' }))?.kind).toBe('note');
    expect(toResourceRef(done({ reminderId: 'r', spaceId: 's' }))?.kind).toBe('reminder');
    expect(toResourceRef(done({ noteId: 'n', spaceId: 's' }))?.title).toBeNull();
  });

  it('yields nothing for a failed, denied or unfinished call', () => {
    const base = { type: 'tool-createTask', toolCallId: 'tc', input: {} };
    const failed = { ...base, state: 'output-error', errorText: 'boom' } as ToolUIPart;
    const denied = { ...base, state: 'output-denied', approval: { id: 'a', approved: false } } as ToolUIPart;
    const running = { ...base, state: 'input-available' } as ToolUIPart;
    expect(toResourceRef(failed)).toBeNull();
    expect(toResourceRef(denied)).toBeNull();
    expect(toResourceRef(running)).toBeNull();
  });

  it('yields nothing for output that names no single item in a space', () => {
    expect(toResourceRef(done({ taskId: 'tsk_1' }))).toBeNull();
    expect(toResourceRef(done({ spaceId: 'spc_1' }))).toBeNull();
    expect(toResourceRef(done({ taskId: 't', noteId: 'n', spaceId: 's' }))).toBeNull();
    expect(toResourceRef(done({ taskId: 7, spaceId: 's' }))).toBeNull();
    expect(toResourceRef(done({ taskId: ' ', spaceId: 's' }))).toBeNull();
    expect(toResourceRef(done('Added milk'))).toBeNull();
    expect(toResourceRef(done(null))).toBeNull();
    expect(toResourceRef(done({ ok: false, taskId: 't', spaceId: 's', reason: 'x' }))).toBeNull();
    expect(toResourceRef(done({ ok: true, taskId: 't', spaceId: 's', title: 'Milk' }))?.title).toBe('Milk');
    expect(toResourceRef(done([{ taskId: 't', spaceId: 's' }]))).toBeNull();
  });
});
