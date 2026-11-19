import { createGmailActionsService } from '../../src/integrations/google-mail-actions-service.ts';
import { setToolPreference } from '../../src/tools/store.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { stepCountIs, ToolLoopAgent, type Tool, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createGoogleTools } from '../../src/integrations/google-tools.ts';
import { createGoogleCalendarService } from '../../src/integrations/google-calendar-service.ts';
import { createGmailService } from '../../src/integrations/google-gmail-service.ts';
import { addGoogleAccount } from '../../src/integrations/google-store.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import type { GoogleCapability } from '../../src/integrations/google-credentials.ts';
import { isProviderContentTurn } from '../../src/memory/provider-content.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });
async function fixture(text = 'Check job updates in @{integration:Gmail:jobs@example.test}') {
  const { userId } = await addAccount(pg);
  const account = await addGoogleAccount(db, userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'jobs@example.test' });
  const conversation = await createConversation(db, userId, 'Private');
  const message = await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text }] });
  if (!message) throw new Error('missing fixture message');
  const resolveCredential = async () => 'token';
  return { db, userId, conversationId: conversation.id, messageId: message.id, accountId: account.id,
    allowNewOperations: true, getVerifiedCapabilities: async () => ['gmail.read' as const],
    calendar: createGoogleCalendarService({ db, resolveCredential }), gmail: createGmailService({ db, resolveCredential }) };
}
async function execute(tools: ToolSet, input: unknown): Promise<unknown> {
  const run = (tools.google_gmail_search as Tool<unknown, unknown> | undefined)?.execute;
  if (!run) throw new Error('missing tool');
  return run(input, { toolCallId: 'fixture-search', messages: [], context: undefined });
}
it.each([
  { accountId: undefined, mention: 'Gmail' }, { accountId: 'jobs@example.test', mention: 'Gmail' },
  { accountId: undefined, mention: 'Gmail.search' },
])('executes $mention search through SDK with selector $accountId', async ({ accountId, mention }) => {
  const f = await fixture(`Check job updates in @{integration:${mention}:jobs@example.test}`);
  const search = vi.spyOn(f.gmail, 'search').mockResolvedValue({ threads: [] });
  const tools = await createGoogleTools(f);
  const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } };
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    calls += 1;
    return calls === 1 ? { content: [{ type: 'tool-call' as const, toolCallId: 'fixture-search', toolName: 'google_gmail_search',
      input: JSON.stringify({ accountId, query: 'job updates' }) }], finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage, warnings: [] }
      : { content: [{ type: 'text' as const, text: 'Checked.' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] };
  } });
  const result = await new ToolLoopAgent({ model, tools, stopWhen: stepCountIs(3) }).generate({ prompt: 'Check job updates in @{integration:Gmail:jobs@example.test}' });
  expect(result.steps[0]?.toolResults[0]?.output).toMatchObject({ ok: true });
  expect(search).toHaveBeenCalledWith(f.userId, f.accountId, expect.objectContaining({ query: 'job updates' }), expect.any(AbortSignal));
});

it('uses the current mentioned account instead of the default, and rejects conflicting explicit selectors', async () => {
  const f = await fixture('Use @{integration:Gmail:second@example.test}');
  const second = await addGoogleAccount(db, f.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'second@example.test' });
  const search = vi.spyOn(f.gmail, 'search').mockResolvedValue({ threads: [] });
  const tools = await createGoogleTools(f);
  expect(await execute(tools, { accountId: f.accountId, query: 'jobs' })).toEqual({ ok: false, error: 'account_mismatch' });
  expect(search).not.toHaveBeenCalled();
  expect(await execute(tools, { query: 'jobs' })).toMatchObject({ ok: true });
  expect(search).toHaveBeenCalledWith(f.userId, second.id, expect.anything(), expect.any(AbortSignal));
});

