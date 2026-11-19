import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Tool, ToolSet } from 'ai';
import { createGoogleTools } from '../../src/integrations/google-tools.ts';
import { createGoogleCalendarService } from '../../src/integrations/google-calendar-service.ts';
import { createGmailService } from '../../src/integrations/google-gmail-service.ts';
import { createGmailActionsService } from '../../src/integrations/google-mail-actions-service.ts';
import { createGoogleMailActionsClient } from '../../src/integrations/google-mail-actions-client.ts';
import type { GoogleCapability } from '../../src/integrations/google-credentials.ts';
import { addGoogleAccount, renameGoogleAccount } from '../../src/integrations/google-store.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { isProviderContentTurn } from '../../src/memory/provider-content.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { createThread, postMessage } from '../../src/conversations/thread-store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
afterAll(async () => { if (pg) await closeTestDb(pg); });
afterEach(() => { vi.useRealTimers(); });
async function fixture(text = 'Read Google') {
  const { userId } = await addAccount(pg);
  const account = await addGoogleAccount(db, userId, { installationId: randomUUID(), accountId: 'provider', email: 'test@example.test' });
  const conversation = await createConversation(db, userId, 'Private');
  const message = await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text }] });
  if (!message) throw new Error('missing fixture message');
  const resolveCredential = async () => 'token';
  return { db, userId, conversationId: conversation.id, messageId: message.id, accountId: account.id,
    allowNewOperations: true,
    calendar: createGoogleCalendarService({ db, resolveCredential }), gmail: createGmailService({ db, resolveCredential }) };
}
async function execute(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const execute = (tools[name] as Tool<unknown, unknown> | undefined)?.execute;
  if (!execute) throw new Error('missing tool');
  return execute(input, { toolCallId: 'untrusted-id', messages: [], context: undefined });
}

it('keeps sending separate from drafts and rechecks send consent before execution', async () => {
  const f = await fixture();
  const mailActions = createGmailActionsService({ db, client: createGoogleMailActionsClient(), resolveCredential: async () => 'token' });
  const send = vi.spyOn(mailActions, 'sendDraft').mockResolvedValue({ status: 'unknown', operationId: randomUUID() });
  let grants: GoogleCapability[] = ['gmail.read', 'gmail.draft'];
  const config = { ...f, mailActions, getVerifiedCapabilities: async () => grants };
  const draftOnly = await createGoogleTools(config);
  expect(draftOnly.google_gmail_compose_draft).toBeDefined();
  expect(draftOnly.google_gmail_send_draft).toBeUndefined();
  expect(draftOnly.google_gmail_trash_message).toBeUndefined();
  grants = ['gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify'];
  const enabled = await createGoogleTools(config);
  const input = { accountId: f.accountId, draftId: 'draft1', expectedFingerprint: 'a'.repeat(64),
    content: { to: ['test@example.test'], subject: 'Test', body: 'Test' } };
  expect(await execute(enabled, 'google_gmail_send_draft', input)).toMatchObject({ ok: false, status: 'unknown', error: 'outcome_unknown' });
  expect(await isProviderContentTurn(db, f.userId, f)).toBe(true);
  grants = ['gmail.read', 'gmail.draft'];
  expect(await execute(enabled, 'google_gmail_send_draft', input)).toMatchObject({ ok: false, error: 'permission_required' });
  expect(send).toHaveBeenCalledTimes(1);
});
it('exposes only verified capabilities and commits exclusion before service access', async () => {
  const f = await fixture();
  const search = vi.spyOn(f.gmail, 'search').mockImplementation(async () => {
    expect(await isProviderContentTurn(asDb(pg), f.userId, { conversationId: f.conversationId, messageId: f.messageId })).toBe(true);
    return { threads: [] };
  });
  const tools = await createGoogleTools({ ...f, getVerifiedCapabilities: async () => ['gmail.read'] });
  expect(Object.keys(tools).sort()).toEqual(['google_list_accounts', 'google_gmail_read_thread', 'google_gmail_search'].sort());
  expect(await execute(tools, 'google_gmail_search', { accountId: f.accountId, query: 'subject:hello' })).toMatchObject({ ok: true, data: { threads: [] } });
  expect(search).toHaveBeenCalledTimes(1);
  expect(await createGoogleTools({ ...f, getVerifiedCapabilities: async () => [] })).toEqual({});
});

