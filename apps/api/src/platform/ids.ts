/**
 * Type-prefixed ids (IDS epic, owner 2026-10-06): every Bob-owned record's id
 * is `<prefix>_<32 lowercase hex of a v4 uuid>`, e.g. spc_1c3434d3d78b4dbfb83b9d6c1667d84b.
 * Users stay plain uuids (Supabase owns auth.users). One `conv_` covers every
 * conversation, space threads included.
 *
 * canonicalId maps every legacy form deterministically, and the SQL backfill
 * helper bob_private.legacy_id applies the same mapping:
 *  - the prefixed form, a bare uuid (dashed or not), and a dashed uuid behind its
 *    own prefix (`msg_`/`mem_`/`act_`/`ver_`/`conv_` defaults) or behind the
 *    conversation's legacy `cnv_`/`thr_` -> prefix + the uuid's hex;
 *  - any other id of the OpaqueId shape (never a uuid, e.g. an AI SDK nanoid)
 *    -> prefix + md5 of the whole old id;
 *  - anything else -> null.
 * canonicalId (not legacy_id) also refuses another kind's canonical id, so a
 * space id never parses as a conversation id.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const ID_PREFIX = {
  conversation: 'conv',
  message: 'msg',
  message_version: 'ver',
  memory: 'mem',
  action_item: 'act',
  space: 'spc',
  space_membership: 'mbr',
  space_invitation: 'inv',
  device: 'dev',
  pairing_request: 'prq',
  ai_invocation: 'aiv',
  game_session: 'game',
  google_account: 'gacc',
  task: 'task',
  task_subscriber: 'tsub',
  note: 'note',
  note_revision: 'nrev',
  calendar: 'cal',
  calendar_event: 'evt',
  event_attendee: 'att',
  event_exception: 'exc',
  reminder: 'rem',
  reminder_recipient: 'rrcp',
  reminder_occurrence: 'rocc',
  notification: 'ntf',
  notification_preference: 'npref',
  outbox: 'obx',
  publication: 'pub',
  waitlist: 'wl',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

const LEGACY_PREFIXES: Partial<Record<IdKind, readonly string[]>> = { conversation: ['cnv', 'thr'] };
const OPAQUE = /^[A-Za-z0-9_-]{8,64}$/;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const PREFIXES: ReadonlySet<string> = new Set(Object.values(ID_PREFIX));

/** A fresh id for a new record of this kind. */
export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${randomUUID().replaceAll('-', '')}`;
}

/** The canonical id for any accepted form of a kind's id, or null when it is not one. */
export function canonicalId(kind: IdKind, input: string): string | null {
  if (!OPAQUE.test(input)) return null;
  const prefix = ID_PREFIX[kind];
  const strip = [prefix, ...(LEGACY_PREFIXES[kind] ?? [])].find((p) => input.startsWith(`${p}_`));
  const rest = strip === undefined ? input : input.slice(strip.length + 1);
  if (UUID.test(rest)) return `${prefix}_${rest.replaceAll('-', '').toLowerCase()}`;
  const other = /^([a-z]+)_[0-9a-f]{32}$/.exec(input)?.[1];
  if (strip === undefined && other !== undefined && PREFIXES.has(other)) return null;
  return `${prefix}_${createHash('md5').update(input).digest('hex')}`;
}

/** The dashed uuid behind a kind's id (for rollback and uuid-keyed compat), or null. */
export function uuidOf(kind: IdKind, id: string): string | null {
  const hex = canonicalId(kind, id)?.slice(ID_PREFIX[kind].length + 1);
  if (hex === undefined) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A tolerant id input: accepts every legacy form of a kind's id and outputs the canonical one. */
export function EntityId(kind: IdKind): z.ZodType<string, string> {
  return z.string().transform((value, ctx) => {
    const id = canonicalId(kind, value);
    if (id !== null) return id;
    ctx.addIssue({ code: 'custom', message: `not a ${kind} id` });
    return z.NEVER;
  });
}
