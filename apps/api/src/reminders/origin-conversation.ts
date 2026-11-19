/**
 * Which conversation background work belongs to, for telemetry only (#880): a reminder, timer or alarm
 * remembers the conversation it was created in (bob.reminders.origin_conversation_id), and when it fires
 * its spans and journal lines name that conversation (source `explicit`). A row without one (created
 * outside a conversation, or before the column) falls back to its owner's active conversation, read for
 * a whole fan-out in ONE query (source `active`), else `none`, so no span looks one up per job.
 */
import { currentCorrelation, type TraceAttrs } from '@bob/ai';
import { readActiveConversationIds } from '../conversations/active.ts';
import type { Db } from '../platform/db/db.ts';

const CANONICAL = /^conv_[0-9a-f]{32}$/;
/** The sources that name the conversation the work happens in; `active` is only the pointer's guess. */
const ORIGIN_SOURCES: ReadonlySet<string> = new Set(['explicit', 'client', 'device']);

/** The conversation a row is being created in, from the correlation context; null outside one. */
export function originConversationId(): string | null {
  const { conversation_id, conversation_source } = currentCorrelation();
  return ORIGIN_SOURCES.has(conversation_source) && CANONICAL.test(conversation_id) ? conversation_id : null;
}

export type BackgroundJob = { userId: string; conversationId?: string | null };

/**
 * The correlation for each due job, with the active fallbacks resolved together. A failed read leaves the
 * fallback jobs to the span layer's own lookup, as before this existed. Pass the RAW Db. Never throws.
 */
export async function jobCorrelations(db: Db, jobs: readonly BackgroundJob[]): Promise<(job: BackgroundJob) => TraceAttrs> {
  const fallback = jobs.filter((job) => !job.conversationId).map((job) => job.userId);
  const active = fallback.length === 0 ? new Map<string, string>()
    : await readActiveConversationIds(db, fallback).catch(() => undefined);
  return ({ userId, conversationId }) => {
    if (conversationId) return { userId, conversationId, conversationSource: 'explicit' };
    if (active === undefined) return { userId };
    const current = active.get(userId);
    return current === undefined ? { userId, conversationSource: 'none' } : { userId, conversationId: current, conversationSource: 'active' };
  };
}