it('marks account discovery before returning provider identity to the model', async () => {
  const f = await fixture();
  await renameGoogleAccount(db, f.userId, f.accountId, 'Work Gmail');
  const tools = await createGoogleTools({ ...f, getVerifiedCapabilities: async () => ['gmail.read'] });
  expect(await isProviderContentTurn(db, f.userId, f)).toBe(false);
  expect(await execute(tools, 'google_list_accounts', {})).toMatchObject({ ok: true, data: { accounts: [{ accountId: f.accountId, email: 'test@example.test', customName: 'Work Gmail' }] } });
  expect(await isProviderContentTurn(db, f.userId, f)).toBe(true);
});

it.each(['unknown', 'failed'] as const)('does not report a %s mutation as successful', async (status) => {
  const f = await fixture();
  const operationId = randomUUID();
  const draft = vi.spyOn(f.gmail, 'createReplyDraft').mockResolvedValue({ status, operationId });
  const tools = await createGoogleTools({ ...f, getVerifiedCapabilities: async () => ['gmail.draft'] });
  expect(await execute(tools, 'google_gmail_draft_reply', { accountId: f.accountId, sourceMessageId: 'm1', body: 'Reply' }))
    .toMatchObject({ ok: false, status, operationId });
  expect(draft).toHaveBeenCalledTimes(1);
});