it('asks for an account when multiple distinct mentions exist, but accepts an explicit mentioned account', async () => {
  const f = await fixture('@{integration:Gmail:jobs@example.test} and @{integration:Gmail:second@example.test}');
  await addGoogleAccount(db, f.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'second@example.test' });
  const search = vi.spyOn(f.gmail, 'search').mockResolvedValue({ threads: [] });
  const tools = await createGoogleTools(f);
  expect(await execute(tools, { query: 'jobs' })).toEqual({ ok: false, error: 'account_required' });
  expect(search).not.toHaveBeenCalled();
  expect(await execute(tools, { accountId: 'jobs@example.test', query: 'jobs' })).toMatchObject({ ok: true });
});

it('does not guess between two owned connections with the same email', async () => {
  const f = await fixture();
  await addGoogleAccount(db, f.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'jobs@example.test' });
  const search = vi.spyOn(f.gmail, 'search').mockResolvedValue({ threads: [] });
  const tools = await createGoogleTools(f);
  expect(await execute(tools, { query: 'jobs' })).toEqual({ ok: false, error: 'account_required' });
  expect(await execute(tools, { accountId: 'jobs@example.test', query: 'jobs' })).toEqual({ ok: false, error: 'account_required' });
  expect(search).not.toHaveBeenCalled();
  expect(await execute(tools, { accountId: f.accountId, query: 'jobs' })).toMatchObject({ ok: true });
});

it('deduplicates canonical mentions case-insensitively and keeps Gmail and Calendar selections separate', async () => {
  const f = await fixture('@{integration:Gmail:JOBS@example.test} @{integration:Gmail:jobs@example.test} @{integration:Google Calendar:calendar@example.test}');
  const calendarAccount = await addGoogleAccount(db, f.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'calendar@example.test' });
  const search = vi.spyOn(f.gmail, 'search').mockResolvedValue({ threads: [] });
  const calendars = vi.spyOn(f.calendar, 'listCalendars').mockResolvedValue({ items: [] });
  const tools = await createGoogleTools({ ...f, getVerifiedCapabilities: async (): Promise<GoogleCapability[]> => ['gmail.read', 'calendar.read'] });
  expect(await execute(tools, { query: 'jobs' })).toMatchObject({ ok: true });
  const run = (tools.google_calendar_list_calendars as Tool<unknown, unknown>)?.execute;
  if (!run) throw new Error('missing calendar tool');
  expect(await run({}, { toolCallId: 'calendar', messages: [], context: undefined })).toMatchObject({ ok: true });
  expect(search).toHaveBeenCalledWith(f.userId, f.accountId, expect.anything(), expect.any(AbortSignal));
  expect(calendars).toHaveBeenCalledWith(f.userId, calendarAccount.id, expect.anything(), expect.any(AbortSignal));
});

it.each(['@{integration:Gmail:foreign@example.test}', '@{integration:Gmail:disconnected@example.test}'])('never falls back from unavailable mention %s', async (text) => {
  const f = await fixture(text);
  const foreign = await addAccount(pg);
  await addGoogleAccount(db, foreign.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'foreign@example.test' });
  const search = vi.spyOn(f.gmail, 'search').mockResolvedValue({ threads: [] });
  const tools = await createGoogleTools(f);
  expect(await execute(tools, { query: 'jobs' })).toEqual({ ok: false, error: 'account_unavailable' });
  expect(await execute(tools, { accountId: 'foreign@example.test', query: 'jobs' })).toEqual({ ok: false, error: 'account_unavailable' });
  expect(search).not.toHaveBeenCalled();
});

it('rechecks revocation and live private scope after mention tools are constructed', async () => {
  const f = await fixture();
  let grants: GoogleCapability[] = ['gmail.read'];
  const search = vi.spyOn(f.gmail, 'search').mockResolvedValue({ threads: [] });
  const tools = await createGoogleTools({ ...f, getVerifiedCapabilities: async () => grants });
  grants = [];
  expect(await execute(tools, { query: 'jobs' })).toEqual({ ok: false, error: 'permission_required' });
  grants = ['gmail.read'];
  await withUser(db, f.userId, tx => tx.query('update bob.conversations set archived_at=now() where id=$1', [f.conversationId]));
  expect(await execute(tools, { query: 'jobs' })).toEqual({ ok: false, error: 'scope_unavailable' });
  expect(search).not.toHaveBeenCalled();
});

