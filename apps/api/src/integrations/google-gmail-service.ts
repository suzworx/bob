import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../platform/db/db.ts';
import { resolveGoogleCredential, type GoogleCredentialResolver } from './google-credentials.ts';
import { createGmailProviderClient, GmailProviderError } from './google-gmail-client.ts';
import { claimGoogleOperation, finishGoogleOperation, getGoogleOperation } from './google-operation-store.ts';
import { claimGoogleToolOperation, type GoogleMutationSlot } from './google-tool-operation.ts';

const DraftFields = z.object({
  sourceMessageId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  body: z.string().min(1).max(12000),
}).strict();
const DraftInput = z.union([
  DraftFields.extend({ operationId: z.string().uuid() }),
  DraftFields.extend({ slot: z.custom<GoogleMutationSlot>((value) => typeof value === 'object' && value !== null) }),
]);
type DraftResult = { status: 'succeeded'; operationId: string; draftId: string }
  | { status: 'unknown' | 'failed'; operationId: string; nextPageToken?: string; reason?: GmailProviderError['code'] };
type Client = ReturnType<typeof createGmailProviderClient>;
type Receipt = NonNullable<Awaited<ReturnType<typeof getGoogleOperation>>>;
const ReconcileInput = z.object({ operationId: z.string().uuid(), pageToken: z.string().min(1).max(2048).optional() }).strict();
interface Dependencies {
  /** Must be the root connection; claims must commit before provider HTTP. */
  db: Db;
  client?: ReturnType<typeof createGmailProviderClient>;
  resolveCredential: GoogleCredentialResolver;
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function deadline(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function receiptResult(receipt: Receipt | null, operationId: string): DraftResult {
  if (receipt?.state === 'succeeded' && receipt.resultId) return { status: 'succeeded', operationId, draftId: receipt.resultId };
  return { status: receipt?.state === 'failed' ? 'failed' : 'unknown', operationId };
}

async function claimDraft(db: Db, userId: string, accountId: string, value: z.infer<typeof DraftInput>): Promise<Awaited<ReturnType<typeof claimGoogleOperation>>> {
  const intentHash = hash(JSON.stringify([value.sourceMessageId, value.body]));
  if ('slot' in value) return claimGoogleToolOperation(db, userId, accountId, value.slot, {
    kind: 'gmail_draft', intentHash, targetHash: hash(value.sourceMessageId),
  });
  return claimGoogleOperation(db, userId, accountId, {
    operationId: value.operationId, kind: 'gmail_draft',
    stableKey: `<bob-${hash(JSON.stringify([userId, accountId, value.operationId]))}@heybob.xyz>`, intentHash,
  });
}

export function createGmailService(deps: Dependencies): {
  createReplyDraft(userId: string, accountId: string, input: z.input<typeof DraftInput>, signal?: AbortSignal): Promise<DraftResult>;
  reconcileReplyDraft(userId: string, accountId: string, input: z.input<typeof ReconcileInput>, signal?: AbortSignal): Promise<DraftResult>;
  search(userId: string, accountId: string, input: Parameters<Client['search']>[1], signal?: AbortSignal): ReturnType<Client['search']>;
  readThread(userId: string, accountId: string, threadId: string, signal?: AbortSignal): ReturnType<Client['readThread']>;
} {
  const client = deps.client ?? createGmailProviderClient();
  async function reconcile(userId: string, accountId: string, token: string, receipt: Receipt, signal: AbortSignal, pageToken?: string): Promise<DraftResult> {
    const { operationId } = receipt;
    if (receipt.state === 'succeeded' || receipt.state === 'failed') return receiptResult(receipt, operationId);
    const page = await client.findReplyDrafts(token, { messageId: receipt.stableKey, pageToken }, signal);
    const match = page.drafts.length === 1 ? page.drafts[0] : undefined;
    if (!match) return { status: 'unknown', operationId, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
    const saved = await finishGoogleOperation(deps.db, userId, accountId, operationId, receipt.state, 'succeeded', match.id)
      ?? await getGoogleOperation(deps.db, userId, accountId, operationId);
    return receiptResult(saved, operationId);
  }
  return {
    async search(userId, accountId, input, signal) {
      const boundedSignal = deadline(signal);
      const token = await resolveGoogleCredential(deps.db, deps.resolveCredential, userId, accountId, 'gmail.read', boundedSignal);
      return client.search(token, input, boundedSignal);
    },
    async readThread(userId, accountId, threadId, signal) {
      const boundedSignal = deadline(signal);
      const token = await resolveGoogleCredential(deps.db, deps.resolveCredential, userId, accountId, 'gmail.read', boundedSignal);
      return client.readThread(token, threadId, boundedSignal);
    },
    async reconcileReplyDraft(userId, accountId, input, signal) {
      const parsed = ReconcileInput.safeParse(input);
      if (!parsed.success) throw new Error('gmail_invalid_input');
      const boundedSignal = deadline(signal);
      const token = await resolveGoogleCredential(deps.db, deps.resolveCredential, userId, accountId, 'gmail.draft', boundedSignal);
      const receipt = await getGoogleOperation(deps.db, userId, accountId, parsed.data.operationId);
      if (!receipt || receipt.kind !== 'gmail_draft') throw new Error('gmail_operation_not_found');
      return reconcile(userId, accountId, token, receipt, boundedSignal, parsed.data.pageToken);
    },
    async createReplyDraft(userId, accountId, input, signal) {
      const parsed = DraftInput.safeParse(input);
      if (!parsed.success) throw new Error('gmail_invalid_input');
      const value = parsed.data;
      const boundedSignal = deadline(signal);
      const token = await resolveGoogleCredential(deps.db, deps.resolveCredential, userId, accountId, 'gmail.draft', boundedSignal);
      const claim = await claimDraft(deps.db, userId, accountId, value);
      if (!claim.execute) return reconcile(userId, accountId, token, claim.receipt, boundedSignal);
      const { operationId, stableKey } = claim.receipt;
      try {
        const draft = await client.createReplyDraft(token, { sourceMessageId: value.sourceMessageId, body: value.body, messageId: stableKey }, boundedSignal);
        const saved = await finishGoogleOperation(deps.db, userId, accountId, operationId, 'pending', 'succeeded', draft.id);
        return saved ? { status: 'succeeded', operationId, draftId: draft.id }
          : { status: 'unknown', operationId };
      } catch (error) {
        const notSubmitted = error instanceof GmailProviderError && error.submissionStarted === false;
        const state = notSubmitted ? 'failed' : 'unknown';
        await finishGoogleOperation(deps.db, userId, accountId, operationId, 'pending', state);
        return { status: state, operationId, ...(notSubmitted ? { reason: error.code } : {}) };
      }
    },
  };
}