it.each(['initial', 'execute'] as const)('cancels an uncooperative %s grants getter and consumes its late rejection', async (stage) => {
  const f = await fixture();
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let rejectLate: (error: Error) => void = () => undefined;
  const pending = new Promise<never>((_resolve, reject) => { rejectLate = reject; });
  const controller = new AbortController();
  let block = stage === 'initial';
  const getVerifiedCapabilities = (): Promise<readonly GoogleCapability[]> => {
    if (!block) return Promise.resolve(['gmail.read']);
    entered();
    return pending;
  };
  const config = { ...f, signal: controller.signal, getVerifiedCapabilities };
  const tools = stage === 'execute' ? await createGoogleTools(config) : {};
  block = true;
  let settled = false;
  const action = stage === 'initial' ? createGoogleTools(config)
    : execute(tools, 'google_gmail_search', { accountId: f.accountId, query: 'hello' });
  const result = action.then((value) => { settled = true; return value; });
  await started;
  vi.useFakeTimers();
  try {
    setTimeout(() => controller.abort(), 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(true);
  } finally {
    vi.useRealTimers();
    rejectLate(new Error('late secret failure'));
    await result;
  }
  expect(await result).toEqual(stage === 'initial' ? {} : { ok: false, error: 'unavailable' });
});

it('withholds tools for foreign, missing, archived and shared anchors', async () => {
  const f = await fixture();
  const other = await fixture();
  const getVerifiedCapabilities = vi.fn(async (): Promise<GoogleCapability[]> => ['gmail.read']);
  expect(await createGoogleTools({ ...f, conversationId: other.conversationId, messageId: other.messageId, getVerifiedCapabilities })).toEqual({});
  expect(await createGoogleTools({ ...f, messageId: 'missing', getVerifiedCapabilities })).toEqual({});
  await withUser(db, f.userId, (tx) => tx.query('update bob.conversations set archived_at=now() where id=$1', [f.conversationId]));
  expect(await createGoogleTools({ ...f, getVerifiedCapabilities })).toEqual({});
  const space = await createSpace(db, f.userId, { name: 'Shared' });
  const thread = await createThread(db, f.userId, { spaceId: space.id, title: 'Shared' });
  const message = await postMessage(db, f.userId, { threadId: thread.id, body: 'Read mail', clientMessageId: randomUUID() });
  expect(await createGoogleTools({ ...f, conversationId: thread.id, messageId: message.message.id, getVerifiedCapabilities })).toEqual({});
  expect(getVerifiedCapabilities).not.toHaveBeenCalled();
});

it('rechecks current grants, exact account ownership and live scope on execution', async () => {
  const f = await fixture();
  const other = await fixture();
  let grants: GoogleCapability[] = ['gmail.read'];
  const search = vi.spyOn(f.gmail, 'search').mockResolvedValue({ threads: [] });
  const tools = await createGoogleTools({ ...f, getVerifiedCapabilities: async () => grants });
  expect(await execute(tools, 'google_gmail_search', { accountId: other.accountId, query: 'hello' })).toEqual({ ok: false, error: 'account_unavailable' });
  grants = [];
  expect(await execute(tools, 'google_gmail_search', { accountId: f.accountId, query: 'hello' })).toEqual({ ok: false, error: 'permission_required' });
  grants = ['gmail.read'];
  await withUser(db, f.userId, (tx) => tx.query('update bob.conversations set archived_at=now() where id=$1', [f.conversationId]));
  expect(await execute(tools, 'google_gmail_search', { accountId: f.accountId, query: 'hello' })).toEqual({ ok: false, error: 'scope_unavailable' });
  expect(search).not.toHaveBeenCalled();
});

function failMarker(inner: Db): Db {
  return {
    query: (sql, params) => {
      if (sql.includes('SET memory_provider_from_position')) throw new Error('database secret marker failure');
      return inner.query(sql, params);
    },
    tx: (fn) => inner.tx((tx) => fn(failMarker(tx))),
  };
}
it('fails closed on marker persistence errors for reads and account discovery', async () => {
  const f = await fixture();
  const search = vi.spyOn(f.gmail, 'search').mockResolvedValue({ threads: [] });
  const tools = await createGoogleTools({ ...f, db: failMarker(db), getVerifiedCapabilities: async () => ['gmail.read'] });
  expect(await execute(tools, 'google_gmail_search', { accountId: f.accountId, query: 'hello' })).toEqual({ ok: false, error: 'unavailable' });
  expect(await execute(tools, 'google_list_accounts', {})).toEqual({ ok: false, error: 'unavailable' });
  expect(search).not.toHaveBeenCalled();
  expect(await isProviderContentTurn(db, f.userId, f)).toBe(false);
});

it('requires explicit account selection, rejects model operation identity and passes only server replay slots', async () => {
  const f = await fixture();
  const operationId = randomUUID();
  const draft = vi.spyOn(f.gmail, 'createReplyDraft').mockResolvedValue({ status: 'succeeded', operationId, draftId: 'draft1' });
  const tools = await createGoogleTools({ ...f, allowNewOperations: false, getVerifiedCapabilities: async () => ['gmail.draft'] });
  const input = { accountId: f.accountId, sourceMessageId: 'm1', body: 'Thanks' };
  expect(await execute(tools, 'google_gmail_draft_reply', { sourceMessageId: 'm1', body: 'Thanks' }))
    .toEqual({ ok: false, error: 'account_required' });
  for (const invalid of [{ ...input, operationId }, { ...input, slot: { ordinal: 0 } }]) {
    expect(await execute(tools, 'google_gmail_draft_reply', invalid)).toEqual({ ok: false, error: 'unavailable' });
  }
  expect(draft).not.toHaveBeenCalled();
  expect(await execute(tools, 'google_gmail_draft_reply', input)).toMatchObject({ ok: true });
  expect(draft).toHaveBeenCalledWith(f.userId, f.accountId, expect.objectContaining({
    sourceMessageId: 'm1', body: 'Thanks', slot: expect.objectContaining({
      ordinal: 0, messageId: f.messageId, conversationId: f.conversationId, allowNewOperations: false,
    }),
  }), expect.any(AbortSignal));
  const sent = draft.mock.calls[0]?.[2];
  expect(sent).not.toHaveProperty('operationId');
  if (!sent || !('slot' in sent)) throw new Error('missing server slot');
  expect(sent.slot).not.toHaveProperty('db');
});

const mailContent = { to: ['recipient@example.test'], cc: [], bcc: [], subject: 'Test', body: 'Test' };
const mailDraftInput = { draftId: 'draft1', expectedFingerprint: 'a'.repeat(64), content: mailContent };
const mailActionsCases = [
  { action: 'read_draft', method: 'readDraft', capability: 'gmail.read', input: { draftId: 'draft1' } },
  { action: 'compose_draft', method: 'composeDraft', capability: 'gmail.draft', input: { content: mailContent } },
  { action: 'update_draft', method: 'updateDraft', capability: 'gmail.draft', input: mailDraftInput },
  { action: 'send_draft', method: 'sendDraft', capability: 'gmail.send', input: mailDraftInput },
  { action: 'trash_message', method: 'trashMessage', capability: 'gmail.modify', input: { messageId: 'message1' } },
  { action: 'restore_message', method: 'restoreMessage', capability: 'gmail.modify', input: { messageId: 'message1' } },
] as const;
it.each(mailActionsCases)('binds namespaced $action to its exact tool and owned account', async ({ action, method, capability, input }) => {
  const f = await fixture(`Use @{integration:Gmail.${action}:test@example.test}`);
  const other = await addGoogleAccount(db, f.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'second@example.test' });
  const mailActions = createGmailActionsService({ db, resolveCredential: async () => 'token' });
  const success = { status: 'succeeded' as const, operationId: randomUUID(), resultId: 'result1' };
  const spies = {
    readDraft: vi.spyOn(mailActions, 'readDraft').mockResolvedValue({ id: 'draft1', fingerprint: 'a'.repeat(64), rfcMessageId: null, content: mailContent }),
    composeDraft: vi.spyOn(mailActions, 'composeDraft').mockResolvedValue(success),
    updateDraft: vi.spyOn(mailActions, 'updateDraft').mockResolvedValue(success),
    sendDraft: vi.spyOn(mailActions, 'sendDraft').mockResolvedValue(success),
    trashMessage: vi.spyOn(mailActions, 'trashMessage').mockResolvedValue(success),
    restoreMessage: vi.spyOn(mailActions, 'restoreMessage').mockResolvedValue(success),
  };
  const toolName = `google_gmail_${action}`;
  let grants: GoogleCapability[] = ['gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify'];
  const config = { ...f, mailActions, getVerifiedCapabilities: async () => grants };
  const tools = await createGoogleTools(config);
  const prerequisite = action === 'send_draft' || action === 'update_draft' ? ['google_gmail_read_draft'] : [];
  expect(Object.keys(tools).sort()).toEqual(['google_list_accounts', toolName, ...prerequisite].sort());
  expect(await execute(tools, toolName, { ...input, accountId: other.id })).toMatchObject({ ok: false, error: 'account_mismatch' });
  expect(spies[method]).not.toHaveBeenCalled();
  expect(await execute(tools, toolName, input)).toMatchObject({ ok: true });
  expect(spies[method]).toHaveBeenCalledWith(f.userId, f.accountId, expect.anything(), expect.any(AbortSignal));
  if (method !== 'readDraft') expect(spies[method]).toHaveBeenCalledWith(f.userId, f.accountId,
    expect.objectContaining({ slot: expect.objectContaining({ messageId: f.messageId, ordinal: 0 }) }), expect.any(AbortSignal));
  expect(await isProviderContentTurn(db, f.userId, f)).toBe(true);
  grants = grants.filter(grant => grant !== capability);
  expect(await execute(tools, toolName, input)).toMatchObject({ ok: false, error: 'permission_required' });
  expect(spies[method]).toHaveBeenCalledTimes(1);
  expect(Object.keys(await createGoogleTools(config)).sort()).toEqual(['google_list_accounts', ...prerequisite].sort());
});