it('does not use an earlier or assistant mention when the current user message has none', async () => {
  const f = await fixture();
  await appendMessage(db, f.userId, f.conversationId, { role: 'assistant', parts: [{ type: 'text', text: '@{integration:Gmail:jobs@example.test}' }] });
  const current = await appendMessage(db, f.userId, f.conversationId, { role: 'user', parts: [{ type: 'text', text: 'Check jobs' }] });
  if (!current) throw new Error('missing current message');
  const search = vi.spyOn(f.gmail, 'search').mockResolvedValue({ threads: [] });
  const tools = await createGoogleTools({ ...f, messageId: current.id });
  expect(await execute(tools, { query: 'jobs' })).toEqual({ ok: false, error: 'account_required' });
  expect(search).not.toHaveBeenCalled();
  expect(await execute(tools, { accountId: 'JOBS@example.test', query: 'jobs' })).toMatchObject({ ok: true });
  expect(await isProviderContentTurn(db, f.userId, { conversationId: f.conversationId, messageId: current.id })).toBe(true);
});

it.each(['`@{integration:Gmail:jobs@example.test}`', '``@{integration:Gmail:jobs@example.test}``', '```\n@{integration:Gmail:jobs@example.test}\n```', '\\@{integration:Gmail:jobs@example.test}', '@{feature:Gmail:jobs@example.test}', '@{integration:Google Calendar:jobs@example.test}'])('does not bind a non-Gmail mention or quoted example %s', async (text) => {
  const f = await fixture(text);
  const search = vi.spyOn(f.gmail, 'search').mockResolvedValue({ threads: [] });
  const tools = await createGoogleTools(f);
  expect(await execute(tools, { query: 'jobs' })).toEqual({ ok: false, error: 'account_required' });
  expect(search).not.toHaveBeenCalled();
});

it('preserves server mutation slots when a draft account is selected by mention', async () => {
  const f = await fixture();
  const draft = vi.spyOn(f.gmail, 'createReplyDraft').mockResolvedValue({ status: 'succeeded', operationId: randomUUID(), draftId: 'draft1' });
  const tools = await createGoogleTools({ ...f, allowNewOperations: false, getVerifiedCapabilities: async (): Promise<GoogleCapability[]> => ['gmail.draft'] });
  const run = (tools.google_gmail_draft_reply as Tool<unknown, unknown>)?.execute;
  if (!run) throw new Error('missing draft tool');
  expect(await run({ sourceMessageId: 'message1', body: 'Thank you' }, { toolCallId: 'untrusted', messages: [], context: undefined })).toMatchObject({ ok: true });
  expect(draft).toHaveBeenCalledWith(f.userId, f.accountId, expect.objectContaining({ slot: expect.objectContaining({
    conversationId: f.conversationId, messageId: f.messageId, ordinal: 0, allowNewOperations: false,
  }) }), expect.any(AbortSignal));
});

