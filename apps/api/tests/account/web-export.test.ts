// web-export.test.ts (issue #514): GET /api/account/export over a tiny express
// app with the real JWT guard, requireActiveSession and a real Postgres store.
// Every assertion is on the HTTP response or the journal call.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Db } from '../../src/platform/db/db.ts';
import { addMember, createSpace, ensurePrivateSpace, revokeMember } from '../../src/spaces/store.ts';
import { createNote } from '../../src/notes/store.ts';
import { createTask } from '../../src/tasks/store.ts';
import { createCalendar, createEvent } from '../../src/calendar/store.ts';
import { createReminder } from '../../src/reminders/store.ts';
import { createTimer } from '../../src/timers/store.ts';
import { addGoogleAccount, deleteGoogleAccount, renameGoogleAccount } from '../../src/integrations/google-store.ts';
import { createGoogleMutationSlots, claimGoogleToolOperation } from '../../src/integrations/google-tool-operation.ts';
import { replaceGoogleCalendarSelections } from '../../src/integrations/google-calendar-selection-store.ts';
import { claimGoogleOperation, finishGoogleOperation } from '../../src/integrations/google-operation-store.ts';
import { addGameUsage, createGameSession, upsertGameSettings } from '../../src/voice/games-store.ts';
import { createActionItem, setActionItemStatus } from '../../src/tasks/action-items-store.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { webErrorHandler } from '../../src/platform/http/errors.ts';
import { AccountExportResponseSchema, createExportRouter, readAccountExport } from '../../src/account/export-http.ts';
import { createBobApp, mutateBobApp } from '../../src/bob-apps/store.ts';
import { packing } from '../bob-apps/fixtures.ts';
import { configureBobAppRefresh } from '../../src/bob-apps/refresh-store.ts';
import { dispatchBobAppRefreshes } from '../../src/bob-apps/refresh.ts';
import { journal } from '../../src/platform/logger.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestAccount, type TestDb, withUserRaw } from '../support/test-db.ts';

vi.mock('../../src/platform/logger.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/platform/logger.ts')>()),
  ...(await import('../helpers/journal-mock.ts')).loggerMock(),
}));

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;
let me: TestAccount;
let other: TestAccount;
let myToken: string;
let sharedId: string;
let clubId: string;

type ExportBody = Record<string, unknown> & {
  spaces: Array<{ id: string }>;
  notes: Array<{ title: string; space_id: string }>;
  conversations: Array<{ messages: Array<{ text: string }> }>;
};

async function download(path: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

async function exportBody(): Promise<ExportBody> {
  const res = await download('/api/account/export', myToken);
  expect(res.status, JSON.stringify(vi.mocked(journal).mock.calls)).toBe(200);
  return JSON.parse(await res.text()) as ExportBody;
}

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
}

