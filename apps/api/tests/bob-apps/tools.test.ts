import { beforeEach, expect, it, vi } from 'vitest';
import { createBobAppTools } from '../../src/bob-apps/tools.ts';
import type { Tool } from 'ai';
import type { Db } from '../../src/platform/db/db.ts';
import { packing } from './fixtures.ts';
const mocks = vi.hoisted(() => ({ space: vi.fn(), policy: vi.fn(), create: vi.fn(), list: vi.fn(), read: vi.fn(), mutate: vi.fn() }));
vi.mock('../../src/spaces/store.ts', () => ({ getSpace: mocks.space }));
vi.mock('../../src/tools/policy.ts', () => ({ assertToolEnabled: mocks.policy }));
vi.mock('../../src/bob-apps/store.ts', () => ({ createBobApp: mocks.create, listBobApps: mocks.list, getBobApp: mocks.read, mutateBobApp: mocks.mutate }));
const db = {} as Db;
const app = { id: '11111111-1111-4111-8111-111111111111', spaceId: null, definition: packing, state: {}, lifecycle: 'draft', revision: 1, pendingDefinition: null };
function run(name: string, input: unknown = {}): unknown {
  const execute = (createBobAppTools(db, 'owner', 'private-space')[name] as Tool<unknown>)?.execute;
  if (!execute) throw new Error('missing_tool');
  return execute(input, { toolCallId: 'call-1', messages: [], context: undefined });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.space.mockResolvedValue({ kind: 'private', ownerUserId: 'owner', archivedAt: null });
  mocks.policy.mockResolvedValue(undefined);
  mocks.create.mockResolvedValue(app); mocks.read.mockResolvedValue(app); mocks.list.mockResolvedValue([{ ...app, title: packing.title }]); mocks.mutate.mockResolvedValue({ ...app, pendingDefinition: packing });
});
it('creates only a draft preview with a server mutation ID', async () => {
  expect(await run('propose_bob_app', { definition: packing })).toMatchObject({ ok: true, untrusted: true, data: { status: 'draft', url: `/apps/${app.id}` } });
  expect(mocks.create).toHaveBeenCalledWith(db, 'owner', { definition: packing, mutationId: expect.any(String) });
  expect(mocks.mutate).not.toHaveBeenCalled();
});
it.each(['pair', 'group'])('refuses %s spaces before reading app data', async (kind) => {
  mocks.space.mockResolvedValue({ kind, ownerUserId: 'owner', archivedAt: null });
  expect(await run('list_bob_apps')).toMatchObject({ ok: false });
  expect(mocks.list).not.toHaveBeenCalled();
});
it('refuses unknown scope and other private owners', async () => {
  mocks.space.mockResolvedValue({ kind: 'private', ownerUserId: 'other', archivedAt: null });
  expect(await run('list_bob_apps')).toMatchObject({ ok: false });
  expect(mocks.list).not.toHaveBeenCalled();
});
it('checks preferences again for every execution and fails closed', async () => {
  await run('list_bob_apps');
  mocks.policy.mockRejectedValue(new Error('private internal details'));
  expect(await run('list_bob_apps')).toEqual({ ok: false, error: 'app_unavailable' });
  expect(mocks.policy).toHaveBeenCalledTimes(2); expect(mocks.list).toHaveBeenCalledTimes(1);
});
it.each([null, '{broken', { ...packing, script: 'execute()' }, { ...packing, schedules: [] }])('refuses malformed or executable definition', async (definition) => {
  expect(await run('propose_bob_app', { definition })).toMatchObject({ ok: false, error: 'invalid_app_input' });
  expect(mocks.create).not.toHaveBeenCalled();
});
it('proposes revisions without records or activation and tells users to apply', async () => {
  expect(await run('revise_bob_app', { appId: app.id, expectedRevision: 1, definition: packing })).toMatchObject({ ok: true, data: { requiresApply: true } });
  expect(mocks.mutate).toHaveBeenCalledWith(db, 'owner', app.id, { operation: 'revise', expectedRevision: 1, definition: packing, mutationId: expect.any(String) });
});
it.each(['read_bob_app', 'revise_bob_app'])('private %s cannot target a shared app by a supplied ID', async (name) => {
  mocks.read.mockResolvedValue({ ...app, spaceId: 'group-space' });
  const input = name === 'read_bob_app' ? { appId: app.id } : { appId: app.id, expectedRevision: 1, definition: packing };
  expect(await run(name, input)).toMatchObject({ ok: false, error: 'app_unavailable' });
  expect(mocks.mutate).not.toHaveBeenCalled();
});
it('bounds app lists and marks their contents as untrusted', async () => {
  mocks.list.mockResolvedValue(Array.from({ length: 25 }, () => ({ ...app, title: packing.title })));
  expect(await run('list_bob_apps')).toMatchObject({ ok: true, untrusted: true, data: { truncated: true, apps: expect.any(Array) } });
  const result = await run('list_bob_apps') as { data: { apps: unknown[] } }; expect(result.data.apps).toHaveLength(20);
});