it('rechecks namespaced selection before executing a captured Gmail send tool', async () => {
  const f = await fixture('Use @{integration:Gmail.send_draft:test@example.test}');
  const mailActions = createGmailActionsService({ db, resolveCredential: async () => 'token' });
  const send = vi.spyOn(mailActions, 'sendDraft');
  const config = { ...f, mailActions, getVerifiedCapabilities: async (): Promise<GoogleCapability[]> => ['gmail.send', 'gmail.read'] };
  const tools = await createGoogleTools(config);
  const next = await appendMessage(db, f.userId, f.conversationId, { role: 'user', parts: [{ type: 'text', text: 'Use @{integration:Gmail.read_draft:test@example.test}' }] });
  if (!next) throw new Error('missing message');
  config.messageId = next.id;
  expect(await execute(tools, 'google_gmail_send_draft', mailDraftInput)).toEqual({ ok: false, error: 'tool_selection_mismatch' });
  expect(send).not.toHaveBeenCalled();
});

it.each(['send_draft', 'update_draft'])('allows only same-account read prerequisite for namespaced %s', async (action) => {
  const f = await fixture(`Use @{integration:Gmail.${action}:test@example.test} @{integration:Gmail:second@example.test}`);
  const second = await addGoogleAccount(db, f.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'second@example.test' });
  const mailActions = createGmailActionsService({ db, resolveCredential: async () => 'token' });
  const read = vi.spyOn(mailActions, 'readDraft').mockResolvedValue({ id: 'draft1', fingerprint: 'a'.repeat(64), rfcMessageId: null, content: mailContent });
  const tools = await createGoogleTools({ ...f, mailActions, getVerifiedCapabilities: async (): Promise<GoogleCapability[]> => ['gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify'] });
  expect(Object.keys(tools).sort()).toEqual(['google_list_accounts', 'google_gmail_read_draft', `google_gmail_${action}`].sort());
  expect(await execute(tools, 'google_gmail_read_draft', { draftId: 'draft1', accountId: second.id })).toMatchObject({ error: 'account_mismatch' });
  expect(read).not.toHaveBeenCalled();
  expect(await execute(tools, 'google_gmail_read_draft', { draftId: 'draft1' })).toMatchObject({ ok: true });
  expect(read).toHaveBeenCalledWith(f.userId, f.accountId, 'draft1', expect.any(AbortSignal));
  expect(tools.google_gmail_trash_message).toBeUndefined();
  expect(tools.google_gmail_compose_draft).toBeUndefined();
});

