// Per-device active-conversation pointer resolution (#900 MD-U3): a device
// uses its OWN pointer when set, else the account pointer. Owner rule
// (correction c3): devices "follow-me" the account by default; a device can
// choose its own pointer, but any later plain account-level write (no
// deviceId) puts every device back to following, exactly as before #900.
// A device write (with deviceId) moves the account pointer too, and leaves
// other devices' own pointers alone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearActiveThread, clearActiveThreadInSpace, clearDevicePointers, getActive, setActive,
} from '../../src/conversations/active.ts';
import { createThread } from '../../src/conversations/thread-store.ts';
import { createConversation } from '../../src/conversations/store.ts';
import { threadRef } from '../../src/devices/conversation-ref.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';

describe('per-device active-conversation pointer (#900)', () => {
  let pg: TestDb;
  let db: Db;
  let account: TestAccount;

  const admin = async <T,>(sql: string, params: unknown[] = []): Promise<T[]> =>
    withAdmin(await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName), async (s) => [
      ...(await s.unsafe<T[]>(sql, params as never[])),
    ]);

  const newDevice = async (name: string, userId: string = account.userId): Promise<string> => {
    const [row] = await admin<{ id: string }>(
      `insert into bob.devices (user_id, name, model, fw_version) values ($1::uuid, $2, 'cardputer', '1.0.0') returning id`,
      [userId, name],
    );
    if (row === undefined) throw new Error('no device');
    return row.id;
  };

  const devicePointer = async (deviceId: string): Promise<{ conversation_id: string | null; surface: string | null }> => {
    const [row] = await admin<{ conversation_id: string | null; surface: string | null }>(
      `select active_conversation_id as conversation_id, conversation_surface as surface
         from bob.devices where id = $1`,
      [deviceId],
    );
    if (row === undefined) throw new Error('device not found');
    return row;
  };

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    account = await addAccount(pg);
  });

  afterAll(async () => {
    await closeTestDb(pg);
  });

  it("setActive on device A leaves device B's own pointer unchanged", async () => {
    const a = await newDevice('A');
    const b = await newDevice('B');
    const conversation = await createConversation(db, account.userId, 'A convo');
    await withUser(db, account.userId, (tx) =>
      setActive(tx, account.userId, conversation.id, 'device', { deviceId: a }));
    expect((await devicePointer(a)).conversation_id).toBe(conversation.id);
    expect(await devicePointer(b)).toEqual({ conversation_id: null, surface: null });
  });

  it('a device with no own pointer falls back to the account pointer', async () => {
    const noOwn = await newDevice('No own');
    const conversation = await createConversation(db, account.userId, 'Account convo');
    await withUser(db, account.userId, (tx) =>
      setActive(tx, account.userId, conversation.id, 'web_text'));
    const active = await getActive(db, account.userId, { deviceId: noOwn });
    expect(active?.conversationId).toBe(conversation.id);
  });

  it('a device write also moves the account pointer', async () => {
    const device = await newDevice('Moves account');
    const conversation = await createConversation(db, account.userId, 'Device convo');
    await withUser(db, account.userId, (tx) =>
      setActive(tx, account.userId, conversation.id, 'device', { deviceId: device }));
    const accountActive = await getActive(db, account.userId);
    expect(accountActive?.conversationId).toBe(conversation.id);
    expect(accountActive?.surface).toBe('device');
  });

  it('a plain account-level write (no deviceId) makes a device follow the account again', async () => {
    const device = await newDevice('Follow-me');
    const first = await createConversation(db, account.userId, 'First');
    const second = await createConversation(db, account.userId, 'Second');
    await withUser(db, account.userId, (tx) =>
      setActive(tx, account.userId, first.id, 'device', { deviceId: device }));
    expect((await getActive(db, account.userId, { deviceId: device }))?.conversationId).toBe(first.id);

    await withUser(db, account.userId, (tx) =>
      setActive(tx, account.userId, second.id, 'web_text'));
    expect(await devicePointer(device)).toEqual({ conversation_id: null, surface: null });
    expect((await getActive(db, account.userId, { deviceId: device }))?.conversationId).toBe(second.id);
    expect((await getActive(db, account.userId))?.conversationId).toBe(second.id);
  });

  it('clearDevicePointers nulls every device', async () => {
    const a = await newDevice('Clear A');
    const b = await newDevice('Clear B');
    const conversation = await createConversation(db, account.userId, 'Clear convo');
    await withUser(db, account.userId, (tx) =>
      setActive(tx, account.userId, conversation.id, 'device', { deviceId: a }));
    await withUser(db, account.userId, (tx) =>
      setActive(tx, account.userId, conversation.id, 'device', { deviceId: b }));
    await clearDevicePointers(db, account.userId);
    expect(await devicePointer(a)).toEqual({ conversation_id: null, surface: null });
    expect(await devicePointer(b)).toEqual({ conversation_id: null, surface: null });
  });

  it("a write or clear scoped to account A never touches another account's own device", async () => {
    const other = await addAccount(pg);
    const otherDevice = await newDevice('Other account device', other.userId);
    const conversation = await createConversation(db, other.userId, 'Other convo');
    await withUser(db, other.userId, (tx) =>
      setActive(tx, other.userId, conversation.id, 'device', { deviceId: otherDevice }));
    expect((await devicePointer(otherDevice)).conversation_id).toBe(conversation.id);

    // Account A names the other account's device id: must move nothing of theirs.
    await withUser(db, account.userId, (tx) =>
      setActive(tx, account.userId, null, 'picker', { deviceId: otherDevice }));
    expect((await devicePointer(otherDevice)).conversation_id).toBe(conversation.id);

    // Account A's own plain write (no deviceId, the new follow-me-all-devices
    // path) clears only A's devices, never the other account's.
    await withUser(db, account.userId, (tx) => setActive(tx, account.userId, null, 'web_text'));
    expect((await devicePointer(otherDevice)).conversation_id).toBe(conversation.id);

    // Account A's clearDevicePointers must leave the other account's device alone.
    await clearDevicePointers(db, account.userId);
    expect((await devicePointer(otherDevice)).conversation_id).toBe(conversation.id);
  });

  it('clearActiveThread also nulls a device pointer naming that thread', async () => {
    const space = await createSpace(db, account.userId, { kind: 'group', name: 'Clear thread space' });
    const thread = await createThread(db, account.userId, { spaceId: space.id, title: 'Thread' });
    const device = await newDevice('Thread device');
    await withUser(db, account.userId, (tx) =>
      setActive(tx, account.userId, threadRef(thread.id), 'device', { deviceId: device }));
    expect((await devicePointer(device)).conversation_id).toBe(thread.id);

    await clearActiveThread(db, account.userId, thread.id);
    expect((await devicePointer(device)).conversation_id).toBeNull();
  });

  it("a device switching space clears only its own thread pointer there; the user leaving clears every device", async () => {
    const space = await createSpace(db, account.userId, { kind: 'group', name: 'Switch space' });
    const threadA = await createThread(db, account.userId, { spaceId: space.id, title: 'A thread' });
    const threadB = await createThread(db, account.userId, { spaceId: space.id, title: 'B thread' });
    const deviceA = await newDevice('Switcher A');
    const deviceB = await newDevice('Switcher B');
    await withUser(db, account.userId, (tx) =>
      setActive(tx, account.userId, threadRef(threadA.id), 'device', { deviceId: deviceA }));
    await withUser(db, account.userId, (tx) =>
      setActive(tx, account.userId, threadRef(threadB.id), 'device', { deviceId: deviceB }));

    // Device A switches its own context away from the space: only A's pointer clears.
    await clearActiveThreadInSpace(db, account.userId, space.id, { deviceId: deviceA });
    expect((await devicePointer(deviceA)).conversation_id).toBeNull();
    expect((await devicePointer(deviceB)).conversation_id).toBe(threadB.id);

    // A re-points at its thread; the user leaving/archiving the whole space
    // clears every device's own pointer there.
    await withUser(db, account.userId, (tx) =>
      setActive(tx, account.userId, threadRef(threadA.id), 'device', { deviceId: deviceA }));
    await clearActiveThreadInSpace(db, account.userId, space.id);
    expect((await devicePointer(deviceA)).conversation_id).toBeNull();
    expect((await devicePointer(deviceB)).conversation_id).toBeNull();
  });

  it('with no deviceId, getActive/setActive still read and write the account pointer exactly as before #900', async () => {
    const conversation = await createConversation(db, account.userId, 'No device id');
    const stamp = await withUser(db, account.userId, (tx) =>
      setActive(tx, account.userId, conversation.id, 'picker'));
    expect(await getActive(db, account.userId)).toEqual({
      conversationId: conversation.id,
      kind: 'conversation',
      threadId: null,
      spaceId: null,
      title: 'No device id',
      surface: 'picker',
      changedAt: stamp,
      cleared: false,
    });
  });
});
