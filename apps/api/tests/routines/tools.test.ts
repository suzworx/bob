import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { stepCountIs, ToolLoopAgent, type Tool, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { createRoutineTools } from '../../src/routines/tools.ts';
import { addGoogleAccount } from '../../src/integrations/google-store.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { isProviderContentTurn } from '../../src/memory/provider-content.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { createThread, postMessage } from '../../src/conversations/thread-store.ts';
import { persistInsightDraft } from '../../src/routines/run-store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });
async function fixture() {
  const { userId } = await addAccount(pg);
  const account = await addGoogleAccount(db, userId, { installationId: randomUUID(), accountId: 'provider', email: 'test@example.test' });
  await withUser(db, userId, tx => tx.query("update bob.google_accounts set authorization_capabilities=array['gmail.read'] where id=$1", [account.id]));
  const conversation = await createConversation(db, userId, 'Private');
  const message = await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'Set up my digest' }] });
  if (!message) throw new Error('missing message');
  return { db, userId, conversationId: conversation.id, messageId: message.id, googleAccountId: account.id,
    allowNewOperations: true, getVerifiedCapabilities: async () => ['gmail.read' as const] };
}
async function execute(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const run = (tools[name] as Tool<unknown, unknown> | undefined)?.execute;
  if (!run) throw new Error('missing tool');
  return run(input, { toolCallId: 'untrusted', messages: [], context: undefined });
}
it('exposes daily Gmail creation without a model-selected kind or required internal account ID', async () => {
  const f = await fixture(); const tools = await createRoutineTools(f);
  const schema = tools.create_routine?.inputSchema as z.ZodType;
  const json = z.toJSONSchema(schema);
  expect(json.properties).not.toHaveProperty('kind');
  expect(json.required).not.toContain('googleAccountId');
  const input = { localTime: '09:00', timeZone: 'America/Los_Angeles', scheduledReadConsent: true };
  expect(schema.safeParse(input).success).toBe(true);
  expect(schema.safeParse({ ...input, kind: 'email_summary' }).success).toBe(false);
  expect(await execute(tools, 'create_routine', input)).toMatchObject({ ok: true,
    data: { googleAccountId: f.googleAccountId, kind: 'daily_gmail_digest', localTime: '09:00', timeZone: 'America/Los_Angeles' } });
});
it('uses the persisted selection among multiple Gmail accounts and never guesses when none is selected', async () => {
  const f = await fixture();
  const second = await addGoogleAccount(db, f.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'second@example.test' });
  await withUser(db, f.userId, async tx => {
    await tx.query('update bob.google_accounts set selected=false');
    await tx.query("update bob.google_accounts set authorization_capabilities=array['gmail.read'] where id=$1", [second.id]);
  });
  const tools = await createRoutineTools(f);
  const input = { localTime: '09:00', timeZone: 'America/Los_Angeles', scheduledReadConsent: true };
  expect(await execute(tools, 'create_routine', input)).toEqual({ ok: false, error: 'account_required' });
  expect(await execute(tools, 'list_routines', {})).toMatchObject({ data: [] });
  await withUser(db, f.userId, tx => tx.query('update bob.google_accounts set selected=true where id=$1', [second.id]));
  expect(await execute(tools, 'create_routine', input)).toMatchObject({ ok: true, data: { googleAccountId: second.id } });
});
it('rechecks the default account grant and never silently falls back after revocation', async () => {
  const f = await fixture();
  const second = await addGoogleAccount(db, f.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'second@example.test' });
  await withUser(db, f.userId, tx => tx.query("update bob.google_accounts set authorization_capabilities=array['gmail.read'] where id=$1", [second.id]));
  const checked: string[] = [];
  const tools = await createRoutineTools({ ...f, getVerifiedCapabilities: async (_owner, id) => {
    checked.push(id); return id === second.id ? ['gmail.read'] : [];
  } });
  expect(await execute(tools, 'create_routine', { localTime: '09:00', timeZone: 'UTC', scheduledReadConsent: true }))
    .toEqual({ ok: false, error: 'permission_required' });
  expect(checked).toEqual([f.googleAccountId]);
  expect(await execute(tools, 'list_routines', {})).toMatchObject({ data: [] });
});
it('keeps unsupported kinds, missing schedule and missing consent invalid', async () => {
  const f = await fixture(); const tools = await createRoutineTools(f);
  for (const value of [
    { kind: 'email_summary', localTime: '09:00', timeZone: 'UTC', scheduledReadConsent: true },
    { timeZone: 'UTC', scheduledReadConsent: true },
    { localTime: '09:00', scheduledReadConsent: true },
    { localTime: '09:00', timeZone: 'UTC' },
  ]) expect(await execute(tools, 'create_routine', value)).toEqual({ ok: false, error: 'invalid_input' });
  expect(await execute(tools, 'list_routines', {})).toMatchObject({ data: [] });
});
it('executes a schema-valid daily Gmail request through the SDK without an internal kind or account ID', async () => {
  const f = await fixture(); const tools = await createRoutineTools(f);
  const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 } };
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    calls += 1;
    return calls === 1 ? { content: [{ type: 'tool-call' as const, toolCallId: 'fixture-create', toolName: 'create_routine',
      input: JSON.stringify({ localTime: '09:00', timeZone: 'America/Los_Angeles', scheduledReadConsent: true }) }],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage, warnings: [] }
      : { content: [{ type: 'text' as const, text: 'Saved.' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] };
  } });
  const result = await new ToolLoopAgent({ model, tools, stopWhen: stepCountIs(3) }).generate({
    prompt: 'Create my daily Gmail recap at 9am Pacific local time. I agree to scheduled email reads.',
  });
  expect(result.steps).toHaveLength(2);
  expect(result.steps[0]?.toolResults[0]?.output).toMatchObject({ ok: true, data: { kind: 'daily_gmail_digest', googleAccountId: f.googleAccountId } });
  expect(await execute(tools, 'list_routines', {})).toMatchObject({ data: [{ localTime: '09:00', timeZone: 'America/Los_Angeles' }] });
});
it('creates an explicitly consented routine and reports the persisted next run', async () => {
  const f = await fixture(); const tools = await createRoutineTools(f);
  expect(await execute(tools, 'create_routine', { googleAccountId: f.googleAccountId,
    localTime: '08:00', timeZone: 'America/Los_Angeles', scheduledReadConsent: true }))
    .toMatchObject({ ok: true, data: { googleAccountId: f.googleAccountId, nextRunAt: expect.any(Number), revision: 1 } });
});
it('uses a mentioned non-default Gmail account through SDK routine creation', async () => {
  const f = await fixture();
  const second = await addGoogleAccount(db, f.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'second@example.test' });
  await withUser(db, f.userId, tx => tx.query("update bob.google_accounts set authorization_capabilities=array['gmail.read'] where id=$1", [second.id]));
  const message = await appendMessage(db, f.userId, f.conversationId, { role: 'user', parts: [{ type: 'text', text: 'Create a 9am UTC daily recap for @{integration:Gmail:second@example.test}. I consent to scheduled reads.' }] });
  if (!message) throw new Error('missing mention message');
  const tools = await createRoutineTools({ ...f, messageId: message.id });
  const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } };
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    calls += 1;
    return calls === 1 ? { content: [{ type: 'tool-call' as const, toolCallId: 'mention-create', toolName: 'create_routine',
      input: JSON.stringify({ localTime: '09:00', timeZone: 'UTC', scheduledReadConsent: true }) }],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage, warnings: [] }
      : { content: [{ type: 'text' as const, text: 'Saved.' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] };
  } });
  const result = await new ToolLoopAgent({ model, tools, stopWhen: stepCountIs(3) }).generate({ prompt: 'Create the mentioned account recap with the consented schedule.' });
  expect(result.steps[0]?.toolResults[0]?.output).toMatchObject({ ok: true, data: { googleAccountId: second.id } });
});
it('accepts a mentioned account email but rejects a conflicting explicit routine account', async () => {
  const f = await fixture();
  const second = await addGoogleAccount(db, f.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'second@example.test' });
  await withUser(db, f.userId, tx => tx.query("update bob.google_accounts set authorization_capabilities=array['gmail.read'] where id=$1", [second.id]));
  const message = await appendMessage(db, f.userId, f.conversationId, { role: 'user', parts: [{ type: 'text', text: '@{integration:Gmail:second@example.test}' }] });
  if (!message) throw new Error('missing mention message');
  const tools = await createRoutineTools({ ...f, messageId: message.id });
  const input = { localTime: '09:00', timeZone: 'UTC', scheduledReadConsent: true };
  expect(await execute(tools, 'create_routine', { ...input, googleAccountId: f.googleAccountId })).toEqual({ ok: false, error: 'account_mismatch' });
  expect(await execute(tools, 'list_routines', {})).toMatchObject({ data: [] });
  expect(await execute(tools, 'create_routine', { ...input, googleAccountId: 'second@example.test' })).toMatchObject({ ok: true, data: { googleAccountId: second.id } });
});
it.each([
  ['@{integration:Gmail:missing@example.test}', 'routine_account_unavailable'],
  ['@{integration:Gmail:test@example.test} @{integration:Gmail:second@example.test}', 'account_required'],
] as const)('never falls back to the routine default for %s', async (text, error) => {
  const f = await fixture();
  const message = await appendMessage(db, f.userId, f.conversationId, { role: 'user', parts: [{ type: 'text', text }] });
  if (!message) throw new Error('missing mention message');
  const tools = await createRoutineTools({ ...f, messageId: message.id });
  expect(await execute(tools, 'create_routine', { localTime: '09:00', timeZone: 'UTC', scheduledReadConsent: true })).toEqual({ ok: false, error });
  expect(await execute(tools, 'list_routines', {})).toMatchObject({ data: [] });
});
it('refuses a revoked mentioned account without trying the granted default', async () => {
  const f = await fixture();
  const second = await addGoogleAccount(db, f.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'second@example.test' });
  const message = await appendMessage(db, f.userId, f.conversationId, { role: 'user', parts: [{ type: 'text', text: '@{integration:Gmail:second@example.test}' }] });
  if (!message) throw new Error('missing mention message');
  const checked: string[] = [];
  const tools = await createRoutineTools({ ...f, messageId: message.id, getVerifiedCapabilities: async (_user, id) => {
    checked.push(id); return id === second.id ? [] : ['gmail.read'];
  } });
  expect(await execute(tools, 'create_routine', { localTime: '09:00', timeZone: 'UTC', scheduledReadConsent: true })).toEqual({ ok: false, error: 'permission_required' });
  expect(checked).toEqual([second.id]);
  expect(await execute(tools, 'list_routines', {})).toMatchObject({ data: [] });
});
it('withholds routine creation for provider namespaces and guards captured execution', async () => {
  const f = await fixture();
  const tools = await createRoutineTools(f);
  const message = await appendMessage(db, f.userId, f.conversationId, { role: 'user', parts: [{ type: 'text', text: '@{integration:Gmail.search:test@example.test}' }] });
  if (!message) throw new Error('missing namespaced message');
  f.messageId = message.id;
  expect(await createRoutineTools(f)).not.toHaveProperty('create_routine');
  expect(await execute(tools, 'create_routine', { googleAccountId: f.googleAccountId, localTime: '09:00', timeZone: 'UTC', scheduledReadConsent: true }))
    .toEqual({ ok: false, error: 'tool_selection_mismatch' });
  expect(await execute(tools, 'list_routines', {})).toMatchObject({ data: [] });
});
it('refuses regeneration mutations and invalid or missing consent', async () => {
  const f = await fixture(); const input = { googleAccountId: f.googleAccountId, localTime: '08:00', timeZone: 'UTC', scheduledReadConsent: true };
  expect(await execute(await createRoutineTools({ ...f, allowNewOperations: false }), 'create_routine', input))
    .toMatchObject({ ok: false, error: 'needs_review' });
  expect(await execute(await createRoutineTools(f), 'create_routine', { ...input, scheduledReadConsent: false }))
    .toMatchObject({ ok: false, error: 'invalid_input' });
});
it('requires fresh actual Gmail permission and returns no raw provider failures', async () => {
  const f = await fixture(); const tools = await createRoutineTools({ ...f, getVerifiedCapabilities: async () => { throw new Error('secret token'); } });
  const result = await execute(tools, 'create_routine', { googleAccountId: f.googleAccountId, localTime: '08:00', timeZone: 'UTC', scheduledReadConsent: true });
  expect(result).toEqual({ ok: false, error: 'unavailable' });
});
it('withholds foreign anchors and rechecks private scope on every execution', async () => {
  const f = await fixture(); const other = await fixture();
  expect(await createRoutineTools({ ...f, conversationId: other.conversationId, messageId: other.messageId })).toEqual({});
  const tools = await createRoutineTools(f);
  await withUser(db, f.userId, tx => tx.query('update bob.conversations set archived_at=now() where id=$1', [f.conversationId]));
  expect(await execute(tools, 'list_routines', {})).toEqual({ ok: false, error: 'scope_unavailable' });
});
it('never exposes routine tools in shared conversations', async () => {
  const f = await fixture();
  const space = await createSpace(db, f.userId, { name: 'Shared' });
  const thread = await createThread(db, f.userId, { spaceId: space.id, title: 'Shared' });
  const message = await postMessage(db, f.userId, { threadId: thread.id, body: 'My email', clientMessageId: randomUUID() });
  expect(await createRoutineTools({ ...f, conversationId: thread.id, messageId: message.message.id })).toEqual({});
});
it('lists, edits, pauses, resumes and deletes a selected routine using fresh revisions', async () => {
  const f = await fixture(); const tools = await createRoutineTools(f);
  await execute(tools, 'create_routine', { googleAccountId: f.googleAccountId,
    localTime: '08:00', timeZone: 'UTC', scheduledReadConsent: true });
  const listed = await execute(tools, 'list_routines', {}) as { data: { id: string }[] };
  const routineId = listed.data[0]?.id;
  expect(routineId).toBeTypeOf('string');
  expect(await execute(tools, 'edit_routine', { routineId, expectedRevision: 1, localTime: '09:00' }))
    .toMatchObject({ ok: true, data: { localTime: '09:00', revision: 2 } });
  expect(await execute(tools, 'pause_routine', { routineId, expectedRevision: 1 }))
    .toMatchObject({ ok: false, error: 'routine_revision_conflict' });
  expect(await execute(tools, 'pause_routine', { routineId, expectedRevision: 2 }))
    .toMatchObject({ ok: true, data: { status: 'paused', nextRunAt: null, revision: 3 } });
  expect(await execute(tools, 'resume_routine', { routineId, expectedRevision: 3 }))
    .toMatchObject({ ok: true, data: { status: 'active', nextRunAt: expect.any(Number), revision: 4 } });
  expect(await execute(tools, 'delete_routine', { routineId, expectedRevision: 4 })).toMatchObject({ ok: true });
  expect(await execute(tools, 'list_routines', {})).toMatchObject({ ok: true, data: [] });
});
it('commits provider exclusion before returning saved insights, and fails closed without its anchor', async () => {
  const f = await fixture(); const tools = await createRoutineTools(f);
  expect(await isProviderContentTurn(db, f.userId, f)).toBe(false);
  expect(await execute(tools, 'get_saved_insights', {})).toMatchObject({ ok: true });
  expect(await isProviderContentTurn(db, f.userId, f)).toBe(true);
  await withUser(db, f.userId, tx => tx.query('delete from bob.messages where id=$1', [f.messageId]));
  expect(await execute(tools, 'get_saved_insights', {})).toEqual({ ok: false, error: 'scope_unavailable' });
});
it('returns no saved content if the durable memory exclusion cannot commit', async () => {
  const f = await fixture();
  const failing: Db = { query: db.query.bind(db), tx: async fn => db.tx(async tx => fn({
    query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes('SET memory_provider_from_position')) throw new Error('private provider content');
      return tx.query<T>(sql, params);
    }, tx: tx.tx.bind(tx),
  })) };
  const tools = await createRoutineTools({ ...f, db: failing });
  expect(await execute(tools, 'get_saved_insights', {})).toEqual({ ok: false, error: 'unavailable' });
  expect(await isProviderContentTurn(db, f.userId, f)).toBe(false);
});
it('bounds long saved results and discloses omitted sources without changing saved text', async () => {
  const f = await fixture();
  const saved = await persistInsightDraft(db, f.userId, { googleAccountId: f.googleAccountId, category: 'future',
    title: 'Source-heavy forecast', summary: 'a'.repeat(6000), periodStart: 1000, periodEnd: 2000, generatedAt: 1000,
    partial: false, messageCount: 0, sources: Array.from({ length: 200 }, (_, index) => ({ kind: 'calendar' as const,
      id: `source-${index}`, label: '\n'.repeat(300), url: `https://calendar.google.com/${'a'.repeat(1950)}` })) });
  const result = await execute(await createRoutineTools(f), 'get_saved_insights', { category: 'future' });
  expect(JSON.stringify(result).length).toBeLessThan(100000);
  expect(result).toMatchObject({ ok: true, data: { insights: [{ id: saved.id, summary: saved.summary, sourcesOmitted: 190 }], resultsOmitted: 0 } });
  const typed = result as { data: { insights: { sources: unknown[] }[] } };
  expect(typed.data.insights[0]?.sources).toHaveLength(10);
});
it('defaults to five results, honors a smaller limit and bounds an explicitly large selection by UTF-8 size', async () => {
  const f = await fixture();
  for (let index = 0; index < 10; index += 1) {
    const account = await addGoogleAccount(db, f.userId, { installationId: randomUUID(), accountId: randomUUID(), email: `fixture${index}@example.test` });
    await persistInsightDraft(db, f.userId, { googleAccountId: account.id, category: 'future', title: `Forecast ${index}`,
      summary: '🙂'.repeat(3000), periodStart: 1000, periodEnd: 2000, generatedAt: 1000 + index,
      partial: false, messageCount: 0, sources: [] });
  }
  const tools = await createRoutineTools(f);
  const defaulted = await execute(tools, 'get_saved_insights', { category: 'future' }) as { data: { insights: unknown[]; resultsOmitted: number } };
  expect(defaulted.data.insights).toHaveLength(5);
  expect(defaulted.data.resultsOmitted).toBe(5);
  const limited = await execute(tools, 'get_saved_insights', { category: 'future', limit: 2 }) as { data: { insights: unknown[]; resultsOmitted: number } };
  expect(limited.data.insights).toHaveLength(2);
  expect(limited.data.resultsOmitted).toBe(8);
  expect(limited).toMatchObject({ data: { nextOffset: 2 } });
  const continued = await execute(tools, 'get_saved_insights', { category: 'future', limit: 2, offset: 2 });
  expect(continued).toMatchObject({ data: { insights: [{ title: 'Forecast 7' }, { title: 'Forecast 6' }], nextOffset: 4, resultsOmitted: 6 } });
  const end = await execute(tools, 'get_saved_insights', { category: 'future', offset: 8 });
  expect(end).toMatchObject({ data: { nextOffset: null, resultsOmitted: 0 } });
  const maximum = await execute(tools, 'get_saved_insights', { category: 'future', limit: 10 });
  expect(Buffer.byteLength(JSON.stringify(maximum))).toBeLessThan(90000);
  expect(maximum).toMatchObject({ data: { nextOffset: 7, resultsOmitted: 3 } });
  expect(await execute(tools, 'get_saved_insights', { limit: 11 })).toEqual({ ok: false, error: 'invalid_input' });
  expect(await execute(tools, 'get_saved_insights', { offset: 100 })).toEqual({ ok: false, error: 'invalid_input' });
});
/** The DEFERRED form: the turn's anchor resolves lazily, only inside an execute (#1378). */
function deferred(f: Awaited<ReturnType<typeof fixture>>, anchor: () => Promise<{ conversationId: string; messageId: string }>): Parameters<typeof createRoutineTools>[0] {
  const { conversationId: _c, messageId: _m, ...rest } = f;
  return { ...rest, anchor };
}
it('deferred routine tools build without calling the anchor, and a rejecting anchor fails closed', async () => {
  const f = await fixture();
  let calls = 0;
  const tools = await createRoutineTools(deferred(f, async () => { calls += 1; throw new Error('no anchor'); }));
  expect(Object.keys(tools)).toContain('create_routine');
  expect(calls).toBe(0);
  expect(await execute(tools, 'list_routines', {})).toEqual({ ok: false, error: 'scope_unavailable' });
  expect(calls).toBe(1);
});
it('deferred routine tools run against the resolved anchor', async () => {
  const f = await fixture();
  const tools = await createRoutineTools(deferred(f, async () => ({ conversationId: f.conversationId, messageId: f.messageId })));
  expect(await execute(tools, 'list_routines', {})).toMatchObject({ ok: true, data: [] });
});
it('deferred create_routine refuses when the anchored message holds a namespaced integration mention', async () => {
  const f = await fixture();
  const message = await appendMessage(db, f.userId, f.conversationId, { role: 'user', parts: [{ type: 'text', text: '@{integration:Gmail.search:test@example.test}' }] });
  if (!message) throw new Error('missing namespaced message');
  const tools = await createRoutineTools(deferred(f, async () => ({ conversationId: f.conversationId, messageId: message.id })));
  expect(await execute(tools, 'create_routine', { googleAccountId: f.googleAccountId, localTime: '09:00', timeZone: 'UTC', scheduledReadConsent: true }))
    .toEqual({ ok: false, error: 'tool_selection_mismatch' });
  expect(await execute(tools, 'list_routines', {})).toMatchObject({ data: [] });
});
