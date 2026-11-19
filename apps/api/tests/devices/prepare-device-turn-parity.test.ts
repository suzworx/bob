// Parity for bob.prepare_device_turn (20261028060000, #1360). The function
// replaced ~20 sequential statements in preparePrivateDeviceTurn. Each scenario
// builds the same fixture on two fresh accounts, runs the turn through the OLD
// TS store path (legacyPrepare below: the pre-#1360 body, verbatim, over the
// store functions that still exist) on one and through the function (the
// current preparePrivateDeviceTurn) on the other, then compares every row the
// account owns in spaces, space_memberships, conversations, messages,
// message_versions, user_state and devices. Generated ids are mapped to labels
// and timestamps to "set"/null; everything else must match exactly.
// Runs on the local Supabase stack through the test-db harness, never a hosted DB.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getConversationScope, type ConversationScope } from '../../src/conversations/scope.ts';
import { appendMessage, createConversation, deriveTitle, setConversationFlag } from '../../src/conversations/store.ts';
import { setActive, UUID_RE } from '../../src/conversations/active.ts';
import { createThread } from '../../src/conversations/thread-store.ts';
import { archiveSpace, createSpace } from '../../src/spaces/store.ts';
import { setActiveSpace } from '../../src/spaces/active.ts';
import { preparePrivateDeviceTurn, type PreparedDeviceTurn } from '../../src/voice/cardputer-conversation.ts';
import { StoreNotFoundError, withUser, type Db } from '../../src/platform/db/db.ts';
import { newId } from '../../src/platform/ids.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { asDb, addAccount, closeTestDb, createTestDb, withUserRaw, type TestDb } from '../support/test-db.ts';

interface PrepareInput {
  pinnedRef: string | undefined;
  transcriptText: string;
  deviceId: string | null;
  userMessageId: string;
  replyMessageId: string;
}

// ---- The old path: preparePrivateDeviceTurn before #1360 (c3bf484d^), verbatim. ----

function privateScope(scope: ConversationScope | null): scope is ConversationScope {
  return scope !== null && scope.spaceKind === 'private' && !scope.spaceArchived && scope.archivedAt === null;
}

async function existingAnchor(tx: Db, userId: string, messageId: string): Promise<ConversationScope | null> {
  const rows = await tx.query<{ conversation_id: string; role: string; origin: string }>(
    'select conversation_id, role, origin from bob.messages where id = $1', [messageId]);
  const row = rows[0];
  if (!row) return null;
  const scope = await getConversationScope(tx, userId, row.conversation_id);
  if (row.role !== 'user' || row.origin !== 'device' || !privateScope(scope)) throw new StoreNotFoundError('device_turn_anchor_invalid');
  return scope;
}

async function stampDevice(tx: Db, messageId: string, deviceId: string | null): Promise<void> {
  if (deviceId === null) return;
  await tx.query(
    `UPDATE bob.messages SET device_id = (SELECT d.id FROM bob.devices d WHERE d.id::text = $1) WHERE id = $2`,
    [deviceId, messageId],
  );
}

async function legacyPrepare(db: Db, userId: string, input: PrepareInput): Promise<PreparedDeviceTurn | null> {
  return withUser(db, userId, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`device-turn:${input.userMessageId}`]);
    const existing = await existingAnchor(tx, userId, input.userMessageId);
    if (existing) return { conversationId: existing.conversationId, userMessageId: input.userMessageId, replyMessageId: input.replyMessageId, scope: existing, created: false, changedAt: 0 };
    let scope = input.pinnedRef === undefined ? null : await getConversationScope(tx, userId, input.pinnedRef);
    if (input.pinnedRef !== undefined && !privateScope(scope)) return null;
    const created = scope === null;
    if (scope === null) {
      const record = await createConversation(tx, userId, deriveTitle(input.transcriptText));
      scope = await getConversationScope(tx, userId, record.id);
    }
    if (!privateScope(scope)) throw new StoreNotFoundError('device_turn_scope_invalid');
    await appendMessage(tx, userId, scope.conversationId, { id: input.userMessageId, role: 'user', origin: 'device', parts: [{ type: 'text', text: input.transcriptText }] });
    await tx.query('update bob.messages set device_turn_pending = true where id = $1', [input.userMessageId]);
    await stampDevice(tx, input.userMessageId, input.deviceId);
    const pointerOptions = input.deviceId !== null && UUID_RE.test(input.deviceId) ? { deviceId: input.deviceId } : {};
    const changedAt = await setActive(tx, userId, scope.conversationId, 'device', pointerOptions);
    return { conversationId: scope.conversationId, userMessageId: input.userMessageId, replyMessageId: input.replyMessageId, scope, created, changedAt };
  });
}

