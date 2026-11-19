import { createHash } from 'node:crypto';
import type { Db } from '../platform/db/db.ts';
import { createGoogleCalendarClient } from './google-calendar-client.ts';
import { resolveGoogleCredential, type GoogleCredentialResolver } from './google-credentials.ts';
import { claimGoogleOperation, finishGoogleOperation, getGoogleOperation } from './google-operation-store.ts';
import { claimGoogleToolOperation, type GoogleMutationSlot } from './google-tool-operation.ts';

type Client = ReturnType<typeof createGoogleCalendarClient>;
type Event = Awaited<ReturnType<Client['readEvent']>>;
type CreateInput = { operationId: string; calendarId: string; event: Parameters<Client['createEvent']>[3] };
type UpdateInput = { operationId: string; calendarId: string; eventId: string; changes: Parameters<Client['updateEvent']>[3] };
type MutationIdentity = { operationId: string; slot?: never } | { slot: GoogleMutationSlot; operationId?: never };
type CreateRequest = Omit<CreateInput, 'operationId'> & MutationIdentity;
type UpdateRequest = Omit<UpdateInput, 'operationId'> & MutationIdentity;
interface WriteResult { status: 'succeeded' | 'failed' | 'unknown'; operationId: string; eventId: string; event?: Event; reason?: 'conflict' | 'unsafe_event' | 'invalid_request' }
interface Service {
  listCalendars(userId: string, accountId: string, input?: Parameters<Client['listCalendars']>[1], signal?: AbortSignal): ReturnType<Client['listCalendars']>;
  listEvents(userId: string, accountId: string, calendarId: string, input: Parameters<Client['listEvents']>[2], signal?: AbortSignal): ReturnType<Client['listEvents']>;
  createEvent(userId: string, accountId: string, input: CreateRequest, signal?: AbortSignal): Promise<WriteResult>;
  updateEvent(userId: string, accountId: string, input: UpdateRequest, signal?: AbortSignal): Promise<WriteResult>;
}
interface Dependencies { db: Db; resolveCredential: GoogleCredentialResolver; client?: Client }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter((entry) => entry[1] !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('calendar_invalid_request');
  return encoded;
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
async function claimCreate(db: Db, userId: string, accountId: string, request: CreateRequest, calendarId: string): ReturnType<typeof claimGoogleOperation> {
  const intentHash = digest({ calendarId, event: request.event });
  if (request.slot) return claimGoogleToolOperation(db, userId, accountId, request.slot, {
    kind: 'calendar_create', intentHash, targetHash: digest({ calendarId }),
  });
  return claimGoogleOperation(db, userId, accountId, {
    operationId: request.operationId, kind: 'calendar_create', intentHash,
    stableKey: digest({ userId, accountId, operationId: request.operationId }),
  });
}
function deadline(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function matchingTime(actual: Event['start'], expected: CreateInput['event']['start']): boolean {
  if (!actual) return false;
  if ('date' in expected) return 'date' in actual && actual.date === expected.date;
  return 'dateTime' in actual && Date.parse(actual.dateTime) === Date.parse(expected.dateTime)
    && (!expected.timeZone || actual.timeZone === expected.timeZone);
}
function matchingCreate(event: Event, expected: CreateInput['event']): boolean {
  if (event.status === 'cancelled' || event.attendees?.length || event.attendeesOmitted || event.recurrence?.length || event.recurringEventId || event.originalStartTime) return false;
  if (event.eventType && event.eventType !== 'default') return false;
  return event.summary === expected.summary
    && (expected.description === undefined || (event.description ?? '') === expected.description)
    && (expected.location === undefined || (event.location ?? '') === expected.location)
    && matchingTime(event.start, expected.start) && matchingTime(event.end, expected.end);
}
function matchingUpdate(event: Event, changes: UpdateInput['changes']): boolean {
  return Object.entries(changes).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === 'start' && changes.start) return matchingTime(event.start, changes.start);
    if (key === 'end' && changes.end) return matchingTime(event.end, changes.end);
    return (event[key as keyof Event] ?? '') === value;
  });
}

async function writable(client: Client, token: string, calendarId: string, signal?: AbortSignal): Promise<string> {
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const calendars = await client.listCalendars(token, { limit: 100, ...(pageToken ? { pageToken } : {}) }, signal);
    const found = calendars.items.find((calendar) => calendar.id === calendarId || (calendarId === 'primary' && calendar.primary));
    if (found) {
      if (found.accessRole !== 'owner' && found.accessRole !== 'writer') throw new Error('calendar_read_only');
      return found.id;
    }
    if (!calendars.nextPageToken) throw new Error('calendar_not_found');
    pageToken = calendars.nextPageToken;
  }
  throw new Error('calendar_selection_incomplete');
}