it('requires an explicit matching account when multiple write mentions need a draft read', async () => {
  const f = await fixture('Use @{integration:Gmail.send_draft:test@example.test} and @{integration:Gmail.update_draft:second@example.test}');
  const second = await addGoogleAccount(db, f.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'second@example.test' });
  const third = await addGoogleAccount(db, f.userId, { installationId: randomUUID(), accountId: randomUUID(), email: 'third@example.test' });
  const mailActions = createGmailActionsService({ db, resolveCredential: async () => 'token' });
  const read = vi.spyOn(mailActions, 'readDraft').mockResolvedValue({ id: 'draft1', fingerprint: 'a'.repeat(64), rfcMessageId: null, content: mailContent });
  const tools = await createGoogleTools({ ...f, mailActions, getVerifiedCapabilities: async (): Promise<GoogleCapability[]> => ['gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify'] });
  expect(await execute(tools, 'google_gmail_read_draft', { draftId: 'draft1' })).toMatchObject({ error: 'account_required' });
  expect(await execute(tools, 'google_gmail_read_draft', { draftId: 'draft1', accountId: third.id })).toMatchObject({ error: 'account_mismatch' });
  expect(read).not.toHaveBeenCalled();
  expect(await execute(tools, 'google_gmail_read_draft', { draftId: 'draft1', accountId: second.id })).toMatchObject({ ok: true });
  expect(read).toHaveBeenCalledWith(f.userId, second.id, 'draft1', expect.any(AbortSignal));
  expect(await execute(tools, 'google_gmail_read_draft', { draftId: 'draft1', accountId: f.accountId })).toMatchObject({ ok: true });
  expect(read).toHaveBeenLastCalledWith(f.userId, f.accountId, 'draft1', expect.any(AbortSignal));
});

/** The DEFERRED form: the turn's anchor resolves lazily, only inside an execute (#1378). */
function deferred(f: Awaited<ReturnType<typeof fixture>>, anchor: () => Promise<{ conversationId: string; messageId: string }>): Parameters<typeof createGoogleTools>[0] {
  const { conversationId: _c, messageId: _m, ...rest } = f;
  return { ...rest, anchor, getVerifiedCapabilities: async (): Promise<GoogleCapability[]> => ['gmail.read'] };
}
it('deferred tools build without calling the anchor, then run and mark provider content on the resolved message', async () => {
  const f = await fixture();
  const anchor = vi.fn(async () => ({ conversationId: f.conversationId, messageId: f.messageId }));
  const search = vi.spyOn(f.gmail, 'search').mockResolvedValue({ threads: [] });
  const tools = await createGoogleTools(deferred(f, anchor));
  expect(Object.keys(tools).sort()).toEqual(['google_list_accounts', 'google_gmail_read_thread', 'google_gmail_search'].sort());
  expect(anchor).not.toHaveBeenCalled();
  expect(await isProviderContentTurn(db, f.userId, f)).toBe(false);
  expect(await execute(tools, 'google_gmail_search', { accountId: f.accountId, query: 'subject:hello' })).toMatchObject({ ok: true });
  expect(await execute(tools, 'google_list_accounts', {})).toMatchObject({ ok: true });
  expect(anchor).toHaveBeenCalledTimes(1);
  expect(search).toHaveBeenCalledTimes(1);
  expect(await isProviderContentTurn(db, f.userId, f)).toBe(true);
});
it('deferred tools fail closed with no provider call for a rejecting or non-private anchor', async () => {
  const f = await fixture();
  const search = vi.spyOn(f.gmail, 'search').mockResolvedValue({ threads: [] });
  const space = await createSpace(db, f.userId, { name: 'Shared' });
  const thread = await createThread(db, f.userId, { spaceId: space.id, title: 'Shared' });
  const message = await postMessage(db, f.userId, { threadId: thread.id, body: 'Read mail', clientMessageId: randomUUID() });
  const rejecting = await createGoogleTools(deferred(f, async () => { throw new Error('no anchor'); }));
  const shared = await createGoogleTools(deferred(f, async () => ({ conversationId: thread.id, messageId: message.message.id })));
  for (const tools of [rejecting, shared]) {
    expect(await execute(tools, 'google_gmail_search', { accountId: f.accountId, query: 'x' })).toEqual({ ok: false, error: 'scope_unavailable' });
    expect(await execute(tools, 'google_list_accounts', {})).toEqual({ ok: false, error: 'scope_unavailable' });
  }
  expect(search).not.toHaveBeenCalled();
});
