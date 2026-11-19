/**
 * Web chat flow (#551). The stub agent (BOB_AI_STUB) answers with fixed text
 * and emits no tool calls, and its route must not touch the store, so the
 * create-an-item flows run the exact tool sets a web turn binds
 * (bindPrivateCallbacks + webTurnTools, what web-chat.ts hands the agent) and
 * then read the result back over HTTP: the "said saved, saved nothing" seam.
 */
import type { Tool } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootIntegrationServer, events, type IntegrationServer } from '../integration-helpers.ts';
import { withUserRaw } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
let server: IntegrationServer;
let spaceId: string;
let tools: Record<string, Tool>;

async function call<T>(name: string, input: unknown): Promise<T> {
  const tool = tools[name];
  if (tool?.execute === undefined) throw new Error(`the web turn does not offer ${name}`);
  return (await tool.execute(input as never, { toolCallId: `call_${name}`, messages: [], context: {} })) as T;
}

beforeAll(async () => {
  server = await bootIntegrationServer();
  const { ensurePrivateSpace } = await import('../../src/spaces/store.ts');
  const { webTurnTools } = await import('../../src/conversations/chat-tools.ts');
  const { bindPrivateCallbacks } = await import('../../src/tasks/agent-callbacks.ts');
  const { createProductivityTools } = await import('@bob/ai');
  spaceId = (await ensurePrivateSpace(server.db, server.userId)).id;
  const scope = { timeZone: 'UTC', localTimeDues: false };
  tools = {
    ...createProductivityTools(bindPrivateCallbacks(server.db, server.userId, spaceId, scope), { localTimeDues: false }),
    ...webTurnTools(appDeps, server.db, server.userId, 'UTC', spaceId),
  };
});

afterAll(async () => {
  await server?.close();
});

describe('web chat over HTTP on the stub agent', () => {
  it('streams the stub reply to an authenticated request and rejects an anonymous one', async () => {
    const message = { id: 'msg_integration_1', role: 'user', parts: [{ type: 'text', text: 'hello' }] };
    const response = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('"type":"text-delta"');
    expect(stream).toContain('System test response');

    const anonymous = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    expect(anonymous.status).toBe(401);
  });
});

describe('items a web turn creates through the bound tool layer', () => {
  it('create_task writes a task row the tasks route returns, and the reply links it', async () => {
    const output = await call<{ ok: boolean; taskId: string; spaceId?: string; title?: string }>(
      'create_task', { title: 'Integration pack lunches' });
    expect(output.ok).toBe(true);
    expect(output.spaceId).toBe(spaceId);
    expect(output.title).toBe('Integration pack lunches');

    const listed = await server.api<{ tasks: Array<{ id: string; title: string }> }>(`/api/spaces/${spaceId}/tasks`);
    expect(listed.status).toBe(200);
    expect(listed.body.tasks.filter((task) => task.id === output.taskId)).toHaveLength(1);
    // RLS: the row is read back as the account, the way every route reads it.
    const rows = await withUserRaw(server.pg, server.userId, (tx) => tx.query<{ n: number }>(
      'select count(*)::int as n from bob.tasks where id = $1 and space_id = $2', [output.taskId, spaceId]));
    expect(rows.rows[0]!.n).toBe(1);
  });

  it('create_reminder writes a reminder row the reminders route returns, and the reply links it', async () => {
    const when = new Date(Date.now() + 3 * 3600_000).toISOString();
    const output = await call<{ ok: boolean; say: string; reminderId?: string; spaceId?: string; title?: string }>(
      'create_reminder', { text: 'Integration call the dentist', when });
    expect(output.ok).toBe(true);
    expect(output.reminderId).toBeDefined();
    expect(output.spaceId).toBe(spaceId);

    const listed = await server.api<{ reminders: Array<{ id: string; title: string }> }>(`/api/spaces/${spaceId}/reminders`);
    expect(listed.status).toBe(200);
    const row = listed.body.reminders.find((reminder) => reminder.id === output.reminderId);
    expect(row?.title).toBe(output.title);
  });

  it('set_timer writes a pending timer the timers route returns', async () => {
    const before = server.journal.length;
    const output = await call<{ ok: boolean; id?: string }>('set_timer', { duration: 'PT20M', label: 'integration pasta' });
    expect(output.ok).toBe(true);
    expect(output.id).toBeDefined();

    const listed = await server.api<{ timers: Array<{ id: string; label: string | null }> }>('/api/timers');
    expect(listed.status).toBe(200);
    expect(listed.body.timers.map((timer) => timer.id)).toContain(output.id);
    const journaled = events(server.journal, 'v2.timers_listed', before);
    expect(journaled).toHaveLength(1);
    expect(journaled[0]!.count).toBe(listed.body.timers.length);
  });
});
