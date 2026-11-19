/**
 * The id the Cardputer sees for its active conversation: a General
 * conversation keeps its own id; a space thread is `thr_<uuid>` (40 chars),
 * which fits the wire's OpaqueIdSchema and the firmware's id buffer.
 */

export const THREAD_REF_PREFIX = 'thr_';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DeviceRef =
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'thread'; threadId: string };

/** The device ref for a thread id (lower-cased uuid). */
export function threadRef(threadId: string): string {
  return `${THREAD_REF_PREFIX}${threadId.toLowerCase()}`;
}

/** Null for an empty ref or a `thr_` ref without a uuid. */
export function parseDeviceRef(ref: string): DeviceRef | null {
  if (ref.length === 0) return null;
  if (!ref.startsWith(THREAD_REF_PREFIX)) return { kind: 'conversation', conversationId: ref };
  const threadId = ref.slice(THREAD_REF_PREFIX.length);
  return UUID_RE.test(threadId) ? { kind: 'thread', threadId: threadId.toLowerCase() } : null;
}