// ---- Harness ----

let pg: TestDb;
let db: Db;
let adminUrl: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  adminUrl = await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

const admin = async <T,>(sql: string, params: unknown[] = []): Promise<T[]> =>
  withAdmin(adminUrl, async (s) => [...(await s.unsafe<T[]>(sql, params as never[]))]);

const newDevice = async (userId: string, name: string): Promise<string> => {
  const [row] = await admin<{ id: string }>(
    `insert into bob.devices (user_id, name, model, fw_version) values ($1::uuid, $2, 'cardputer', '1.0.0') returning id`,
    [userId, name]);
  if (row === undefined) throw new Error('no device');
  return row.id;
};

type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;

/** Every row the account owns, read as the stack's admin (no RLS). */
async function snapshot(userId: string): Promise<Snapshot> {
  return {
    spaces: await admin(`select s.* from bob.spaces s where s.owner_user_id = $1::uuid
      or s.id in (select space_id from bob.space_memberships where user_id = $1::uuid) order by s.kind, s.name`, [userId]),
    space_memberships: await admin(`select m.* from bob.space_memberships m join bob.spaces s on s.id = m.space_id
      where m.user_id = $1::uuid order by s.kind, s.name`, [userId]),
    conversations: await admin(`select * from bob.conversations where user_id = $1::uuid order by title, created_at`, [userId]),
    messages: await admin(`select m.* from bob.messages m join bob.conversations c on c.id = m.conversation_id
      where m.user_id = $1::uuid order by c.title, m.position`, [userId]),
    message_versions: await admin(`select v.* from bob.message_versions v join bob.messages m on m.id = v.message_id
      join bob.conversations c on c.id = m.conversation_id where v.user_id = $1::uuid
      order by c.title, m.position, v.version_index`, [userId]),
    user_state: await admin(`select * from bob.user_state where user_id = $1::uuid`, [userId]),
    devices: await admin(`select * from bob.devices where user_id = $1::uuid order by name`, [userId]),
  };
}

/** Generated row ids that are not compared (their formats legitimately differ). */
const DROPPED: Record<string, string[]> = { message_versions: ['id'], space_memberships: ['id'] };

/** Ids to labels (known fixture ids, then any space or conversation the turn
 *  created, by kind/name and title), timestamps to 'set'. */
function normalize(snap: Snapshot, known: Record<string, string>): Snapshot {
  const labels = new Map<string, string>(Object.entries(known).map(([label, id]) => [id, label]));
  for (const space of snap.spaces ?? []) {
    const id = String(space.id);
    if (!labels.has(id)) labels.set(id, `space:${String(space.kind)}:${String(space.name)}`);
  }
  for (const conversation of snap.conversations ?? []) {
    const id = String(conversation.id);
    if (!labels.has(id)) labels.set(id, `conversation:${String(conversation.title)}`);
  }
  for (const message of snap.messages ?? []) {
    const id = String(message.id);
    if (!labels.has(id)) labels.set(id, `message:${labels.get(String(message.conversation_id))}:${String(message.position)}`);
  }
  const out: Snapshot = {};
  for (const [table, rows] of Object.entries(snap)) {
    out[table] = rows.map((row) => Object.fromEntries(Object.entries(row)
      .filter(([key]) => !(DROPPED[table] ?? []).includes(key))
      .map(([key, value]) => {
        if (value instanceof Date) return [key, 'set'];
        if (typeof value === 'string' && labels.has(value)) return [key, labels.get(value)];
        return [key, value];
      })));
  }
  return out;
}

