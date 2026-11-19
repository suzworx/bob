import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGoogleCalendarService } from '../../src/integrations/google-calendar-service.ts';
import { createGoogleCalendarClient } from '../../src/integrations/google-calendar-client.ts';
import { addGoogleAccount } from '../../src/integrations/google-store.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { createGoogleMutationSlots } from '../../src/integrations/google-tool-operation.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

describe('Google Calendar service durable writes', () => {
  let pg: TestDb;
  let db: Db;
  beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
  afterAll(async () => { await closeTestDb(pg); });
  const event = { summary: 'Lunch', start: { dateTime: '2026-10-18T12:00:00Z' }, end: { dateTime: '2026-10-18T13:00:00Z' } };
  async function setup(): Promise<{ userId: string; accountId: string }> {
    const user = await addAccount(pg);
    const account = await addGoogleAccount(db, user.userId, { installationId: randomUUID(), accountId: 'provider', email: 'test@example.test' });
    return { userId: user.userId, accountId: account.id };
  }
  it('replays trusted slots across the primary alias and permits distinct sequential events', async () => {
    const { userId, accountId } = await setup();
    const conversation = await createConversation(db, userId, 'Calendar');
    const message = await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'Create two events' }] });
    if (!message) throw new Error('missing message');
    const anchor = { conversationId: conversation.id, messageId: message.id };
    const slots = createGoogleMutationSlots({ ...anchor, allowNewOperations: true });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') return Response.json({ ...JSON.parse(String(options.body)), etag: '"v1"' });
      return Response.json({ items: [{ id: 'actual-calendar', primary: true, summary: 'Mine', accessRole: 'owner' }] });
    });
    const service = createGoogleCalendarService({ db, client: createGoogleCalendarClient(fetcher), resolveCredential: vi.fn().mockResolvedValue('token') });
    const first = await service.createEvent(userId, accountId, { slot: slots.next(), calendarId: 'primary', event });
    expect(first.status).toBe('succeeded');
    const second = await service.createEvent(userId, accountId, { slot: slots.next(), calendarId: 'actual-calendar', event: { ...event, summary: 'Dinner' } });
    expect(second.status).toBe('succeeded');
    expect(second.operationId).not.toBe(first.operationId);
    const replay = createGoogleMutationSlots({ ...anchor, allowNewOperations: false });
    expect(await service.createEvent(userId, accountId, { slot: replay.next(), calendarId: 'actual-calendar', event })).toMatchObject({ status: 'succeeded', operationId: first.operationId, eventId: first.eventId });
    await expect(service.createEvent(userId, accountId, { slot: replay.next(), calendarId: 'primary', event: { ...event, summary: 'Changed' } })).rejects.toThrow('google_operation_needs_review');
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(2);
  });
  it('submits once with a deterministic id and returns the persisted duplicate result', async () => {
    const { userId, accountId } = await setup();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') return Response.json({ ...JSON.parse(String(options.body)), etag: '"v1"' });
      return Response.json({ items: [{ id: 'primary', summary: 'Mine', accessRole: 'owner' }] });
    });
    const credentials = vi.fn().mockResolvedValue('token');
    const service = createGoogleCalendarService({ db, client: createGoogleCalendarClient(fetcher), resolveCredential: credentials });
    const input = { operationId: randomUUID(), calendarId: 'primary', event };
    const signal = new AbortController().signal;
    const first = await service.createEvent(userId, accountId, input, signal);
    expect(first.status).toBe('succeeded');
    expect(first.eventId).toMatch(/^[a-f0-9]{64}$/);
    expect(await service.createEvent(userId, accountId, input, signal)).toMatchObject({ status: 'succeeded', eventId: first.eventId });
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
    expect(credentials).toHaveBeenCalledWith(expect.objectContaining({ userId, accountId, capability: 'calendar.write', signal: expect.any(AbortSignal) }));
  });
  it('keeps lost create outcomes unknown and reconciles by stable id without resubmitting', async () => {
    const { userId, accountId } = await setup();
    let created: Record<string, unknown> | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
      if (options?.method === 'POST') { created = JSON.parse(String(options.body)) as Record<string, unknown>; throw new Error('lost response'); }
      if (String(url).includes('/events/')) return Response.json({ ...created, etag: '"v1"' });
      return Response.json({ items: [{ id: 'primary', summary: 'Mine', accessRole: 'owner' }] });
    });
    const service = createGoogleCalendarService({ db, client: createGoogleCalendarClient(fetcher), resolveCredential: vi.fn().mockResolvedValue('token') });
    const input = { operationId: randomUUID(), calendarId: 'primary', event };
    expect(await service.createEvent(userId, accountId, input)).toMatchObject({ status: 'unknown' });
    expect(await service.createEvent(userId, accountId, input)).toMatchObject({ status: 'succeeded' });
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });
  it('returns refreshed conflict state and never retries the conditional update', async () => {
    const { userId, accountId } = await setup();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
      if (options?.method === 'PATCH') return new Response('', { status: 412 });
      if (String(url).includes('/events/')) return Response.json({ ...event, id: 'abc123', etag: '"v2"' });
      return Response.json({ items: [{ id: 'primary', summary: 'Mine', accessRole: 'owner' }] });
    });
    const service = createGoogleCalendarService({ db, client: createGoogleCalendarClient(fetcher), resolveCredential: vi.fn().mockResolvedValue('token') });
    const input = { operationId: randomUUID(), calendarId: 'primary', eventId: 'abc123', changes: { summary: 'Dinner' } };
    expect(await service.updateEvent(userId, accountId, input)).toMatchObject({ status: 'failed', reason: 'conflict', event: { etag: '"v2"' } });
    expect(await service.updateEvent(userId, accountId, input)).toMatchObject({ status: 'failed' });
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'PATCH')).toHaveLength(1);
  });
  it('rejects wrong-owner and revoked grants before provider calls', async () => {
    const { userId, accountId } = await setup();
    const other = await addAccount(pg);
    const fetcher = vi.fn<typeof fetch>();
    const credentials = vi.fn().mockRejectedValue(new Error('private token failure'));
    const service = createGoogleCalendarService({ db, client: createGoogleCalendarClient(fetcher), resolveCredential: credentials });
    await expect(service.listCalendars(other.userId, accountId)).rejects.toThrow('google_account_not_found');
    expect(credentials).not.toHaveBeenCalled();
    await expect(service.listCalendars(userId, accountId)).rejects.not.toThrow('private token failure');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['reader', 'freeBusyReader', 'writerWithoutPrivateAccess'])('refuses calendar access role %s without a write', async (accessRole) => {
    const { userId, accountId } = await setup();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [{ id: 'primary', summary: 'Read only', accessRole }] }));
    const service = createGoogleCalendarService({ db, client: createGoogleCalendarClient(fetcher), resolveCredential: vi.fn().mockResolvedValue('token') });
    await expect(service.createEvent(userId, accountId, { operationId: randomUUID(), calendarId: 'primary', event })).rejects.toThrow('calendar_read_only');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reports incomplete calendar discovery instead of guessing after the page cap', async () => {
    const { userId, accountId } = await setup();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ items: [], nextPageToken: 'more' }));
    const service = createGoogleCalendarService({ db, client: createGoogleCalendarClient(fetcher), resolveCredential: vi.fn().mockResolvedValue('token') });
    await expect(service.createEvent(userId, accountId, { operationId: randomUUID(), calendarId: 'missing', event })).rejects.toThrow('calendar_selection_incomplete');
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it('keeps an uncertain update unknown even when refreshed fields match', async () => {
    const { userId, accountId } = await setup();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
      if (options?.method === 'PATCH') throw new Error('connection lost');
      if (String(url).includes('/events/')) return Response.json({ ...event, summary: 'Dinner', id: 'abc123', etag: '"v2"' });
      return Response.json({ items: [{ id: 'primary', summary: 'Mine', accessRole: 'owner' }] });
    });
    const service = createGoogleCalendarService({ db, client: createGoogleCalendarClient(fetcher), resolveCredential: vi.fn().mockResolvedValue('token') });
    const input = { operationId: randomUUID(), calendarId: 'primary', eventId: 'abc123', changes: { summary: 'Dinner' } };
    expect(await service.updateEvent(userId, accountId, input)).toMatchObject({ status: 'unknown' });
    expect(await service.updateEvent(userId, accountId, input)).toMatchObject({ status: 'unknown', event: { summary: 'Dinner' } });
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'PATCH')).toHaveLength(1);
  });
  it('reconciles equivalent provider-normalized times and does not recreate on a missing lookup', async () => {
    const { userId, accountId } = await setup();
    let missing = true;
    let id = '';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
      if (options?.method === 'POST') { id = (JSON.parse(String(options.body)) as { id: string }).id; throw new Error('unknown'); }
      if (String(url).includes('/events/')) return missing ? new Response('', { status: 404 }) : Response.json({ ...event, id, etag: '"v1"', start: { dateTime: '2026-10-18T12:00:00+00:00', timeZone: 'UTC' }, end: { dateTime: '2026-10-18T13:00:00+00:00', timeZone: 'UTC' } });
      return Response.json({ items: [{ id: 'primary', summary: 'Mine', accessRole: 'owner' }] });
    });
    const service = createGoogleCalendarService({ db, client: createGoogleCalendarClient(fetcher), resolveCredential: vi.fn().mockResolvedValue('token') });
    const input = { operationId: randomUUID(), calendarId: 'primary', event };
    expect((await service.createEvent(userId, accountId, input)).status).toBe('unknown');
    expect((await service.createEvent(userId, accountId, input)).status).toBe('unknown');
    missing = false;
    expect((await service.createEvent(userId, accountId, input)).status).toBe('succeeded');
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });
  it('serializes concurrent operation claims and rejects changed intent without another write', async () => {
    const { userId, accountId } = await setup();
    let saved: Record<string, unknown> | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
      if (options?.method === 'POST') { saved = JSON.parse(String(options.body)) as Record<string, unknown>; return Response.json({ ...saved, etag: '"v1"' }); }
      if (String(url).includes('/events/')) return saved ? Response.json({ ...saved, etag: '"v1"' }) : new Response('', { status: 404 });
      return Response.json({ items: [{ id: 'primary', summary: 'Mine', accessRole: 'owner' }] });
    });
    const service = createGoogleCalendarService({ db, client: createGoogleCalendarClient(fetcher), resolveCredential: vi.fn().mockResolvedValue('token') });
    const input = { operationId: randomUUID(), calendarId: 'primary', event };
    const results = await Promise.all([service.createEvent(userId, accountId, input), service.createEvent(userId, accountId, input)]);
    expect(results.some((result) => result.status === 'succeeded')).toBe(true);
    await expect(service.createEvent(userId, accountId, { ...input, event: { ...event, summary: 'Changed' } })).rejects.toThrow('google_operation_intent_mismatch');
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });
  it('propagates cancellation before any provider request', async () => {
    const { userId, accountId } = await setup();
    const fetcher = vi.fn<typeof fetch>();
    const credentials = vi.fn().mockResolvedValue('token');
    const controller = new AbortController();
    controller.abort();
    const service = createGoogleCalendarService({ db, client: createGoogleCalendarClient(fetcher), resolveCredential: credentials });
    await expect(service.listCalendars(userId, accountId, {}, controller.signal)).rejects.toThrow('google_credentials_cancelled');
    expect(credentials).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('treats incomplete successful create response as unknown, not a completed receipt', async () => {
    const { userId, accountId } = await setup();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') return Response.json({ id: (JSON.parse(String(options.body)) as { id: string }).id, etag: '"v1"' });
      return Response.json({ items: [{ id: 'primary', summary: 'Mine', accessRole: 'owner' }] });
    });
    const service = createGoogleCalendarService({ db, client: createGoogleCalendarClient(fetcher), resolveCredential: vi.fn().mockResolvedValue('token') });
    expect(await service.createEvent(userId, accountId, { operationId: randomUUID(), calendarId: 'primary', event })).toMatchObject({ status: 'unknown' });
  });
  it('treats an update response that omits requested changes as unknown', async () => {
    const { userId, accountId } = await setup();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes('/events/')) return Response.json({ ...event, id: 'abc123', etag: '"v2"' });
      return Response.json({ items: [{ id: 'primary', summary: 'Mine', accessRole: 'owner' }] });
    });
    const service = createGoogleCalendarService({ db, client: createGoogleCalendarClient(fetcher), resolveCredential: vi.fn().mockResolvedValue('token') });
    expect(await service.updateEvent(userId, accountId, { operationId: randomUUID(), calendarId: 'primary', eventId: 'abc123', changes: { summary: 'New title' } })).toMatchObject({ status: 'unknown' });
  });
});