it('offers only explicitly namespaced actions and keeps account selection separate per action', async () => {
  const f = await fixture('@{integration:Gmail.search:jobs@example.test} @{integration:Gmail.read_thread:second@example.test}');
  const second = await addGoogleAccount(db, f.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'second@example.test' });
  const search = vi.spyOn(f.gmail, 'search').mockResolvedValue({ threads: [] });
  const read = vi.spyOn(f.gmail, 'readThread').mockResolvedValue({ id: 'thread1', messages: [], truncated: false });
  const tools = await createGoogleTools({ ...f, getVerifiedCapabilities: async (): Promise<GoogleCapability[]> => ['gmail.read', 'gmail.draft', 'calendar.read', 'calendar.write'] });
  expect(Object.keys(tools).sort()).toEqual(['google_gmail_search', 'google_gmail_read_thread', 'google_list_accounts'].sort());
  expect(await execute(tools, { accountId: second.id, query: 'jobs' })).toEqual({ ok: false, error: 'account_mismatch' });
  expect(await execute(tools, { query: 'jobs' })).toMatchObject({ ok: true });
  expect(search).toHaveBeenCalledWith(f.userId, f.accountId, expect.anything(), expect.any(AbortSignal));
  const run = (tools.google_gmail_read_thread as Tool<unknown, unknown>)?.execute;
  if (!run) throw new Error('missing thread tool');
  expect(await run({ accountId: f.accountId, threadId: 'thread1' }, { toolCallId: 'read', messages: [], context: undefined })).toMatchObject({ error: 'account_mismatch' });
  expect(read).not.toHaveBeenCalled();
  expect(await run({ threadId: 'thread1' }, { toolCallId: 'read', messages: [], context: undefined })).toMatchObject({ ok: true });
  expect(read).toHaveBeenCalledWith(f.userId, second.id, 'thread1', expect.any(AbortSignal));
});

it.each(['Gmail.send', 'Google Calendar.delete_event'])('fails closed for unknown namespace %s', async (name) => {
  const f = await fixture(`@{integration:${name}:jobs@example.test} @{integration:Gmail.search:jobs@example.test}`);
  const tools = await createGoogleTools(f);
  expect(Object.keys(tools)).toEqual(['google_list_accounts']);
});

it('does not let a bare mention override an explicitly namespaced account', async () => {
  const f = await fixture('@{integration:Gmail:jobs@example.test} @{integration:Gmail.search:second@example.test}');
  const second = await addGoogleAccount(db, f.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'second@example.test' });
  const search = vi.spyOn(f.gmail, 'search').mockResolvedValue({ threads: [] });
  const tools = await createGoogleTools(f);
  expect(Object.keys(tools).sort()).toEqual(['google_gmail_search', 'google_list_accounts']);
  expect(await execute(tools, { accountId: f.accountId, query: 'jobs' })).toEqual({ ok: false, error: 'account_mismatch' });
  expect(await execute(tools, { query: 'jobs' })).toMatchObject({ ok: true });
  expect(search).toHaveBeenCalledWith(f.userId, second.id, expect.anything(), expect.any(AbortSignal));
});

it('rechecks current namespace selection before a captured tool can execute', async () => {
  const f = await fixture();
  const search = vi.spyOn(f.gmail, 'search').mockResolvedValue({ threads: [] });
  const tools = await createGoogleTools(f);
  const message = await appendMessage(db, f.userId, f.conversationId, { role: 'user', parts: [{ type: 'text', text: '@{integration:Gmail.read_thread:jobs@example.test}' }] });
  if (!message) throw new Error('missing namespaced message');
  // Simulate accidental reuse with a new trusted turn anchor: execution must
  // still inspect the current persisted selection, not construction-time data.
  f.messageId = message.id;
  expect(await execute(tools, { accountId: f.accountId, query: 'jobs' })).toEqual({ ok: false, error: 'tool_selection_mismatch' });
  expect(search).not.toHaveBeenCalled();
});

it('does not expose an explicitly named action without its verified capability', async () => {
  const f = await fixture('@{integration:Gmail.draft_reply:jobs@example.test}');
  expect(Object.keys(await createGoogleTools(f))).toEqual(['google_list_accounts']);
});