it('refuses archived or inaccessible spaces without leaking store errors', async () => {
  mocks.space.mockResolvedValue({ kind: 'private', ownerUserId: 'owner', archivedAt: 1 });
  expect(await run('list_bob_apps')).toMatchObject({ ok: false });
  mocks.space.mockRejectedValue(new Error('sensitive details'));
  expect(await run('list_bob_apps')).toEqual({ ok: false, error: 'app_unavailable' });
  expect(mocks.list).not.toHaveBeenCalled();
});
it('bounds record samples and never offers record mutation or activation tools', async () => {
  mocks.read.mockResolvedValue({ ...app, state: { items: Array.from({ length: 30 }, (_, i) => ({ id: `row_${i}`, values: { label: 'sample', packed: false } })) } });
  const result = await run('read_bob_app', { appId: app.id }) as { data: { state: { items: unknown[] }; recordSampleOnly: boolean } };
  expect(result.data.state.items).toHaveLength(3); expect(result.data.recordSampleOnly).toBe(true);
  expect(Object.keys(createBobAppTools(db, 'owner', 'private-space')).sort()).toEqual(['list_bob_apps', 'propose_bob_app', 'read_bob_app', 'revise_bob_app']);
});
it('runs the actual proposal schema through native ToolLoopAgent', async () => {
  const { ToolLoopAgent, stepCountIs } = await import('ai');
  const { MockLanguageModelV4 } = await import('ai/test');
  const usage = { inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 }, totalTokens: 6 };
  const model = new MockLanguageModelV4({ doGenerate: [
    { content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'propose_bob_app', input: JSON.stringify({ definition: packing }) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] },
    { content: [{ type: 'text', text: 'Preview ready.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] },
  ] });
  const result = await new ToolLoopAgent({ model, tools: createBobAppTools(db, 'owner', 'private-space'), stopWhen: stepCountIs(2) }).generate({ prompt: 'Create a packing app.' });
  expect(result.steps).toHaveLength(2); expect(mocks.create).toHaveBeenCalledOnce();
});

it.each([
  { field: 'lifecycle', definition: { ...packing, lifecycle: 'draft' } },
  { field: 'views', definition: { ...packing, views: [] } },
])('returns repair feedback through the SDK for invalid $field before saving', async ({ field, definition }) => {
  const { ToolLoopAgent, stepCountIs } = await import('ai');
  const { MockLanguageModelV4 } = await import('ai/test');
  const usage = { inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 }, totalTokens: 6 };
  const model = new MockLanguageModelV4({ doGenerate: [
    { content: [{ type: 'tool-call', toolCallId: 'bad', toolName: 'propose_bob_app', input: JSON.stringify({ definition }) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] },
    { content: [{ type: 'tool-call', toolCallId: 'fixed', toolName: 'propose_bob_app', input: JSON.stringify({ definition: packing }) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] },
    { content: [{ type: 'text', text: 'Preview ready.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] },
  ] });
  const result = await new ToolLoopAgent({ model, tools: createBobAppTools(db, 'owner', 'private-space'), stopWhen: stepCountIs(3) }).generate({ prompt: 'Create a saved app.' });
  expect(result.steps[0]?.toolResults[0]?.output).toMatchObject({ ok: false, error: 'invalid_app_input', retryable: true, issues: expect.arrayContaining([expect.objectContaining({ path: `definition.${field}` })]) });
  expect(mocks.create).toHaveBeenCalledOnce();
  expect(mocks.create).toHaveBeenCalledWith(db, 'owner', { definition: packing, mutationId: expect.any(String) });
});
