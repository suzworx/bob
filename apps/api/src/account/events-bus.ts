import { z } from 'zod';
import { trace } from '@opentelemetry/api';
import { recordWorkflowMetrics } from '../platform/observability/workflow-diagnostics.ts';

// Per-account in-process event bus (research R7, contracts/account-events.md).
// One server instance, so an in-process bus suffices; the upgrade path is
// Postgres LISTEN/NOTIFY or Supabase Realtime behind the same interface.

const OpaqueId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/); // mirrors schemas.ts

/** Action that changed the active-conversation pointer (5 values). */
const SurfaceSchema = z.enum(['web_text', 'web_voice', 'device', 'picker', 'activate']);

/**
 * Payload ids and metadata only -- never message text, transcripts, or titles
 * beyond the minimal `active.changed` title. The client refetches full content
 * on receipt (R7, plan §E). Lives here (not web-schemas.ts, owned by T028)
 * until T028 folds it into web-schemas.ts.
 */
export const AccountEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message.appended'),
    conversation_id: OpaqueId,
    message_id: OpaqueId,
    updated_at: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal('conversation.updated'),
    conversation_id: OpaqueId,
    updated_at: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal('conversation.deleted'),
    conversation_id: OpaqueId,
    updated_at: z.number().int().positive(),
  }).strict(),
  // #900: device_id absent means account-wide (today's meaning, every device
  // follows); set, it names the one device whose own pointer this is.
  z.object({
    type: z.literal('active.changed'),
    conversation_id: OpaqueId.nullable(),
    title: z.string().min(1).max(200).nullable(),
    surface: SurfaceSchema,
    changed_at: z.number().int().positive(),
    device_id: z.string().uuid().optional(),
  }).refine((event) => (event.conversation_id === null) === (event.title === null), {
    message: 'conversation_id and title must both be null or both be set',
  }).strict(),
  // #301: the account's active-Space pointer moved (or was cleared: both null).
  // #900: device_id absent means account-wide, as above.
  z.object({
    type: z.literal('active_space.changed'),
    space_id: z.string().uuid().nullable(),
    name: z.string().min(1).max(60).nullable(),
    surface: z.enum(['web', 'device']),
    changed_at: z.number().int().positive(),
    device_id: z.string().uuid().optional(),
  }).refine((event) => (event.space_id === null) === (event.name === null), {
    message: 'space_id and name must both be null or both be set',
  }).strict(),
  // Access can change without moving the active-Space pointer. Refetch by id.
  z.object({
    type: z.literal('space.access_changed'),
    space_id: z.string().uuid(),
  }).strict(),
  z.object({
    type: z.literal('device.changed'),
    device_id: z.string().uuid(),
  }).strict(),
  // #565: a message landed in a space thread outside the web's own post (a
  // Cardputer turn). Ids only; the client refetches the thread.
  z.object({
    type: z.literal('thread.message_appended'),
    thread_id: z.string().uuid(),
    space_id: z.string().uuid(),
    message_id: z.string().uuid(),
    sequence: z.number().int().positive(),
  }).strict(),
]);

export type AccountEvent = z.infer<typeof AccountEventSchema>;
type AccountEventListener = (event: AccountEvent) => void;

export const ACCOUNT_EVENT_COVERAGE = {
  'message.appended': 'account-event', 'conversation.updated': 'account-event',
  'conversation.deleted': 'account-event', 'active.changed': 'account-event',
  'active_space.changed': 'account-event', 'device.changed': 'account-event',
  'thread.message_appended': 'account-event', 'space.access_changed': 'account-event',
} as const satisfies Record<AccountEvent['type'], 'account-event'>;

/**
 * In-process, per-account event bus. Delivery is best-effort at-most-once, in
 * publish order. A throwing listener never breaks other listeners or the
 * publisher. Streams are per-account isolated: publish under one account never
 * reaches another account's listeners.
 */
export class AccountEvents {
  private readonly listenersByAccount = new Map<string, Set<AccountEventListener>>();

  /** Validates the event against the schema, then delivers to the account's listeners. */
  publish(userId: string, event: AccountEvent): void {
    const parsed = AccountEventSchema.parse(event);
    // A span event on whatever span is publishing, never a span of its own: no payload, only the type.
    try { trace.getActiveSpan()?.addEvent(ACCOUNT_EVENT_COVERAGE[parsed.type], { 'bob.account_event': parsed.type }); } catch { /* best effort */ }
    const started = performance.now();
    let failed = false;
    // Snapshot: a listener unsubscribing during delivery must not skip the rest.
    for (const listener of [...(this.listenersByAccount.get(userId) ?? [])]) {
      try {
        listener(parsed);
      } catch {
        failed = true;
        // Swallow: one faulty listener must not break the others or the publisher.
      }
    }
    recordWorkflowMetrics(failed ? 'failed' : 'ok', performance.now() - started);
  }

  /** Registers a listener for one account; the returned function unsubscribes. */
  subscribe(userId: string, listener: AccountEventListener): () => void {
    let listeners = this.listenersByAccount.get(userId);
    if (listeners === undefined) {
      listeners = new Set();
      this.listenersByAccount.set(userId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listenersByAccount.delete(userId);
      }
    };
  }
}