it.each([
  ['Gmail.search', 'google_gmail_search'], ['Gmail.read_thread', 'google_gmail_read_thread'],
  ['Gmail.draft_reply', 'google_gmail_draft_reply'], ['Google Calendar.list_calendars', 'google_calendar_list_calendars'],
  ['Google Calendar.list_events', 'google_calendar_list_events'], ['Google Calendar.create_event', 'google_calendar_create_event'],
  ['Google Calendar.update_event', 'google_calendar_update_event'],
])('exposes exactly the requested canonical operation %s', async (namespace, toolName) => {
  const f = await fixture(`@{integration:${namespace}:jobs@example.test}`);
  const tools = await createGoogleTools({ ...f, getVerifiedCapabilities: async (): Promise<GoogleCapability[]> => ['gmail.read', 'gmail.draft', 'calendar.read', 'calendar.write'] });
  expect(Object.keys(tools).sort()).toEqual(['google_list_accounts', toolName].sort());
});

const mailContent = { to: ['recipient@example.test'], subject: 'Test', body: 'Test body' };
const mailPolicyCases = [
  { name: 'google_gmail_read_draft', method: 'readDraft', input: { draftId: 'draft1' } },
  { name: 'google_gmail_compose_draft', method: 'composeDraft', input: { content: mailContent } },
  { name: 'google_gmail_update_draft', method: 'updateDraft', input: { draftId: 'draft1', expectedFingerprint: 'a'.repeat(64), content: mailContent } },
  { name: 'google_gmail_send_draft', method: 'sendDraft', input: { draftId: 'draft1', expectedFingerprint: 'a'.repeat(64), content: mailContent } },
  { name: 'google_gmail_trash_message', method: 'trashMessage', input: { messageId: 'message1' } },
  { name: 'google_gmail_restore_message', method: 'restoreMessage', input: { messageId: 'message1' } },
] as const;
it.each(mailPolicyCases.flatMap((operation) => (['account', 'integration', 'conversation'] as const).map((scope) => ({ ...operation, scope }))))(
  '$name rechecks $scope policy before reaching its provider', async ({ name, method, input, scope }) => {
    const f = await fixture();
    const actions = createGmailActionsService({ db, resolveCredential: async () => 'token' });
    const provider = vi.spyOn(actions, method).mockRejectedValue(new Error('provider reached'));
    const tools = await createGoogleTools({ ...f, mailActions: actions,
      getVerifiedCapabilities: async (): Promise<GoogleCapability[]> => ['gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify'] });
    const execute = (tools[name] as Tool<unknown, unknown> | undefined)?.execute;
    expect(execute).toBeDefined();
    const scopeId = scope === 'account' ? f.userId : scope === 'integration' ? f.accountId : f.conversationId;
    await setToolPreference(db, f.userId, { scope, scopeId, toolId: name, enabled: false });
    expect(await execute?.(input, { toolCallId: 'policy', messages: [], context: undefined })).toEqual({ ok: false, error: 'tool_disabled' });
    expect(provider).not.toHaveBeenCalled();
    await setToolPreference(db, f.userId, { scope, scopeId, toolId: name, enabled: null });
    await execute?.(input, { toolCallId: 'policy-reset', messages: [], context: undefined });
    expect(provider).toHaveBeenCalledOnce();
    expect(provider.mock.calls[0]?.slice(0, 2)).toEqual([f.userId, f.accountId]);
  },
);

it('enabling all new mail tools never restores revoked Google permission', async () => {
  const f = await fixture();
  const actions = createGmailActionsService({ db, resolveCredential: async () => 'token' });
  const providers = mailPolicyCases.map(({ method }) => vi.spyOn(actions, method).mockRejectedValue(new Error('must not reach provider')));
  let grants: GoogleCapability[] = ['gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify'];
  const tools = await createGoogleTools({ ...f, mailActions: actions, getVerifiedCapabilities: async () => grants });
  grants = [];
  for (const { name, input } of mailPolicyCases) {
    await setToolPreference(db, f.userId, { scope: 'integration', scopeId: f.accountId, toolId: name, enabled: true });
    const execute = (tools[name] as Tool<unknown, unknown> | undefined)?.execute;
    expect(await execute?.(input, { toolCallId: 'revoked', messages: [], context: undefined })).toEqual({ ok: false, error: 'permission_required' });
  }
  for (const provider of providers) expect(provider).not.toHaveBeenCalled();
});
