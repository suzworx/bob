/**
 * #550 scripted stub agent: fixed e2e sentences make fixed tool calls through
 * a real ToolLoopAgent, everything else is the System test echo, and the model
 * cannot be built outside stub mode or under BOB_PRODUCTION=1. No network.
 */
import { describe, expect, it } from 'vitest';
import { ToolLoopAgent, createAgentUIStreamResponse, tool, type Tool, type UIMessage } from 'ai';
import { z } from 'zod';
import { scriptedStubAllowed } from '../src/config.ts';
import { STUB_SCRIPT, createStubChatModel, scriptStubTurn } from '../src/stub-agent.ts';

const STUB_ENV: NodeJS.ProcessEnv = { BOB_AI_STUB: 'scripted' };

/** A tool that records every input it is called with. */
function recordingTool(calls: unknown[]): Tool {
  return tool({
    description: 'records its input',
    inputSchema: z.object({}).passthrough(),
    execute: async (input: unknown): Promise<{ ok: true }> => {
      calls.push(input);
      return { ok: true };
    },
  });
}

describe('scriptStubTurn', () => {
  it('maps bounded review feedback to text only, without approval or identity fields', () => {
    expect(scriptStubTurn('e2e add a marketing review note called Make Monday warmer.')).toEqual({
      toolName: 'add_marketing_review_note', input: { text: 'Make Monday warmer.' },
    });
    expect(scriptStubTurn(`e2e add a marketing review note called ${'x'.repeat(1001)}`)).toBeNull();
    expect(scriptStubTurn('e2e approve the marketing plan')).toBeNull();
  });
  it('maps the bounded Marketing test sentences to non-publishing tool calls', () => {
    expect(scriptStubTurn('e2e create a marketing campaign called Small joys')).toEqual({
      toolName: 'create_campaign',
      input: { name: 'Small joys', goal: 'beta_interest', channels: ['instagram', 'linkedin'] },
    });
    expect(scriptStubTurn('e2e save an instagram draft called A little joy.')).toEqual({
      toolName: 'save_draft',
      input: { channel: 'instagram', format: 'image', body: 'A little joy.', altText: 'Original Bob artwork', pillar: 'Joy', approvedAssetIds: ['bob-playful'], claimIds: [], cta: 'none' },
    });
    expect(scriptStubTurn('e2e save a linkedin draft called Small moments matter.')).toEqual({
      toolName: 'save_draft',
      input: { channel: 'linkedin', format: 'text', body: 'Small moments matter.', altText: 'Original Bob artwork', pillar: 'Joy', approvedAssetIds: ['bob-playful'], claimIds: [], cta: 'none' },
    });
    expect(scriptStubTurn('e2e group marketing content by pillar')).toEqual({
      toolName: 'propose_marketing_config',
      input: { expectedConfigRevision: 1, config: { visibleViews: ['campaign', 'content', 'schedule', 'results'], contentGrouping: 'pillar', defaultChannels: ['instagram', 'linkedin'] } },
    });
  });

  it('maps each test sentence to its fixed tool call', () => {
    expect(scriptStubTurn('e2e add a task called Buy milk e2e-1')).toEqual({
      toolName: 'create_task',
      input: { title: 'Buy milk e2e-1' },
    });
    expect(scriptStubTurn('  e2e start a 10 minute timer called pasta  ')).toEqual({
      toolName: 'set_timer',
      input: { duration: 'PT10M', label: 'pasta' },
    });
    expect(scriptStubTurn('e2e play animal riddles as Maya')).toEqual({
      toolName: 'start_game',
      input: { game: 'animal_riddles', players: [{ name: 'Maya' }] },
    });
  });

  it('maps the reminder sentence to a create_reminder call due N minutes from now', () => {
    const before = Date.now();
    const call = scriptStubTurn('e2e remind me in 90 minutes to call the dentist');
    expect(call?.toolName).toBe('create_reminder');
    expect(call?.input.text).toBe('call the dentist');
    const due = Date.parse(String(call?.input.when));
    expect(due).toBeGreaterThanOrEqual(before + 90 * 60_000);
    expect(due).toBeLessThanOrEqual(Date.now() + 90 * 60_000);
    expect(scriptStubTurn('e2e remind me in ninety minutes to call')).toBeNull();
  });

  it('matches whole sentences only', () => {
    expect(scriptStubTurn('please add a task called milk')).toBeNull();
    expect(scriptStubTurn('hi e2e add a task called milk')).toBeNull();
    expect(scriptStubTurn('e2e start a ten minute timer called pasta')).toBeNull();
    expect(scriptStubTurn('')).toBeNull();
    expect(scriptStubTurn('please e2e group marketing content by pillar')).toBeNull();
    expect(scriptStubTurn('e2e group marketing content by pillar and publish')).toBeNull();
    expect(scriptStubTurn(`e2e create a marketing campaign called ${'x'.repeat(81)}`)).toBeNull();
    expect(scriptStubTurn(`e2e save an instagram draft called ${'x'.repeat(501)}`)).toBeNull();
  });

  it('has a unique id per entry', () => {
    const ids = STUB_SCRIPT.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('scriptedStubAllowed', () => {
  it('needs the explicit BOB_AI_STUB=scripted opt-in', () => {
    expect(scriptedStubAllowed({})).toBe(false);
    expect(scriptedStubAllowed({ BOB_AI_STUB: 'scripted' })).toBe(true);
    // The canned stubs stay canned: contract test 13 (no store) still holds.
    expect(scriptedStubAllowed({ BOB_AI_STUB: '1' })).toBe(false);
    expect(scriptedStubAllowed({ BOB_SYSTEM_TEST: '1' })).toBe(false);
  });

  it('is refused under BOB_PRODUCTION=1 whatever else is set', () => {
    expect(scriptedStubAllowed({ BOB_AI_STUB: 'scripted', BOB_PRODUCTION: '1' })).toBe(false);
  });
});

describe('createStubChatModel', () => {
  it('streams a real offered app proposal receipt for a bounded creation request', async () => {
    const calls: unknown[] = [];
    const receipt = { ok: true, untrusted: true, data: { id: '11111111-1111-4111-8111-111111111111',
      title: 'Small wins', status: 'draft', revision: 1, url: '/apps/11111111-1111-4111-8111-111111111111', requiresApply: false } };
    const agent = new ToolLoopAgent({ model: createStubChatModel(STUB_ENV), tools: {
      propose_bob_app: tool({ inputSchema: z.strictObject({ definition: z.unknown() }),
        execute: async (input) => { calls.push(input); return receipt; } }),
    } });
    const response = await createAgentUIStreamResponse({ agent, uiMessages: [
      { id: 'create-app-source', role: 'user', parts: [{ type: 'text', text: 'e2e make an app called Small wins' }] },
    ] });
    const body = await response.text();
    expect(calls).toEqual([{ definition: { schemaVersion: 1, title: 'Small wins', lifecycle: 'keep',
      tables: [{ id: 'items', fields: [{ id: 'text', type: 'text' }, { id: 'done', type: 'boolean' }] }],
      actions: [{ id: 'add_item', table: 'items', operation: 'create' }, { id: 'update_item', table: 'items', operation: 'update' }],
      metrics: [], views: [{ id: 'main', kind: 'checklist', title: 'Small wins', table: 'items', fields: ['text', 'done'], actions: ['add_item', 'update_item'] }],
    } }]);
    expect(body).toContain('"toolName":"propose_bob_app"');
    expect(body).toContain('"status":"draft"');
    expect(body).toContain('"url":"/apps/11111111-1111-4111-8111-111111111111"');
    expect(body).not.toContain('"toolName":"activate_bob_app"');
    expect(body).not.toContain('"toolName":"apply_bob_app"');
  });

  it('keeps app creation closed when unoffered and rejects overlong or unanchored requests', async () => {
    const prompt = 'e2e make an app called Small wins';
    const result = await new ToolLoopAgent({ model: createStubChatModel(STUB_ENV), tools: {} }).generate({ prompt });
    expect(result.steps.flatMap((step) => step.toolCalls)).toEqual([]);
    expect(result.text).toBe(`System test response: ${prompt}`);
    expect(scriptStubTurn(`e2e make an app called ${'x'.repeat(81)}`)).toBeNull();
    expect(scriptStubTurn('please e2e make an app called Small wins')).toBeNull();
  });

  it('reads the bound app before a title-only proposal without replacing its other declarations', async () => {
    const definition = { schemaVersion: 1, title: 'Original', tables: [{ id: 'items' }], actions: [], metrics: [], views: [{ id: 'main' }] };
    const revisions: unknown[] = [];
    const agent = new ToolLoopAgent({ model: createStubChatModel(STUB_ENV), tools: {
      read_bob_app: tool({ inputSchema: z.strictObject({}), execute: async () => ({ ok: true, data: { revision: 7, definition } }) }),
      revise_bob_app: recordingTool(revisions),
    } });
    const result = await agent.generate({ prompt: 'e2e rename this app to Warmer checklist' });
    expect(result.steps.flatMap((step) => step.toolCalls.map((entry) => entry.toolName))).toEqual(['read_bob_app', 'revise_bob_app']);
    expect(revisions).toEqual([{ expectedRevision: 7, definition: { ...definition, title: 'Warmer checklist' } }]);
    expect(result.text).toBe('Stub: revise_bob_app finished.');
  });

  it('does not propose a rename after a refused read or without an offered revision tool', async () => {
    const revisions: unknown[] = [];
    const result = await new ToolLoopAgent({ model: createStubChatModel(STUB_ENV), tools: {
      read_bob_app: tool({ inputSchema: z.strictObject({}), execute: async () => ({ ok: false, error: 'app_unavailable' }) }),
      revise_bob_app: recordingTool(revisions),
    } }).generate({ prompt: 'e2e rename this app to New title' });
    expect(revisions).toEqual([]);
    expect(result.steps.flatMap((step) => step.toolCalls.map((entry) => entry.toolName))).toEqual(['read_bob_app']);
    const readOnly = await new ToolLoopAgent({ model: createStubChatModel(STUB_ENV), tools: {
      read_bob_app: tool({ inputSchema: z.strictObject({}), execute: async () => ({ ok: true, data: { revision: 1, definition: { title: 'Original' } } }) }),
    } }).generate({ prompt: 'e2e rename this app to New title' });
    expect(readOnly.steps.flatMap((step) => step.toolCalls.map((entry) => entry.toolName))).toEqual(['read_bob_app']);
  });

  it('saves a bounded unsupported app idea only through its offered callback', async () => {
    const prompt = 'e2e save an app idea called Track email automatically.';
    const calls: unknown[] = [];
    const agent = new ToolLoopAgent({ model: createStubChatModel(STUB_ENV), tools: { save_app_idea: recordingTool(calls) } });
    const result = await agent.generate({ prompt });
    expect(calls).toEqual([{ text: 'Track email automatically.' }]);
    expect(result.text).toBe('Stub: save_app_idea finished.');
    const unbound = new ToolLoopAgent({ model: createStubChatModel(STUB_ENV), tools: {} });
    const fallback = await unbound.generate({ prompt });
    expect(fallback.steps.flatMap((step) => step.toolCalls)).toEqual([]);
    expect(fallback.text).toBe(`System test response: ${prompt}`);
    expect(scriptStubTurn(`e2e save an app idea called ${'x'.repeat(2001)}`)).toBeNull();
    expect(scriptStubTurn('e2e apply the app proposal')).toBeNull();
  });
  it('executes a review note once through the offered tool and echoes it when absent', async () => {
    const prompt = 'e2e add a marketing review note called Make Monday warmer.';
    const calls: unknown[] = [];
    const agent = new ToolLoopAgent({ model: createStubChatModel(STUB_ENV), tools: { add_marketing_review_note: recordingTool(calls) } });
    const result = await agent.generate({ prompt });
    expect(calls).toEqual([{ text: 'Make Monday warmer.' }]);
    expect(result.text).toBe('Stub: add_marketing_review_note finished.');
    const unbound = new ToolLoopAgent({ model: createStubChatModel(STUB_ENV), tools: {} });
    const fallback = await unbound.generate({ prompt });
    expect(fallback.steps.flatMap((step) => step.toolCalls)).toEqual([]);
    expect(fallback.text).toBe(`System test response: ${prompt}`);
  });
  it('scripts one saved week through the offered tool, with no paid call', async () => {
    const calls: Array<{ name: string; goal: string; story: string; posts: Array<{ day: number; channel: string; beat: string; body: string }> }> = [];
    const agent = new ToolLoopAgent({ model: createStubChatModel(STUB_ENV), tools: { save_week_plan: recordingTool(calls as unknown[]) } });
    const result = await agent.generate({ prompt: 'e2e plan a week called Small joys' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'Small joys', goal: 'beta_interest', channels: ['instagram', 'linkedin'] });
    expect(calls[0]?.posts).toHaveLength(7);
    expect(new Set(calls[0]?.posts.map((post) => post.beat)).size).toBe(7);
    expect(result.text).toBe('Stub: save_week_plan finished.');
    expect(scriptStubTurn('please e2e plan a week called Small joys')).toBeNull();
  });

  it.each([
    ['e2e create a marketing campaign called Small joys', 'create_campaign', { name: 'Small joys', goal: 'beta_interest' }],
    ['e2e save an instagram draft called A little joy.', 'save_draft', { channel: 'instagram', format: 'image', body: 'A little joy.' }],
    ['e2e save a linkedin draft called Small moments matter.', 'save_draft', { channel: 'linkedin', format: 'text', body: 'Small moments matter.' }],
    ['e2e group marketing content by pillar', 'propose_marketing_config', { expectedConfigRevision: 1, config: { visibleViews: ['campaign', 'content', 'schedule', 'results'], contentGrouping: 'pillar', defaultChannels: ['instagram', 'linkedin'] } }],
  ])('executes only the offered Marketing callback for %s', async (prompt, toolName, expectedInput) => {
    const calls: unknown[] = [];
    const agent = new ToolLoopAgent({ model: createStubChatModel(STUB_ENV), tools: { [toolName]: recordingTool(calls) } });
    const result = await agent.generate({ prompt });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject(expectedInput);
    expect(result.text).toBe(`Stub: ${toolName} finished.`);
  });

  it('does not emit or execute a Marketing call absent from the offered tools', async () => {
    const calls: unknown[] = [];
    const prompt = 'e2e save an instagram draft called A little joy.';
    const agent = new ToolLoopAgent({ model: createStubChatModel(STUB_ENV), tools: { create_task: recordingTool(calls) } });
    const result = await agent.generate({ prompt });
    expect(calls).toEqual([]);
    expect(result.steps.flatMap((step) => step.toolCalls)).toEqual([]);
    expect(result.text).toBe(`System test response: ${prompt}`);
  });

  it('cannot be built outside stub mode or in production', () => {
    expect(() => createStubChatModel({})).toThrow(/BOB_PRODUCTION/);
    expect(() => createStubChatModel({ BOB_AI_STUB: 'scripted', BOB_PRODUCTION: '1' })).toThrow(/refused/);
  });

  it('runs the scripted tool call and answers the result (generate)', async () => {
    const calls: unknown[] = [];
    const agent = new ToolLoopAgent({ model: createStubChatModel(STUB_ENV), tools: { create_task: recordingTool(calls) } });
    const result = await agent.generate({ prompt: 'e2e add a task called Water plants' });
    expect(calls).toEqual([{ title: 'Water plants' }]);
    expect(result.text).toBe('Stub: create_task finished.');
  });

  it('echoes an unscripted sentence without calling a tool', async () => {
    const calls: unknown[] = [];
    const agent = new ToolLoopAgent({ model: createStubChatModel(STUB_ENV), tools: { create_task: recordingTool(calls) } });
    const result = await agent.generate({ prompt: 'what time is it?' });
    expect(calls).toEqual([]);
    expect(result.text).toBe('System test response: what time is it?');
  });

  it('streams the same tool call through a web-style turn', async () => {
    const calls: unknown[] = [];
    const agent = new ToolLoopAgent({ model: createStubChatModel(STUB_ENV), tools: { set_timer: recordingTool(calls) } });
    const uiMessages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'e2e start a 5 minute timer called tea' }] },
    ];
    const response = await createAgentUIStreamResponse({ agent, uiMessages });
    const body = await response.text();
    expect(calls).toEqual([{ duration: 'PT5M', label: 'tea' }]);
    expect(body).toContain('"toolName":"set_timer"');
    expect(body).toContain('Stub: set_timer finished.');
  });

  it('streams a Marketing draft through the offered web-style tool', async () => {
    const calls: unknown[] = [];
    const agent = new ToolLoopAgent({ model: createStubChatModel(STUB_ENV), tools: { save_draft: recordingTool(calls) } });
    const uiMessages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'e2e save an instagram draft called A little joy.' }] },
    ];
    const response = await createAgentUIStreamResponse({ agent, uiMessages });
    const body = await response.text();
    expect(calls).toEqual([{
      channel: 'instagram', format: 'image', body: 'A little joy.', altText: 'Original Bob artwork', pillar: 'Joy',
      approvedAssetIds: ['bob-playful'], claimIds: [], cta: 'none',
    }]);
    expect(body).toContain('"toolName":"save_draft"');
    expect(body).toContain('Stub: save_draft finished.');
  });
});