type Outcome = { result: unknown } | { error: string };

function normalizeOutcome(outcome: Outcome, known: Record<string, string>, snap: Snapshot): Outcome {
  if ('error' in outcome) return outcome;
  const r = outcome.result as PreparedDeviceTurn | null;
  if (r === null) return { result: null };
  const labels = normalize({ ids: [{ c: r.conversationId, s: r.scope.spaceId, u: r.userMessageId, p: r.replyMessageId }], ...snap }, known).ids?.[0] ?? {};
  return { result: { conversationId: labels.c, userMessageId: labels.u, replyMessageId: labels.p, created: r.created,
    changedAtSet: r.changedAt > 0, scope: { ...r.scope, conversationId: labels.c, spaceId: labels.s } } };
}

type Prepare = (db: Db, userId: string, input: PrepareInput) => Promise<PreparedDeviceTurn | null>;

interface Arranged { userId: string; known: Record<string, string>; input: PrepareInput; repeat?: number }

async function run(prepare: Prepare, arranged: Arranged): Promise<{ outcomes: Outcome[]; rows: Snapshot }> {
  const outcomes: Outcome[] = [];
  for (let i = 0; i < (arranged.repeat ?? 1); i++) {
    try {
      outcomes.push({ result: await prepare(db, arranged.userId, arranged.input) });
    } catch (error) {
      outcomes.push({ error: `${(error as Error).name}: ${(error as Error).message}` });
    }
  }
  const raw = await snapshot(arranged.userId);
  return { outcomes: outcomes.map((o) => normalizeOutcome(o, arranged.known, raw)), rows: normalize(raw, arranged.known) };
}

/** Arranges the same fixture twice, runs old and new, and asserts parity. Returns the new side for extra checks. */
async function parity(arrange: () => Promise<Arranged>): Promise<{ outcomes: Outcome[]; rows: Snapshot }> {
  const legacy = await run(legacyPrepare, await arrange());
  const current = await run(preparePrivateDeviceTurn, await arrange());
  expect(current.outcomes).toEqual(legacy.outcomes);
  expect(current.rows).toEqual(legacy.rows);
  return current;
}

/** A fresh account with two devices: Kitchen (the speaker) and Bedroom, whose
 *  own pointer names Other and whose Space pointer names a group. */
async function account(): Promise<{ userId: string; known: Record<string, string> }> {
  const { userId } = await addAccount(pg, {});
  const kitchen = await newDevice(userId, 'Kitchen');
  const bedroom = await newDevice(userId, 'Bedroom');
  const other = await createConversation(db, userId, 'Other');
  const group = await createSpace(db, userId, { name: 'Family' });
  await withUser(db, userId, async (tx) => {
    await setActive(tx, userId, other.id, 'picker', { deviceId: bedroom, moveAccount: false });
    await setActiveSpace(tx, userId, group.id, 'device', bedroom, false);
  });
  return { userId, known: { user: userId, kitchen, bedroom, other: other.id, group: group.id } };
}

const turn = (over: Partial<PrepareInput>): PrepareInput => ({
  pinnedRef: undefined, transcriptText: 'what is the weather', deviceId: null,
  userMessageId: newId('message'), replyMessageId: newId('message'), ...over,
});

const withIds = (base: { userId: string; known: Record<string, string> }, input: PrepareInput, extra: Record<string, string> = {}, repeat?: number): Arranged =>
  ({ userId: base.userId, input, repeat, known: { ...base.known, ...extra, anchor: input.userMessageId, reply: input.replyMessageId } });

