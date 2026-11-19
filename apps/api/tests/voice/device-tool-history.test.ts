/**
 * D1 (#1007 live probe): a device turn that ran a tool must reach the NEXT
 * turn's model as that tool call and its result, not as bare text. The device
 * path used to save and replay text only, so the model saw past
 * "Set a timer..." -> "I've set a timer..." pairs with no tool call and
 * copied the confirmation without calling set_timer. Web chat replays its
 * tool parts and never showed the defect.
 *
 * Real ToolLoopAgent over a MockLanguageModelV4 (no network) and a real test
 * database: turn 1 calls a tool, its parts are saved by persistDeviceTurn,
 * loadCardputerHistory reads them back, and turn 2's model prompt is checked.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import type { Db } from '../../src/platform/db/db.ts';
import { appendMessage, createConversation, getConversation } from '../../src/conversations/store.ts';
import { AccountEvents } from '../../src/account/events-bus.ts';
import { loadCardputerHistory, persistDeviceTurn } from '../../src/voice/cardputer-conversation.ts';
import { deviceToolParts } from '../../src/voice/turn-core.ts';
import { runAgent } from '../../src/voice/turn/agent.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let owner: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  owner = (await addAccount(pg)).userId;
});
afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

const USAGE = {
  inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0, text: 2, reasoning: 0 },
  totalTokens: 6,
};
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

function toolCallStep(): GenerateResult {
  return {
    content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'set_timer', input: JSON.stringify({ duration: 'PT3M' }) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: USAGE,
    warnings: [],
  };
}

function textStep(text: string): GenerateResult {
  return { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE, warnings: [] };
}

const SET = 'Set a timer for three minutes.';
const DONE = "I've set a timer for 3 minutes.";

function timerTool(fails = false) {
  return tool({
    description: 'Set a timer.',
    inputSchema: z.object({ duration: z.string() }),
    execute: async (): Promise<{ ok: true; timerId: string }> => {
      if (fails) throw new Error('secret store detail');
      return { ok: true, timerId: 'tmr_1' };
    },
  });
}

/** Runs turn 1 (a tool call, then the confirmation) and returns the agent and its model. */
async function firstTurn(fails = false): Promise<{ model: MockLanguageModelV4; agent: never; parts: Array<Record<string, unknown>>; text: string }> {
  const model = new MockLanguageModelV4({ doGenerate: [toolCallStep(), textStep(DONE), textStep('Another one, set.')] });
  const agent = new ToolLoopAgent({ model, tools: { set_timer: timerTool(fails) }, stopWhen: stepCountIs(4) });
  const result = await runAgent([{ role: 'user', content: SET }], agent as never);
  return { model, agent: agent as never, parts: deviceToolParts(result.steps ?? []), text: result.text };
}

function turn(pinnedRef: string, replyText: string, toolParts: Array<Record<string, unknown>>, heardChars?: number) {
  return {
    pinnedRef, sessionId: `sess_${randomUUID().slice(0, 8)}`, turnRef: 'turn_a1b2c3d4', deviceId: null,
    transcriptText: SET, replyText, toolParts, heardChars,
  };
}

/** The roles and part types the model was shown on its Nth call. */
function promptShape(model: MockLanguageModelV4, call: number): Array<{ role: string; types: string[] }> {
  const prompt = model.doGenerateCalls[call]?.prompt ?? [];
  return prompt
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role,
      types: typeof message.content === 'string' ? ['string'] : message.content.map((part) => part.type),
    }));
}

describe('device history replays tool calls (D1)', () => {
  it('a saved tool turn reaches the next model call as tool-call + tool-result, then its text', async () => {
    const conversation = await createConversation(db, owner, 'Timers');
    const first = await firstTurn();
    expect(first.text).toBe(DONE);
    await persistDeviceTurn(db, owner, turn(conversation.id, first.text, first.parts), new AccountEvents());

    const history = await loadCardputerHistory(db, owner, conversation.id);
    await runAgent([...history, { role: 'user', content: SET }], first.agent);

    expect(promptShape(first.model, 2)).toEqual([
      { role: 'user', types: ['text'] },
      { role: 'assistant', types: ['tool-call'] },
      { role: 'tool', types: ['tool-result'] },
      { role: 'assistant', types: ['text'] },
      { role: 'user', types: ['text'] },
    ]);
    const prompt = first.model.doGenerateCalls[2]?.prompt ?? [];
    expect(JSON.stringify(prompt)).toContain('"toolName":"set_timer"');
    expect(JSON.stringify(prompt)).toContain('tmr_1');
  });

  it('a barge-in cut keeps the tool call: only the text is shortened to what was heard', async () => {
    const conversation = await createConversation(db, owner, 'Cut');
    const first = await firstTurn();
    await persistDeviceTurn(db, owner, turn(conversation.id, first.text, first.parts, 4), new AccountEvents());

    const stored = await getConversation(db, owner, conversation.id);
    const selected = stored?.messages.at(-1)?.versions.at(-1)?.parts ?? [];
    expect(selected.map((part) => (part as { type: string }).type)).toEqual(['step-start', 'tool-set_timer', 'step-start', 'text']);
    expect(selected.at(-1)).toEqual({ type: 'text', text: "I've" });
    const history = await loadCardputerHistory(db, owner, conversation.id);
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('nothing heard keeps the tool call and stores no empty text part', async () => {
    const conversation = await createConversation(db, owner, 'Unheard');
    const first = await firstTurn();
    await persistDeviceTurn(db, owner, turn(conversation.id, first.text, first.parts, 0), new AccountEvents());

    const stored = await getConversation(db, owner, conversation.id);
    const selected = stored?.messages.at(-1)?.versions.at(-1)?.parts ?? [];
    expect(selected.map((part) => (part as { type: string }).type)).toEqual(['step-start', 'tool-set_timer', 'step-start']);
    const history = await loadCardputerHistory(db, owner, conversation.id);
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(JSON.stringify(history)).not.toContain('"text":""');
  });

  it('a file part in a tool reply is replayed as its placeholder, never its payload', async () => {
    const conversation = await createConversation(db, owner, 'File');
    const first = await firstTurn();
    const file = { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,QUJD' };
    await appendMessage(db, owner, conversation.id, { role: 'assistant', parts: [...first.parts, { type: 'step-start' }, file, { type: 'text', text: DONE }] });
    const history = await loadCardputerHistory(db, owner, conversation.id);
    expect(history.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(JSON.stringify(history.at(-1))).toContain('[file: image/png]');
    expect(JSON.stringify(history)).not.toContain('base64');
  });

  it('a failed tool is saved as an output-error with a fixed text, never the error message', async () => {
    const first = await firstTurn(true);
    expect(first.parts).toEqual([
      { type: 'step-start' },
      { type: 'tool-set_timer', toolCallId: 'call-1', state: 'output-error', input: { duration: 'PT3M' }, errorText: 'The tool failed.' },
    ]);
    expect(JSON.stringify(first.parts)).not.toContain('secret store detail');
  });

  it('a step with no tool parts adds nothing; a text-only turn still loads as plain strings', async () => {
    const textOnly = [{ type: 'text', text: 'hi' }];
    expect(deviceToolParts([{ content: textOnly }])).toEqual([]);
    const conversation = await createConversation(db, owner, 'Plain');
    await persistDeviceTurn(db, owner, turn(conversation.id, 'Hello.', []), new AccountEvents());
    expect(await loadCardputerHistory(db, owner, conversation.id)).toEqual([
      { role: 'user', content: SET },
      { role: 'assistant', content: 'Hello.' },
    ]);
  });
});
