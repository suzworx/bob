import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../platform/db/db.ts';
import { resolveGoogleCredential, type GoogleCapability, type GoogleCredentialResolver } from './google-credentials.ts';
import { createGoogleMailActionsClient, GoogleMailActionsError } from './google-mail-actions-client.ts';
import { GmailProviderError } from './google-gmail-client.ts';
import { claimGoogleOperation, finishGoogleOperation, getGoogleOperation } from './google-operation-store.ts';
import { claimGoogleToolOperation, type GoogleMutationSlot } from './google-tool-operation.ts';

const Identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const Address = z.email().max(254).regex(/^[^\s<>\u0000-\u001f\u007f]+$/);
const Content = z.object({
  to: z.array(Address).min(1).max(20), cc: z.array(Address).max(20).default([]), bcc: z.array(Address).max(20).default([]),
  subject: z.string().min(1).max(998).regex(/^[^\u0000-\u001f\u007f]+$/), body: z.string().min(1).max(12000),
}).strict().refine((v) => v.to.length + v.cc.length + v.bcc.length <= 20);
const Compose = z.object({ content: Content }).strict();
const Update = z.object({ draftId: Identifier, expectedFingerprint: Fingerprint, content: Content }).strict();
const Send = Update;
const Label = z.object({ messageId: Identifier }).strict();
export const googleMailActionsInputs = { compose: Compose, update: Update, send: Send, message: Label, identifier: Identifier };
type ContentValue = z.output<typeof Content>;
type MutationIdentity = { operationId: string; slot?: never } | { slot: GoogleMutationSlot; operationId?: never };
type Draft = { id: string; fingerprint: string; rfcMessageId: string | null; content: ContentValue };
/** Provider boundary must return bounded, validated responses, exact RFC marker
 * matches and SENT labels for findSent. Send must submit the supplied reviewed
 * bytes, not whatever draft contents happen to exist after the fresh read. */