describe('bob.prepare_device_turn parity with the pre-#1360 store path', () => {
  it('new conversation (no pin) on a fresh account: provisions the private space, creates, appends, moves the device pointer', async () => {
    const current = await parity(async () => {
      const base = await account();
      return withIds(base, turn({ deviceId: base.known.kitchen }));
    });
    expect(current.outcomes[0]).toMatchObject({ result: { created: true, changedAtSet: true } });
    // Not vacuous: the rows hold the turn the parity compared.
    expect(current.rows.spaces?.map((s) => s.id)).toEqual(['group', 'space:private:Private']);
    expect(current.rows.messages).toEqual([expect.objectContaining({ id: 'anchor', role: 'user', origin: 'device',
      position: 0, sequence: '1', device_turn_pending: true, device_id: 'kitchen', space_id: 'space:private:Private' })]);
    expect(current.rows.message_versions).toEqual([expect.objectContaining({ message_id: 'anchor', version_index: 0,
      is_selected: true, parts: [{ type: 'text', text: 'what is the weather' }] })]);
    const created = current.rows.messages?.[0]?.conversation_id;
    expect(current.rows.user_state).toEqual([expect.objectContaining({ active_conversation_id: created, conversation_surface: 'device' })]);
    expect(current.rows.devices?.find((d) => d.name === 'Kitchen')).toMatchObject({ active_conversation_id: created, conversation_surface: 'device' });
  });

  it('new conversation (no pin) with the private space already provisioned', async () => {
    await parity(async () => {
      const base = await account();
      await createConversation(db, base.userId, 'Warm-up'); // provisions the space first
      return withIds(base, turn({ deviceId: base.known.kitchen }));
    });
  });

  it('pinned private conversation with history: appends at the next position', async () => {
    await parity(async () => {
      const base = await account();
      const pinned = await createConversation(db, base.userId, 'Pinned');
      await appendMessage(db, base.userId, pinned.id, { role: 'user', parts: [{ type: 'text', text: 'hi' }], origin: 'web_text' });
      await appendMessage(db, base.userId, pinned.id, { role: 'assistant', parts: [{ type: 'text', text: 'hello' }], origin: 'web_text' });
      return withIds(base, turn({ pinnedRef: pinned.id, deviceId: base.known.kitchen }), { pinned: pinned.id });
    });
  });

  it('pinned straggler conversation with no space: the append heals it into the private space', async () => {
    await parity(async () => {
      const base = await account();
      const pinned = await createConversation(db, base.userId, 'Straggler');
      await admin('update bob.conversations set space_id = null where id = $1', [pinned.id]);
      return withIds(base, turn({ pinnedRef: pinned.id, deviceId: base.known.kitchen }), { pinned: pinned.id });
    });
  });

  it('retry of the same anchor (existing): the second call changes nothing', async () => {
    const current = await parity(async () => {
      const base = await account();
      const pinned = await createConversation(db, base.userId, 'Pinned');
      return withIds(base, turn({ pinnedRef: pinned.id, deviceId: base.known.kitchen }), { pinned: pinned.id }, 2);
    });
    expect(current.outcomes[1]).toMatchObject({ result: { created: false, changedAtSet: false, conversationId: 'pinned' } });
  });

  it('retry of a first turn (no pin) finds the created conversation', async () => {
    await parity(async () => {
      const base = await account();
      return withIds(base, turn({ deviceId: base.known.kitchen }), {}, 2);
    });
  });

  it('anchor naming a non-device message (anchor_invalid): throws, writes nothing', async () => {
    const current = await parity(async () => {
      const base = await account();
      const pinned = await createConversation(db, base.userId, 'Pinned');
      const web = await appendMessage(db, base.userId, pinned.id, { role: 'user', parts: [{ type: 'text', text: 'typed' }], origin: 'web_text' });
      if (!web) throw new Error('no web message');
      return withIds(base, turn({ pinnedRef: pinned.id, deviceId: base.known.kitchen, userMessageId: web.id }), { pinned: pinned.id });
    });
    expect(current.outcomes[0]).toEqual({ error: 'StoreNotFoundError: device_turn_anchor_invalid' });
  });

  it('anchor naming a device assistant message (anchor_invalid)', async () => {
    await parity(async () => {
      const base = await account();
      const pinned = await createConversation(db, base.userId, 'Pinned');
      const reply = await appendMessage(db, base.userId, pinned.id, { role: 'assistant', parts: [{ type: 'text', text: 'said' }], origin: 'device' });
      if (!reply) throw new Error('no reply');
      return withIds(base, turn({ pinnedRef: pinned.id, userMessageId: reply.id }), { pinned: pinned.id });
    });
  });

  it('anchor in an archived conversation (anchor_invalid)', async () => {
    await parity(async () => {
      const base = await account();
      const pinned = await createConversation(db, base.userId, 'Pinned');
      const input = turn({ pinnedRef: pinned.id });
      await preparePrivateDeviceTurn(db, base.userId, input);
      await setConversationFlag(db, base.userId, pinned.id, 'archived', true);
      return withIds(base, input, { pinned: pinned.id });
    });
  });

  const notPrivate: Array<[string, (base: { userId: string; known: Record<string, string> }) => Promise<string>]> = [
    ['a shared (group) conversation', async (base) => (await createThread(db, base.userId, { spaceId: base.known.group!, title: 'Group chat' })).id],
    ['an archived private conversation', async (base) => {
      const c = await createConversation(db, base.userId, 'Archived');
      await setConversationFlag(db, base.userId, c.id, 'archived', true);
      return c.id;
    }],
    ['a conversation in an archived group', async (base) => {
      const thread = await createThread(db, base.userId, { spaceId: base.known.group!, title: 'Old group chat' });
      await archiveSpace(db, base.userId, base.known.group!);
      return thread.id;
    }],
    ['an unknown conversation', async () => newId('conversation')],
    ['another account\'s conversation', async () => {
      const stranger = await addAccount(pg, {});
      return (await createConversation(db, stranger.userId, 'Foreign')).id;
    }],
  ];
  for (const [name, pin] of notPrivate) {
    it(`pinned ${name} (not_private): returns null, writes nothing`, async () => {
      const current = await parity(async () => {
        const base = await account();
        const pinned = await pin(base);
        return withIds(base, turn({ pinnedRef: pinned, deviceId: base.known.kitchen }), { pinned });
      });
      expect(current.outcomes[0]).toEqual({ result: null });
    });
  }

  it('device pointer: moves Kitchen\'s own pointer and the account\'s, leaves Bedroom\'s alone', async () => {
    const current = await parity(async () => {
      const base = await account();
      return withIds(base, turn({ deviceId: base.known.kitchen }));
    });
    const bedroom = current.rows.devices?.find((d) => d.name === 'Bedroom');
    expect(bedroom).toMatchObject({ active_conversation_id: 'other', active_space_id: 'group', space_surface: 'device' });
  });

  it('follow-me reset (no device id): every device pointer, conversation and Space, is cleared', async () => {
    const current = await parity(async () => {
      const base = await account();
      return withIds(base, turn({ deviceId: null }));
    });
    for (const device of current.rows.devices ?? []) {
      expect(device).toMatchObject({ active_conversation_id: null, conversation_surface: null, active_space_id: null, space_surface: null });
    }
  });

  it('a non-uuid device id: stamps no device and resets follow-me', async () => {
    await parity(async () => {
      const base = await account();
      return withIds(base, turn({ deviceId: 'legacy-device' }));
    });
  });

  it('another account\'s device id: stamps no device, moves no device pointer', async () => {
    await parity(async () => {
      const base = await account();
      const stranger = await addAccount(pg, {});
      const foreign = await newDevice(stranger.userId, 'Foreign');
      return withIds(base, turn({ deviceId: foreign }), { foreign });
    });
  });
});

describe('bob.prepare_device_turn caller check', () => {
  it('refuses with 42501 when auth.uid() is not p_user_id, writing nothing', async () => {
    const caller = await addAccount(pg, {});
    const victim = await addAccount(pg, {});
    const before = await snapshot(victim.userId);
    const error = await withUserRaw(pg, caller.userId, (tx) => tx.query(
      `select * from bob.prepare_device_turn($1, $2, null, 'x', '[]'::jsonb, null, null, $3)`,
      [victim.userId, newId('message'), Date.now()],
    )).then(() => null, (e: unknown) => e as { code?: string });
    expect(error?.code).toBe('42501');
    expect(await snapshot(victim.userId)).toEqual(before);
  });
});
