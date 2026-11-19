import { randomUUID } from 'node:crypto';
import { ToolLoopAgent, stepCountIs, type Tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { runWebChatTurn, type WebChatOutput } from '../../src/workflows/workflow-web-chat-turn.ts';
import { webChatRequestSchema } from '../../src/conversations/schemas.ts';
import { appendMessage, createConversation, getConversation, listConversations } from '../../src/conversations/store.ts';
import { getActive } from '../../src/conversations/active.ts';
import { changeMarketingLifecycle, installMarketingPackage } from '../../src/bob-apps/marketing-install.ts';
import { getCampaign, listCampaigns } from '../../src/bob-apps/marketing-store.ts';
import { readMarketingConfig } from '../../src/bob-apps/marketing-config-store.ts';
import { getBobApp, mutateBobApp } from '../../src/bob-apps/store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import type { AgentImpl, AgentPort } from '../../src/voice/agent-port.ts';
import type { WebChatDeps } from '../../src/conversations/chat-tools.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb, type TestAccount } from '../support/test-db.ts';
import { taskContextText, type CoreTaskContext } from '@bob/ai';
import { createAppTurnExtension } from '../../src/bob-apps/app-turn-extension.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';

vi.mock('../../src/memory/available.ts', () => ({ memoryAvailable: async () => false }));
vi.mock('../../src/platform/logger.ts', async () => (await import('../helpers/journal-mock.ts')).loggerMock());

let pg: TestDb;
let db: Db;
let scripted: { name: string; input: Record<string, unknown> } | null = null;
let offered: Record<string, Tool> = {};
let taskContext: unknown;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });
const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 }, totalTokens: 0 };
type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;
const model = new MockLanguageModelV4({ doStream: async ({ prompt }) => {
  const call = scripted;
  const runTool = call && prompt.at(-1)?.role !== 'tool';
  const parts: StreamPart[] = runTool
    ? [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: `transient-${randomUUID()}`, toolName: call.name, input: JSON.stringify(call.input) }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage }]
    : [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: 'Saved for review.' }, { type: 'text-end', id: 'reply' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }];
  return { stream: new ReadableStream<StreamPart>({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) };
} });
const agentPort: AgentPort = {
  kind: 'scripted',
  base: () => new ToolLoopAgent({ model }) as AgentImpl,
  create: (options) => { taskContext = options.taskContext; return { tools: options.filterTools?.({ ...options.capabilityTools, ...options.lateTools }) ?? {} } as AgentImpl; },
  createInvocation: () => new ToolLoopAgent({ model }) as AgentImpl,
  withOfferedTools: (_agent, tools) => { offered = tools; return new ToolLoopAgent({ model, tools, stopWhen: stepCountIs(3) }) as AgentImpl; },
};
function deps(): WebChatDeps {
  return { appTurnTools: createAppTurnExtension(saveAppIdea), getDb: async () => db, agent: agentPort, deviceSessions: { forAccount: () => [] }, timersChanged: () => {}, embedder: () => { throw new Error('no provider calls'); }, memoryWorker: null, recordTurnMetric: () => {} } as unknown as WebChatDeps;
}
function output() {
  const value = { status: 200, body: null as unknown, chunks: [] as string[], opened: false };
  const port: WebChatOutput = { json: (status, body) => { value.status = status; value.body = body; }, openStream: () => { value.opened = true; }, write: (chunk) => { value.chunks.push(String(chunk)); }, end: () => {}, headersSent: () => value.opened, onDisconnect: () => {} };
  return { value, port };
}
async function run(owner: TestAccount, body: unknown) {
  const out = output();
  const stop = new AbortController();
  await runWebChatTurn(deps(), { userId: owner.userId, request: webChatRequestSchema.parse(body), timeZone: () => 'UTC', cancellation: { turnId: `client-${randomUUID()}`, stop, bound: stop.signal, agentSignal: stop.signal } }, out.port, { boundHistoryAttachments: (messages) => messages, createFirstTextDetector: () => () => true });
  return out.value;
}
const message = (text = 'Prepare this campaign') => ({ id: `msg_${randomUUID()}`, role: 'user', parts: [{ type: 'text', text }] });
async function active(owner: TestAccount) {
  const item = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, owner.sessionId);
  return changeMarketingLifecycle(db, owner.userId, item.id, { operation: 'activate', expectedRevision: item.revision, mutationId: randomUUID() });
}

it('passes each explicit run intent to Core after authorization without rewriting the user message', async () => {
  const owner = await addAccount(pg);
  const installation = await active(owner);
  scripted = null;
  for (const intent of ['posts', 'campaign'] as const) {
    const text = `My exact rough copy for ${intent} 🌱`;
    expect((await run(owner, { message: message(text), appBinding: { installationId: installation.id, mode: 'run', intent } })).status).toBe(200);
    const focus = intent === 'posts'
      ? 'Build posts: favor creative drafting for the selected network and save requested drafts.'
      : 'Plan campaign: favor strategy and campaign planning, and save requested plan sections.';
    expect(taskContext).toEqual({ title: 'Bob Marketing', lines: [focus] });
    // The rendered section is byte-identical to the pre-extension text (spec 015 U1).
    expect(taskContextText(taskContext as CoreTaskContext)).toBe(`[Active task]\nBob Marketing. ${focus}\nExplicit user instructions take precedence over this convenience context. Use only offered tools; this does not grant permissions.\n[End active task]`);
    const conversation = (await listConversations(db, owner.userId))[0];
    if (!conversation) throw new Error('Missing conversation');
    const saved = await getConversation(db, owner.userId, conversation.id);
    expect(saved?.messages.find((entry) => entry.role === 'user')?.versions.find((version) => version.selected)?.parts).toEqual([{ type: 'text', text }]);
  }
  await run(owner, { message: message(), appBinding: { installationId: installation.id, mode: 'refine' } });
  expect(taskContext).toBeUndefined();
});

