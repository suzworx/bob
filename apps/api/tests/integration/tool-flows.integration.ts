/**
 * Tool-call flows through the REAL web chat path (#551). BOB_AI_STUB=scripted
 * swaps only the model (@bob/ai stub-agent.ts): a fixed test sentence makes
 * one fixed tool call, and /api/chat runs the real turn around it -- the tools
 * it binds, the store, the stored reply, the device fan-out. Each flow asserts
 * the row, the stored tool part the reply chip (#544) is built from, and for the
 * timer the `timers_state` frame on a connected device. Ids and counts only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bootIntegrationServer, connectDevice, events, type IntegrationServer } from '../integration-helpers.ts';
import { withUserRaw } from '../support/test-db.ts';

const toolPartSchema = z.object({
  type: z.string(),
  toolCallId: z.string(),
  state: z.string(),
  output: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const detailSchema = z.object({
  messages: z.array(z.object({
    role: z.string(),
    versions: z.array(z.object({ selected: z.boolean(), parts: z.array(z.object({ type: z.string() }).passthrough()) })),
  })),
});
type ToolPart = z.infer<typeof toolPartSchema>;

let server: IntegrationServer;
let spaceId: string;

/** One typed web turn: returns the conversation it landed in and the tool part it stored. */
async function chatTurn(text: string, toolName: string): Promise<{ conversationId: string; part: ToolPart }> {
  const message = { id: `msg_${toolName}_${Date.now()}`, role: 'user', parts: [{ type: 'text', text }] };
  const response = await fetch(`${server.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  expect(response.status).toBe(200);
  const stream = await response.text();
  expect(stream).toContain('"type":"tool-output-available"');
  const conversationId = /"conversationId":"([^"]+)"/.exec(stream)?.[1];
  if (conversationId === undefined) throw new Error('the chat stream named no conversation');

  const detail = await server.api<unknown>(`/api/conversations/${conversationId}`);
  expect(detail.status).toBe(200);
  const assistant = detailSchema.parse(detail.body).messages.filter((stored) => stored.role === 'assistant');
  expect(assistant).toHaveLength(1);
  const shown = assistant[0]!.versions.filter((version) => version.selected);
  expect(shown).toHaveLength(1);
  const parts = shown[0]!.parts.filter((stored) => stored.type === `tool-${toolName}`);
  expect(parts).toHaveLength(1);
  return { conversationId, part: toolPartSchema.parse(parts[0]) };
}

/** The chip link a stored tool part yields: the UI's toResourceRef rule (apps/ui-v2/src/tool-calls.ts). */
function chipLink(part: ToolPart, idField: string): { id: string; spaceId: string } | null {
  const output = part.output;
  if (part.state !== 'output-available' || output === undefined || output.ok === false) return null;
  const id = output[idField];
  const linkedSpace = output.spaceId;
  if (typeof id !== 'string' || id === '' || typeof linkedSpace !== 'string' || linkedSpace === '') return null;
  return { id, spaceId: linkedSpace };
}

async function countRows(table: 'tasks' | 'reminders' | 'timers', id: string): Promise<number> {
  const source = table === 'tasks' ? 'bob.tasks' : table === 'reminders'
    ? "bob.reminders where kind = 'reminder'" : "bob.reminders where kind <> 'reminder'";
  const rows = await withUserRaw(server.pg, server.userId, (tx) => tx.query<{ n: number }>(
    `select count(*)::int as n from ${source}${source.includes(' where ') ? ' and' : ' where'} id = $1`, [id]));
  return rows.rows[0]!.n;
}

beforeAll(async () => {
  server = await bootIntegrationServer();
  // The harness boots in AI-stub mode (=1); the web chat reads the scripted
  // opt-in per request, so this file alone answers from the scripted model.
  process.env.BOB_AI_STUB = 'scripted';
  const { ensurePrivateSpace } = await import('../../src/spaces/store.ts');
  spaceId = (await ensurePrivateSpace(server.db, server.userId)).id;
});

afterAll(async () => {
  process.env.BOB_AI_STUB = '1';
  await server?.close();
});

describe('tool calls through /api/chat on the scripted stub agent', () => {
  it('a task sentence writes one task row and the stored reply links it', async () => {
    const { part } = await chatTurn('e2e add a task called integration pack lunches', 'create_task');
    const link = chipLink(part, 'taskId');
    expect(link).not.toBeNull();
    expect(link!.spaceId).toBe(spaceId);
    expect(await countRows('tasks', link!.id)).toBe(1);
    const listed = await server.api<{ tasks: Array<{ id: string }> }>(`/api/spaces/${spaceId}/tasks`);
    expect(listed.body.tasks.filter((task) => task.id === link!.id)).toHaveLength(1);
  });

  it('a reminder sentence writes one reminder row and the stored reply links it', async () => {
    const { part } = await chatTurn('e2e remind me in 90 minutes to integration call the dentist', 'create_reminder');
    const link = chipLink(part, 'reminderId');
    expect(link).not.toBeNull();
    expect(link!.spaceId).toBe(spaceId);
    expect(await countRows('reminders', link!.id)).toBe(1);
    const listed = await server.api<{ reminders: Array<{ id: string }> }>(`/api/spaces/${spaceId}/reminders`);
    expect(listed.body.reminders.filter((reminder) => reminder.id === link!.id)).toHaveLength(1);
  });

  it('a timer sentence writes one timer row and pushes timers_state to the device', async () => {
    const device = await connectDevice(server);
    device.reset();
    const before = server.journal.length;
    const { part } = await chatTurn('e2e start a 20 minute timer called integration pasta', 'set_timer');
    expect(part.state).toBe('output-available');
    const timerId = part.output?.id;
    expect(typeof timerId).toBe('string');
    expect(await countRows('timers', timerId as string)).toBe(1);

    const pushed = await device.waitFor('timers_state', 10_000);
    expect((pushed.payload.timers as Array<{ id: string }>).map((timer) => timer.id)).toContain(timerId);
    const changed = events(server.journal, 'v2.timers_state', before).filter((entry) => entry.reason === 'changed');
    expect(changed).toHaveLength(1);
    device.close();
    await device.waitForClose();
  });
});
