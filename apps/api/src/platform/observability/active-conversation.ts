/**
 * The user's active conversation as telemetry labels see it: one cheap pointer read behind a short per-user
 * cache. Kept free of `@bob/ai` so the store that writes the pointer can prime the cache without loading
 * the telemetry layer (and its import-time configuration). conversation-correlation.ts wires it in.
 */
import { createMemoCache } from '../cache/memo-cache.ts';
import { canonicalId } from '../ids.ts';

type ActiveConversationReader = (userId: string) => Promise<string | null>;
let reader: ActiveConversationReader | undefined;
const active = createMemoCache<string | undefined>({ max: 1000, ttlMs: 5000 });

/** Installs the one read of a user's active-conversation pointer (server wiring) and clears the cache. */
export function installActiveConversationReader(next: ActiveConversationReader | undefined): void {
  reader = next;
  active.clear();
}

/** The user's active conversation, canonical, from a short per-user cache so no line or span costs a query. */
export async function activeConversationOf(userId: string): Promise<string | undefined> {
  const read = reader;
  if (read === undefined) return undefined;
  const { value } = await active.getOrCreate(userId, () => read(userId).then((ref) => (ref === null ? undefined : canonicalId('conversation', ref) ?? undefined), () => undefined));
  return value;
}

/** A pointer read or write that just happened: later telemetry sees it without a query. `ref` is the device ref, null when cleared. */
export function primeActiveConversation(userId: string, ref: string | null): void {
  active.set(userId, ref === null ? undefined : canonicalId('conversation', ref) ?? undefined);
}