export function createGoogleCalendarService(deps: Dependencies): Service {
  const client = deps.client ?? createGoogleCalendarClient();
  async function credential(userId: string, accountId: string, write: boolean, signal?: AbortSignal): Promise<string> {
    return resolveGoogleCredential(deps.db, deps.resolveCredential, userId, accountId, write ? 'calendar.write' : 'calendar.read', signal);
  }
  async function complete(userId: string, accountId: string, operationId: string, expected: 'pending' | 'unknown', eventId: string): Promise<void> {
    const updated = await finishGoogleOperation(deps.db, userId, accountId, operationId, expected, 'succeeded', eventId);
    if (updated) return;
    const receipt = await getGoogleOperation(deps.db, userId, accountId, operationId);
    if (receipt?.state !== 'succeeded' || receipt.resultId !== eventId) throw new Error('calendar_receipt_unavailable');
  }
  async function reconcileCreate(userId: string, accountId: string, input: CreateInput, eventId: string, token: string, expected: 'pending' | 'unknown', signal?: AbortSignal): Promise<WriteResult> {
    const base = { operationId: input.operationId, eventId };
    let event: Event;
    try { event = await client.readEvent(token, input.calendarId, eventId, signal); }
    catch { return { ...base, status: 'unknown' }; }
    if (!matchingCreate(event, input.event)) return { ...base, status: 'unknown' };
    await complete(userId, accountId, input.operationId, expected, eventId);
    return { ...base, status: 'succeeded', event };
  }
  async function updateFailure(userId: string, accountId: string, input: UpdateInput, token: string, error: unknown, signal?: AbortSignal): Promise<WriteResult> {
    const reasons: Record<string, WriteResult['reason']> = { calendar_precondition_failed: 'conflict', calendar_unsafe_event: 'unsafe_event', calendar_invalid_request: 'invalid_request' };
    const reason = error instanceof Error ? reasons[error.message] : undefined;
    const status = reason ? 'failed' : 'unknown';
    await finishGoogleOperation(deps.db, userId, accountId, input.operationId, 'pending', status);
    let refreshed: Event | undefined;
    if (reason === 'conflict') {
      try { refreshed = await client.readEvent(token, input.calendarId, input.eventId, signal); }
      catch { /* Conflict remains definitive when refreshed state is unavailable. */ }
    }
    return { operationId: input.operationId, eventId: input.eventId, status, ...(reason ? { reason } : {}), ...(refreshed ? { event: refreshed } : {}) };
  }
  return {
    async listCalendars(userId, accountId, input = {}, signal): ReturnType<Client['listCalendars']> {
      signal = deadline(signal);
      return client.listCalendars(await credential(userId, accountId, false, signal), input, signal);
    },
    async listEvents(userId, accountId, calendarId, input, signal): ReturnType<Client['listEvents']> {
      signal = deadline(signal);
      return client.listEvents(await credential(userId, accountId, false, signal), calendarId, input, signal);
    },
    async createEvent(userId, accountId, request, signal): Promise<WriteResult> {
      signal = deadline(signal);
      const token = await credential(userId, accountId, true, signal);
      const calendarId = await writable(client, token, request.calendarId, signal);
      const claim = await claimCreate(deps.db, userId, accountId, request, calendarId);
      const eventId = claim.receipt.stableKey;
      const input: CreateInput = { calendarId, event: request.event, operationId: claim.receipt.operationId };
      const result = { operationId: input.operationId, eventId };
      if (!claim.execute) {
        if (claim.receipt.state === 'succeeded' || claim.receipt.state === 'failed') return { ...result, status: claim.receipt.state };
        return reconcileCreate(userId, accountId, input, eventId, token, claim.receipt.state, signal);
      }
      let event: Event;
      try { event = await client.createEvent(token, input.calendarId, eventId, input.event, signal); }
      catch (error) {
        const status = error instanceof Error && error.message === 'calendar_invalid_request' ? 'failed' : 'unknown';
        await finishGoogleOperation(deps.db, userId, accountId, input.operationId, 'pending', status);
        return { ...result, status };
      }
      if (!matchingCreate(event, input.event)) {
        await finishGoogleOperation(deps.db, userId, accountId, input.operationId, 'pending', 'unknown');
        return { ...result, status: 'unknown' };
      }
      await complete(userId, accountId, input.operationId, 'pending', eventId);
      return { ...result, status: 'succeeded', event };
    },
    async updateEvent(userId, accountId, request, signal): Promise<WriteResult> {
      signal = deadline(signal);
      const token = await credential(userId, accountId, true, signal);
      const calendarId = await writable(client, token, request.calendarId, signal);
      const intentHash = digest({ calendarId, eventId: request.eventId, changes: request.changes });
      const claim = request.slot
        ? await claimGoogleToolOperation(deps.db, userId, accountId, request.slot, {
          kind: 'calendar_update', intentHash, targetHash: digest({ calendarId, eventId: request.eventId }), updateEventId: request.eventId,
        })
        : await claimGoogleOperation(deps.db, userId, accountId, {
          operationId: request.operationId, kind: 'calendar_update', stableKey: request.eventId, intentHash,
        });
      const input: UpdateInput = { calendarId, changes: request.changes, eventId: claim.receipt.stableKey, operationId: claim.receipt.operationId };
      const base = { operationId: input.operationId, eventId: input.eventId };
      if (!claim.execute) {
        if (claim.receipt.state === 'succeeded' || claim.receipt.state === 'failed') return { ...base, status: claim.receipt.state };
        // Reading matching fields cannot prove this particular update ran.
        try { return { ...base, status: 'unknown', event: await client.readEvent(token, input.calendarId, input.eventId, signal) }; }
        catch { return { ...base, status: 'unknown' }; }
      }
      let event: Event;
      try { event = await client.updateEvent(token, input.calendarId, input.eventId, input.changes, signal); }
      catch (error) { return updateFailure(userId, accountId, input, token, error, signal); }
      if (!matchingUpdate(event, input.changes)) {
        await finishGoogleOperation(deps.db, userId, accountId, input.operationId, 'pending', 'unknown');
        return { ...base, status: 'unknown' };
      }
      await complete(userId, accountId, input.operationId, 'pending', input.eventId);
      return { ...base, status: 'succeeded', event };
    },
  };
}