describe('GET /api/account/export', () => {
  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    me = await addAccount(pg);
    other = await addAccount(pg);
    myToken = await signToken({ userId: me.userId, sessionId: me.sessionId });

    const shared = await createSpace(db, me.userId, { kind: 'group', name: 'Family' });
    sharedId = shared.id;
    await addMember(db, me.userId, sharedId, other.userId, 'member');
    await createNote(db, me.userId, sharedId, { title: 'My shared note', body: 'packing list' });
    await createNote(db, other.userId, sharedId, { title: 'Their shared note', body: 'not mine' });
    const theirPrivate = await ensurePrivateSpace(db, other.userId);
    await createNote(db, other.userId, theirPrivate.id, { title: 'Their private note', body: 'secret diary' });

    const club = await createSpace(db, other.userId, { kind: 'group', name: 'Club' });
    clubId = club.id;
    await addMember(db, other.userId, clubId, me.userId, 'member');
    await createNote(db, me.userId, clubId, { title: 'Club note', body: 'left behind' });

    await createTask(db, me.userId, sharedId, { title: 'Buy milk', due: { kind: 'date', date: '2026-10-01' } });
    const calendar = await createCalendar(db, me.userId, sharedId, { name: 'Home', zone: 'UTC' });
    await createEvent(db, me.userId, calendar.id, {
      title: 'Picnic', allDay: true, startDate: '2026-10-02', endDate: '2026-10-03', zone: 'UTC',
    });
    await createReminder(db, me.userId, sharedId, {
      title: 'Water plants', due: { kind: 'instant', at: Date.now() + 86_400_000, zone: 'UTC' },
    });
    await createTimer(db, me.userId, { durationMs: 60_000, label: 'Tea' });
    const conversation = await createConversation(db, me.userId, 'Trip');
    await appendMessage(db, me.userId, conversation.id, {
      role: 'user',
      parts: [
        { type: 'text', text: 'Plan our trip' },
        { type: 'tool-call', token: 'tool payload never exported', secret: 'x' },
      ],
    });

    const app = express();
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    const deps = { getDb: (): Promise<Db> => Promise.resolve(db), requireActiveSession: requireActiveSession(() => Promise.resolve(db)) };
    app.use('/api/account', createExportRouter({ ...deps, limiter: { take: (): boolean => true } }));
    app.use('/limited/account', createExportRouter(deps));
    app.use('/api', webErrorHandler);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    await closeTestDb(pg).catch(() => undefined);
  });

  beforeEach(() => {
    vi.mocked(journal).mockClear();
  });

  it('reads every section under withUser without a store error', async () => {
    const data = await readAccountExport(db, me.userId);
    expect(data.notes.length).toBeGreaterThan(0);
  });

  it('exports an empty routine list and matches the advertised full response schema', async () => {
    const body = await exportBody();
    expect(body.routines).toEqual([]);
    expect(AccountExportResponseSchema.safeParse(body).success).toBe(true);
  });

  it('exports only the owner routine definitions without connection secrets or broker selectors', async () => {
    const owner = await addAccount(pg);
    const foreign = await addAccount(pg);
    async function seedRoutine(account: TestAccount): Promise<{ id: string; googleId: string }> {
      const google = await addGoogleAccount(db, account.userId, {
        installationId: `routine-private-installation-${account.userId}`,
        accountId: `routine-private-provider-${account.userId}`, email: 'routine@example.test',
      });
      const routineId = randomUUID();
      await withUserRaw(pg, account.userId, async (tx) => {
        await tx.query(`INSERT INTO bob.routines
          (id, user_id, google_account_id, kind, local_time, time_zone, scheduled_read_consent, status, revision, next_run_at)
          VALUES ($1, $2, $3, 'daily_gmail_digest', '08:15', 'America/Los_Angeles', true, 'paused', 2, NULL)`,
        [routineId, account.userId, google.id]);
      });
      return { id: routineId, googleId: google.id };
    }
    const own = await seedRoutine(owner);
    const theirs = await seedRoutine(foreign);
    const token = await signToken({ userId: owner.userId, sessionId: owner.sessionId });
    const response = await download('/api/account/export', token);
    expect(response.status).toBe(200);
    const body = AccountExportResponseSchema.parse(await response.json());
    expect(body.routines).toEqual([{
      id: own.id, google_account_id: own.googleId, kind: 'daily_gmail_digest',
      local_time: '08:15', time_zone: 'America/Los_Angeles', scheduled_read_consent: true,
      status: 'paused', revision: 2, next_run_at: null,
      name: 'Email recap', instructions: '', gmail_query: '', weekdays: [1, 2, 3, 4, 5, 6, 7], summary_style: 'concise',
      created_at: expect.any(String), updated_at: expect.any(String),
    }]);
    const serialized = JSON.stringify(body);
    for (const forbidden of [theirs.id, theirs.googleId, 'routine-private-installation', 'routine-private-provider']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(keysOf(body).filter((key) => /token|refresh|hash|secret/i.test(key))).toEqual([]);
    expect(AccountExportResponseSchema.safeParse({
      ...body, routines: [{ ...body.routines[0], refresh_token: 'must-not-export' }],
    }).success).toBe(false);
  });

  it('exports only owned Google account metadata and write receipts without broker selectors', async () => {
    const ownAccount = await addGoogleAccount(db, me.userId, { installationId: 'broker-private-owner', accountId: 'provider-private-owner', email: 'owner@example.test' });
    const otherAccount = await addGoogleAccount(db, other.userId, { installationId: 'broker-private-other', accountId: 'provider-private-other', email: 'other@example.test' });
    await renameGoogleAccount(db, me.userId, ownAccount.id, 'Job search');
    const operationId = randomUUID();
    await claimGoogleOperation(db, me.userId, ownAccount.id, { operationId, kind: 'calendar_create', intentHash: 'a'.repeat(64), stableKey: 'abc123' });
    await finishGoogleOperation(db, me.userId, ownAccount.id, operationId, 'pending', 'succeeded', 'abc123');
    await claimGoogleOperation(db, other.userId, otherAccount.id, { operationId: randomUUID(), kind: 'gmail_draft', intentHash: 'b'.repeat(64), stableKey: '<private@heybob.xyz>' });
    const body = await exportBody();
    expect(body.google_accounts).toEqual([expect.objectContaining({ id: ownAccount.id, email: 'owner@example.test', custom_name: 'Job search' })]);
    expect(body.google_operations).toEqual([expect.objectContaining({ operation_id: operationId, google_account_id: ownAccount.id, kind: 'calendar_create', state: 'succeeded', result_id: 'abc123' })]);
    const serialized = JSON.stringify(body);
    for (const internal of ['broker-private', 'provider-private', 'other@example.test', 'intent_hash', 'stable_key']) {
      expect(serialized).not.toContain(internal);
    }
  });

  it('retains the Bob export name for an explicit Bob origin', async () => {
    const response = await fetch(`${baseUrl}/api/account/export`, {
      headers: { authorization: `Bearer ${myToken}`, origin: 'https://app.heybob.xyz' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="bob-export-\d{4}-\d{2}-\d{2}\.json"$/);
    await response.text();
  });

  it('streams a dated JSON attachment that is never cached', async () => {
    const res = await download('/api/account/export', myToken);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="bob-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      'format', 'version', 'exported_at', 'spaces', 'group_chats', 'group_chat_links', 'conversations', 'memories',
      'tasks', 'notes', 'events', 'reminders', 'timers',
      'action_items', 'game_sessions', 'game_settings', 'game_usage', 'google_accounts', 'google_operations',
      'google_calendar_selections', 'google_operation_slots', 'routines', 'routine_runs', 'insights',
      'routine_results', 'tool_preferences', 'bob_apps', 'bob_app_schedules', 'bob_app_runs',
    ]);
  });

  it('exports owned app records and pending revisions without mutation internals', async () => {
    const owner = await addAccount(pg); const stranger = await addAccount(pg);
    const app = await createBobApp(db, owner.userId, { definition: packing, mutationId: randomUUID(), state: { items: [{ id: 'one', values: { label: 'Bag', packed: true } }] } });
    const foreign = await createBobApp(db, stranger.userId, { definition: packing, mutationId: randomUUID() });
    await mutateBobApp(db, owner.userId, app.id, { operation: 'revise', expectedRevision: 1, mutationId: randomUUID(), definition: { ...packing, title: 'Updated' } });
    const data = await readAccountExport(db, owner.userId);
    expect(data.bob_apps).toHaveLength(1);
    expect(data.bob_apps[0]).toMatchObject({ id: app.id, pending_definition: { title: 'Updated' }, state: app.state });
    expect(JSON.stringify(data.bob_apps)).not.toContain(foreign.id);
    expect(keysOf(data.bob_apps)).not.toContain('fingerprint');
    expect(keysOf(data.bob_apps)).not.toContain('mutation_id');
  });
  it('includes only owned app schedules and bounded run metadata', async () => {
    const owner = await addAccount(pg); const stranger = await addAccount(pg);
    const space = await ensurePrivateSpace(db, owner.userId);
    const definition = { ...packing, tables: [{ id: 'items', fields: [{ id: 'title', type: 'text' }, { id: 'completed', type: 'boolean' }] }],
      views: [{ id: 'list', kind: 'table', title: 'Tasks', table: 'items', fields: ['title', 'completed'], actions: [] }] };
    const draft = await createBobApp(db, owner.userId, { definition, mutationId: randomUUID() });
    const app = await mutateBobApp(db, owner.userId, draft.id, { operation: 'activate', expectedRevision: 1, mutationId: randomUUID() });
    const config = { source: 'tasks', spaceId: space.id, targetTable: 'items', schedule: { weekdays: [1], localTime: '09:00', timeZone: 'UTC' } };
    const now = Date.UTC(2026, 9, 24);
    await configureBobAppRefresh(db, owner.userId, app.id, { expectedRevision: app.revision, mutationId: randomUUID(), enabled: true, consent: true, config }, now);
    await dispatchBobAppRefreshes(db, now);
    const data = await readAccountExport(db, owner.userId);
    expect(data.bob_app_schedules).toEqual([expect.objectContaining({ app_id: app.id, enabled: true, config })]);
    expect(data.bob_app_runs).toEqual([expect.objectContaining({ app_id: app.id, status: 'pending' })]);
    const foreign = await readAccountExport(db, stranger.userId);
    expect(foreign.bob_app_schedules).toEqual([]); expect(foreign.bob_app_runs).toEqual([]);
    expect(keysOf(data.bob_app_runs)).not.toContain('user_id');
  });

  it('exports only owned calendar preferences and opaque slot mappings, and unlink cascades both', async () => {
    async function seed(owner: string) {
      const account = await addGoogleAccount(db, owner, { installationId: randomUUID(), accountId: `broker-${randomUUID()}`, email: 'preference@example.test' });
      const conversation = await createConversation(db, owner, 'Slot export');
      const message = await appendMessage(db, owner, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'Create an event' }] });
      if (!message) throw new Error('missing anchor');
      const slot = createGoogleMutationSlots({ conversationId: conversation.id, messageId: message.id, allowNewOperations: true }).next();
      const claim = await claimGoogleToolOperation(db, owner, account.id, slot, { kind: 'calendar_create', intentHash: 'c'.repeat(64), targetHash: 'd'.repeat(64) });
      await replaceGoogleCalendarSelections(db, owner, account.id, [{ account_id: account.id, calendar_id: 'calendar-1', title: 'Selected calendar', time_zone: 'UTC', last_success_at: null }]);
      return { account, message, claim };
    }
    const own = await seed(me.userId);
    const foreign = await seed(other.userId);
    const body = await exportBody();
    expect(body.google_calendar_selections).toEqual([{ google_account_id: own.account.id, calendar_id: 'calendar-1', title: 'Selected calendar', time_zone: 'UTC', last_success_at: null }]);
    expect(body.google_operation_slots).toEqual([{ google_account_id: own.account.id, anchor_message_id: own.message.id, ordinal: 0, kind: 'calendar_create', operation_id: own.claim.receipt.operationId }]);
    const encoded = JSON.stringify(body);
    for (const forbidden of [foreign.account.id, foreign.message.id, foreign.claim.receipt.operationId, 'target_hash', 'intent_hash', 'stable_key', own.account.installationId, own.account.accountId]) expect(encoded).not.toContain(forbidden);
    await deleteGoogleAccount(db, me.userId, own.account.id);
    const after = await exportBody();
    expect(after.google_calendar_selections).toEqual([]);
    expect(after.google_operation_slots).toEqual([]);
    expect(JSON.stringify(after.google_operations)).not.toContain(own.claim.receipt.operationId);
    const others = await readAccountExport(db, other.userId);
    expect(others.google_calendar_selections).toEqual([expect.objectContaining({ google_account_id: foreign.account.id })]);
    expect(others.google_operation_slots).toEqual([expect.objectContaining({ operation_id: foreign.claim.receipt.operationId })]);
  });

  it('(1) contains my note from a shared space; excludes another member\'s private and shared notes', async () => {
    const body = await exportBody();
    const titles = body.notes.map((n) => n.title);
    expect(titles).toContain('My shared note');
    expect(titles).not.toContain('Their private note');
    expect(titles).not.toContain('Their shared note');
    expect(body.notes.find((n) => n.title === 'My shared note')?.space_id).toBe(sharedId);
  });

  it('carries my conversations, tasks, events, reminders and timers, messages as text only', async () => {
    const body = await exportBody();
    expect(body.conversations[0]?.messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'Plan our trip' }),
    ]);
    for (const section of ['tasks', 'events', 'reminders', 'timers']) {
      expect((body[section] as unknown[]).length).toBe(1);
    }
  });

  it('carries my game sessions, settings, usage and action-item status, not another account', async () => {
    const seedGames = async (account: TestAccount, name: string): Promise<void> => {
      const talk = await createConversation(db, account.userId, 'Games');
      const game = await createGameSession(db, account.userId, {
        conversationId: talk.id, game: 'animal_riddles', players: [{ name, band: 'kid' }], state: {},
      });
      await upsertGameSettings(db, account.userId, { dailyLimitMinutes: 30 });
      await addGameUsage(db, account.userId, 120, { timeZone: 'UTC' });
      expect(game.players).toHaveLength(1);
      const memoryId = await withUserRaw(pg, account.userId, async (tx) => (await tx.query<{ id: string }>(
        `INSERT INTO bob.memories (user_id, kind, content, confidence) VALUES ($1, 'action_item', $2, 0.9) RETURNING id`,
        [account.userId, `${name} books the dentist`],
      )).rows[0]!.id);
      const item = await createActionItem(db, account.userId, { memoryId });
      await setActionItemStatus(db, account.userId, item.id, 'done');
    };
    await seedGames(me, 'Maya');
    await seedGames(other, 'Theo');
    const body = await exportBody() as ExportBody & Record<'game_sessions' | 'game_settings' | 'game_usage' | 'action_items', Array<Record<string, unknown>>>;
    expect(body.game_sessions).toEqual([expect.objectContaining({
      game: 'animal_riddles', status: 'active', players: [{ name: 'Maya', band: 'kid' }], scores: [0],
    })]);
    expect(body.game_sessions[0]).not.toHaveProperty('seed');
    expect(body.game_settings).toEqual([expect.objectContaining({ daily_limit_minutes: 30, enabled: true })]);
    expect(body.game_usage).toEqual([expect.objectContaining({ seconds: 120 })]);
    expect(body.action_items).toEqual([expect.objectContaining({ status: 'done' })]);
    expect(JSON.stringify(body)).not.toContain('Theo');
  });

  it('(2) a key scan finds no token, refresh, hash or secret key anywhere', async () => {
    const body = await exportBody();
    const banned = keysOf(body).filter((key) => /token|refresh|hash|secret/i.test(key));
    expect(banned).toEqual([]);
  });

  it('(3) after leaving a space, that space and its content are absent', async () => {
    const before = await exportBody();
    expect(before.spaces.map((s) => s.id)).toContain(clubId);
    expect(before.notes.map((n) => n.title)).toContain('Club note');

    await revokeMember(db, me.userId, clubId, me.userId);

    const after = await exportBody();
    expect(after.spaces.map((s) => s.id)).not.toContain(clubId);
    expect(after.notes.map((n) => n.title)).not.toContain('Club note');
    expect(after.notes.map((n) => n.title)).toContain('My shared note');
  });

  it('(4) journals one counts-only event', async () => {
    await exportBody();
    const calls = vi.mocked(journal).mock.calls.filter(([event]) => event === 'v2.account_exported');
    expect(calls).toHaveLength(1);
    const fields = calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual([
      'action_items', 'conversations', 'duration_ms', 'events', 'game_sessions', 'game_settings', 'game_usage',
      'memories', 'messages', 'notes', 'reminders', 'spaces', 'tasks', 'timers',
    ]);
    expect(Object.values(fields).every((value) => typeof value === 'number')).toBe(true);
    expect(fields.notes).toBe(1);
  });

  it('is rate limited per account: a second export within the minute is 429', async () => {
    expect((await download('/limited/account/export', myToken)).status).toBe(200);
    const second = await download('/limited/account/export', myToken);
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    expect(vi.mocked(journal)).toHaveBeenCalledWith('v2.rate_limited', { route: '/api/account/export' });
  });

  it('refuses a token whose session is no longer active', async () => {
    const stale = await signToken({ userId: me.userId, sessionId: randomUUID() });
    expect((await download('/api/account/export', stale)).status).toBe(401);
  });
});