export interface GmailActionsClient {
  composeDraft(token: string, input: { content: ContentValue; messageId: string }, signal: AbortSignal): Promise<{ id: string }>;
  readDraft(token: string, draftId: string, signal: AbortSignal): Promise<Draft>;
  updateDraft(token: string, input: { draftId: string; expectedFingerprint: string; content: ContentValue; messageId: string }, signal: AbortSignal): Promise<{ id: string }>;
  sendDraft(token: string, input: { draftId: string; expectedFingerprint: string; content: ContentValue; messageId: string }, signal: AbortSignal): Promise<{ id: string }>;
  findDrafts(token: string, input: { messageId: string; pageToken?: string }, signal: AbortSignal): Promise<{ drafts: { id: string }[]; nextPageToken?: string }>;
  findSent(token: string, input: { messageId: string; pageToken?: string }, signal: AbortSignal): Promise<{ messages: { id: string }[]; nextPageToken?: string }>;
  readMessageState(token: string, messageId: string, signal: AbortSignal): Promise<{ id: string; labelIds: string[] }>;
  trashMessage(token: string, messageId: string, signal: AbortSignal): Promise<{ id: string }>;
  restoreMessage(token: string, messageId: string, signal: AbortSignal): Promise<{ id: string }>;
}
interface Result { status: 'succeeded' | 'unknown' | 'failed'; operationId: string; resultId?: string; reason?: string; nextPageToken?: string }
interface Service {
  composeDraft(userId: string, accountId: string, input: z.input<typeof Compose> & MutationIdentity, signal?: AbortSignal): Promise<Result>;
  readDraft(userId: string, accountId: string, draftId: string, signal?: AbortSignal): Promise<Draft>;
  updateDraft(userId: string, accountId: string, input: z.input<typeof Update> & MutationIdentity, signal?: AbortSignal): Promise<Result>;
  sendDraft(userId: string, accountId: string, input: z.input<typeof Send> & MutationIdentity, signal?: AbortSignal): Promise<Result>;
  trashMessage(userId: string, accountId: string, input: z.input<typeof Label> & MutationIdentity, signal?: AbortSignal): Promise<Result>;
  restoreMessage(userId: string, accountId: string, input: z.input<typeof Label> & MutationIdentity, signal?: AbortSignal): Promise<Result>;
}
interface Dependencies { db: Db; client?: GmailActionsClient; resolveCredential: GoogleCredentialResolver }
type Receipt = NonNullable<Awaited<ReturnType<typeof getGoogleOperation>>>;
type Kind = 'gmail_compose' | 'gmail_update_draft' | 'gmail_send' | 'gmail_trash' | 'gmail_restore';
type Value = z.output<typeof Compose> | z.output<typeof Update> | z.output<typeof Label>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('gmail_invalid_input');
  return encoded;
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function deadline(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function result(receipt: Receipt): Result {
  return { status: receipt.state === 'pending' ? 'unknown' : receipt.state, operationId: receipt.operationId,
    ...(receipt.resultId ? { resultId: receipt.resultId } : {}) };
}
function target(value: Value): string {
  if ('draftId' in value) return value.draftId;
  if ('messageId' in value) return value.messageId;
  return hash([value.content.to, value.content.cc, value.content.bcc, value.content.subject]);
}
async function claim(db: Db, userId: string, accountId: string, kind: Kind, value: Value, identity: MutationIdentity): ReturnType<typeof claimGoogleOperation> {
  const intentHash = hash(value);
  const targetMessageId = 'messageId' in value ? value.messageId : undefined;
  if (identity.slot) return claimGoogleToolOperation(db, userId, accountId, identity.slot, {
    kind, intentHash, targetHash: hash(target(value)), ...(targetMessageId ? { targetMessageId } : {}),
  });
  return claimGoogleOperation(db, userId, accountId, { operationId: identity.operationId, kind, intentHash, targetHash: hash(target(value)),
    stableKey: targetMessageId ?? `<bob-${hash([userId, accountId, identity.operationId])}@heybob.xyz>` });
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error('gmail_invalid_input');
  return parsed.data;
}
function fields<T extends MutationIdentity>(input: T): Omit<T, 'slot' | 'operationId'> {
  const { slot: _slot, operationId: _operationId, ...value } = input;
  return value;
}
class StaleDraftError extends Error {}

export function createGmailActionsService(deps: Dependencies): Service {
  const { db } = deps;
  const client: GmailActionsClient = deps.client ?? createGoogleMailActionsClient();
  async function credential(userId: string, accountId: string, capability: GoogleCapability, signal: AbortSignal): Promise<string> {
    return resolveGoogleCredential(db, deps.resolveCredential, userId, accountId, capability, signal);
  }
  async function complete(userId: string, accountId: string, receipt: Receipt, id: string): Promise<Result> {
    if (receipt.state !== 'pending' && receipt.state !== 'unknown') return result(receipt);
    const saved = await finishGoogleOperation(db, userId, accountId, receipt.operationId, receipt.state, 'succeeded', id)
      ?? await getGoogleOperation(db, userId, accountId, receipt.operationId);
    return saved ? result(saved) : { status: 'unknown', operationId: receipt.operationId };
  }
  async function reconcileTarget(token: string, receipt: Receipt, value: Value, signal: AbortSignal): Promise<{ id?: string }> {
    if ('draftId' in value) {
      const draft = await client.readDraft(token, value.draftId, signal);
      return { id: draft.id === value.draftId && draft.rfcMessageId === receipt.stableKey && hash(draft.content) === hash(value.content) ? draft.id : undefined };
    }
    if ('messageId' in value) {
      const message = await client.readMessageState(token, value.messageId, signal);
      const desired = receipt.kind === 'gmail_trash';
      return { id: message.id === value.messageId && message.labelIds.includes('TRASH') === desired ? message.id : undefined };
    }
    return {};
  }
  async function markerPage(token: string, receipt: Receipt, signal: AbortSignal, pageToken?: string): Promise<{ items: { id: string }[]; nextPageToken?: string }> {
    const input = { messageId: receipt.stableKey, ...(pageToken ? { pageToken } : {}) };
    if (receipt.kind === 'gmail_compose') {
      const page = await client.findDrafts(token, input, signal);
      return { items: page.drafts, nextPageToken: page.nextPageToken };
    }
    const page = await client.findSent(token, input, signal);
    return { items: page.messages, nextPageToken: page.nextPageToken };
  }
  async function scanMarkers(token: string, receipt: Receipt, signal: AbortSignal): Promise<{ id?: string; nextPageToken?: string }> {
    const matches = new Set<string>();
    const cursors = new Set<string>();
    let pageToken: string | undefined;
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      signal.throwIfAborted();
      const page = await markerPage(token, receipt, signal, pageToken);
      page.items.forEach((item) => { matches.add(item.id); });
      if (matches.size > 1) return {};
      pageToken = page.nextPageToken;
      if (!pageToken) return { id: [...matches][0] };
      if (cursors.has(pageToken)) return { nextPageToken: pageToken };
      cursors.add(pageToken);
    }
    // Queries are marker-filtered. More than 100 candidates or a looping cursor
    // is inconclusive; it never authorizes a second write or a partial success.
    return { nextPageToken: pageToken };
  }
  async function reconcileId(token: string, receipt: Receipt, value: Value, signal: AbortSignal): Promise<{ id?: string; nextPageToken?: string }> {
    if (receipt.kind === 'gmail_compose' || receipt.kind === 'gmail_send') return scanMarkers(token, receipt, signal);
    return reconcileTarget(token, receipt, value, signal);
  }
  async function reconcile(userId: string, accountId: string, token: string, receipt: Receipt, value: Value, signal: AbortSignal): Promise<Result> {
    if (receipt.state === 'succeeded' || receipt.state === 'failed') return result(receipt);
    try {
      const found = await reconcileId(token, receipt, value, signal);
      if (found.id) return complete(userId, accountId, receipt, found.id);
      return { status: 'unknown', operationId: receipt.operationId, ...(found.nextPageToken ? { nextPageToken: found.nextPageToken } : {}) };
    } catch { return { status: 'unknown', operationId: receipt.operationId }; }
  }
  async function freshDraft(token: string, value: z.output<typeof Update>, signal: AbortSignal, compareContent: boolean): Promise<void> {
    const draft = await client.readDraft(token, value.draftId, signal);
    if (draft.id !== value.draftId || draft.fingerprint !== value.expectedFingerprint
      || (compareContent && hash(draft.content) !== hash(value.content))) throw new StaleDraftError('gmail_stale_draft');
  }
  async function perform(token: string, kind: Kind, value: Value, stableKey: string, signal: AbortSignal): Promise<{ id: string }> {
    if (kind === 'gmail_compose' && 'content' in value) return client.composeDraft(token, { content: value.content, messageId: stableKey }, signal);
    if ('draftId' in value) {
      await freshDraft(token, value, signal, kind === 'gmail_send');
      const input = { draftId: value.draftId, expectedFingerprint: value.expectedFingerprint, content: value.content, messageId: stableKey };
      return kind === 'gmail_send' ? client.sendDraft(token, input, signal) : client.updateDraft(token, input, signal);
    }
    if ('messageId' in value) return kind === 'gmail_trash' ? client.trashMessage(token, value.messageId, signal) : client.restoreMessage(token, value.messageId, signal);
    throw new StaleDraftError('gmail_invalid_input');
  }
  async function failure(userId: string, accountId: string, receipt: Receipt, error: unknown): Promise<Result> {
    const provider = error instanceof GmailProviderError || error instanceof GoogleMailActionsError;
    const definitive = error instanceof StaleDraftError || (provider && error.submissionStarted === false);
    const state = definitive ? 'failed' : 'unknown';
    await finishGoogleOperation(db, userId, accountId, receipt.operationId, 'pending', state);
    return { status: state, operationId: receipt.operationId,
      ...(error instanceof StaleDraftError ? { reason: 'stale_draft' } : {}),
      ...(definitive && provider ? { reason: error.code } : {}) };
  }
  async function mutate(userId: string, accountId: string, kind: Kind, capability: GoogleCapability, value: Value, identity: MutationIdentity, signal?: AbortSignal): Promise<Result> {
    const bounded = deadline(signal);
    const token = await credential(userId, accountId, capability, bounded);
    const reserved = await claim(db, userId, accountId, kind, value, identity);
    const receipt = reserved.receipt;
    if (!reserved.execute) return reconcile(userId, accountId, token, receipt, value, bounded);
    try {
      const submitted = await perform(token, kind, value, receipt.stableKey, bounded);
      if ('messageId' in value && submitted.id !== value.messageId) throw new Error('gmail_invalid_response');
      if (kind === 'gmail_update_draft' && 'draftId' in value && submitted.id !== value.draftId) throw new Error('gmail_invalid_response');
      return await complete(userId, accountId, receipt, submitted.id);
    } catch (error) {
      return failure(userId, accountId, receipt, error);
    }
  }
  return {
    async readDraft(userId, accountId, draftId, signal) {
      const id = parse(Identifier, draftId);
      const bounded = deadline(signal);
      return client.readDraft(await credential(userId, accountId, 'gmail.read', bounded), id, bounded);
    },
    composeDraft: (userId, accountId, input, signal) => mutate(userId, accountId, 'gmail_compose', 'gmail.draft', parse(Compose, fields(input)), input, signal),
    updateDraft: (userId, accountId, input, signal) => mutate(userId, accountId, 'gmail_update_draft', 'gmail.draft', parse(Update, fields(input)), input, signal),
    sendDraft: (userId, accountId, input, signal) => mutate(userId, accountId, 'gmail_send', 'gmail.send', parse(Send, fields(input)), input, signal),
    trashMessage: (userId, accountId, input, signal) => mutate(userId, accountId, 'gmail_trash', 'gmail.modify', parse(Label, fields(input)), input, signal),
    restoreMessage: (userId, accountId, input, signal) => mutate(userId, accountId, 'gmail_restore', 'gmail.modify', parse(Label, fields(input)), input, signal),
  };
}