it('denies an explicit foreign binding before creating, moving a pointer, appending or truncating', async () => {
  const owner = await addAccount(pg);
  const other = await addAccount(pg);
  const installation = await active(other);
  const before = await listConversations(db, owner.userId);
  const binding = { installationId: installation.id, mode: 'run' };
  expect((await run(owner, { message: message(), appBinding: binding })).status).toBe(404);
  expect(await listConversations(db, owner.userId)).toEqual(before);
  expect(await getActive(db, owner.userId)).toBeNull();
  const conversation = await withUser(db, owner.userId, (tx) => createConversation(tx, owner.userId, 'Private'));
  await appendMessage(db, owner.userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'Preserve this message' }] });
  const original = await getConversation(db, owner.userId, conversation.id);
  expect((await run(owner, { id: conversation.id, editFromStart: true, message: message(), appBinding: binding })).status).toBe(404);
  expect(await getConversation(db, owner.userId, conversation.id)).toEqual(original);
});

it('says a paused app is paused, while archived and foreign apps stay the same not found', async () => {
  const owner = await addAccount(pg);
  const other = await addAccount(pg);
  const created = await installMarketingPackage(db, owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, owner.sessionId);
  const active = await changeMarketingLifecycle(db, owner.userId, created.id, { operation: 'activate', expectedRevision: created.revision, mutationId: randomUUID() });
  await changeMarketingLifecycle(db, owner.userId, active.id, { operation: 'pause', expectedRevision: active.revision, mutationId: randomUUID() });
  const binding = { installationId: active.id, mode: 'run' as const, intent: 'posts' as const };
  const paused = await run(owner, { message: message(), appBinding: binding });
  expect(paused.status).toBe(409);
  expect(paused.body).toEqual({ error: { code: 'app_paused', message: 'Marketing is paused. Resume it to keep going; your text is still here.' } });
  expect(paused.opened).toBe(false);
  expect(await listConversations(db, owner.userId)).toHaveLength(0);
  const foreign = await run(other, { message: message(), appBinding: binding });
  const missing = await run(other, { message: message(), appBinding: { ...binding, installationId: randomUUID() } });
  expect(foreign.status).toBe(404);
  expect(foreign.body).toEqual(missing.body);
  const app = await getBobApp(db, owner.userId, active.appId);
  await mutateBobApp(db, owner.userId, active.appId, { operation: 'archive', expectedRevision: app.revision, mutationId: randomUUID() });
  const archived = await run(owner, { message: message(), appBinding: binding });
  expect(archived.status).toBe(404);
  expect(archived.body).toEqual(missing.body);
});

it('runs the real offered campaign/config tools with persisted anchors and keeps campaign artifacts through refine', async () => {
  const owner = await addAccount(pg);
  const installation = await active(owner);
  scripted = { name: 'create_campaign', input: { name: 'Composer campaign', goal: 'beta_interest', channels: ['instagram', 'linkedin'] } };
  const first = await run(owner, { message: message(), appBinding: { installationId: installation.id, mode: 'run', channel: 'instagram' } });
  expect(first.status).toBe(200);
  expect(first.chunks.join('')).toContain('create_campaign');
  expect(Object.keys(offered)).toContain('create_campaign');
  const campaign = (await listCampaigns(db, owner.userId, installation.id, null)).items[0];
  expect(campaign?.name).toBe('Composer campaign');
  const conversation = (await listConversations(db, owner.userId))[0];
  if (!conversation || !campaign) throw new Error('persisted result missing');
  const saved = await getConversation(db, owner.userId, conversation.id);
  expect(saved?.messages.some((entry) => entry.role === 'user')).toBe(true);
  scripted = { name: 'propose_marketing_config', input: { expectedConfigRevision: 1, config: { visibleViews: ['content', 'campaign'], contentGrouping: 'pillar', defaultChannels: ['instagram'] } } };
  const refine = await run(owner, { id: conversation.id, message: message('Group content by pillar'), appBinding: { installationId: installation.id, mode: 'refine' } });
  expect(refine.chunks.join('')).toContain('propose_marketing_config');
  expect(Object.keys(offered)).not.toContain('create_campaign');
  const config = await readMarketingConfig(db, owner.userId, installation.id);
  expect(config.pending).toHaveLength(1);
  expect(config.installation.config.contentGrouping).toBe('none');
  expect((await getCampaign(db, owner.userId, installation.id, campaign.id)).name).toBe('Composer campaign');
});
