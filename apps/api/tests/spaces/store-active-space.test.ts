// store/active-space.ts tests (issue #301, U1). Same PG test support as
// store-spaces.test.ts: a per-file database connected as bob_server, with
// withUserRaw for the raw account-scoped RLS checks.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreNotFoundError, withUser, type Db } from '../../src/platform/db/db.ts';
import { addMember, archiveSpace, createSpace, revokeMember } from '../../src/spaces/store.ts';
import {
  clearActiveSpaceIf, clearDeviceSpacePointers, getActiveSpace, setActiveSpace, type ActiveSpaceSurface,
} from '../../src/spaces/active.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb, withUserRaw } from '../support/test-db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';

let pg: TestDb;
let db: Db;

function select(userId: string, spaceId: string | null, surface: ActiveSpaceSurface = 'web', deviceId?: string) {
  return withUser(db, userId, (tx) => setActiveSpace(tx, userId, spaceId, surface, deviceId));
}

async function refusal(userId: string, spaceId: string): Promise<unknown> {
  return select(userId, spaceId).catch((error: unknown) => error);
}

/** A device row, created through the admin seam (#900): pairing is the only
 *  sanctioned insert path and isn't exercised by this suite. */
async function newDevice(userId: string, name: string): Promise<string> {
  const admin = await withAdmin(await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName), (s) =>
    s.unsafe<{ id: string }[]>(
      `insert into bob.devices (user_id, name, model, fw_version) values ($1::uuid, $2, 'cardputer', '1.0.0') returning id`,
      [userId, name],
    ));
  const row = admin[0];
  if (row === undefined) throw new Error('no device');
  return row.id;
}

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

describe('active-space store', () => {
  it('sets and reads a member space, and clears it with null', async () => {
    const a = await addAccount(pg);
    expect(await getActiveSpace(db, a.userId)).toBeNull();
    const group = await createSpace(db, a.userId, { kind: 'group', name: 'Kitchen' });
    const set = await select(a.userId, group.id, 'device');
    expect(set.name).toBe('Kitchen');
    expect(await getActiveSpace(db, a.userId)).toEqual({
      spaceId: group.id, name: 'Kitchen', changedAt: set.changedAt, cleared: false,
    });
    const nulled = await select(a.userId, null);
    expect(nulled).toEqual({ changedAt: nulled.changedAt, name: null });
    expect(await getActiveSpace(db, a.userId)).toMatchObject({ spaceId: null, name: null, cleared: false });
  });

  it('non-member, unknown, malformed and archived ids are the same StoreNotFoundError', async () => {
    const owner = await addAccount(pg);
    const outsider = await addAccount(pg);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Hidden' });
    const archived = await createSpace(db, outsider.userId, { kind: 'group', name: 'Old' });
    await archiveSpace(db, outsider.userId, archived.id);
    const errors = [
      await refusal(outsider.userId, group.id),
      await refusal(outsider.userId, randomUUID()),
      await refusal(outsider.userId, 'not-a-uuid'),
      await refusal(outsider.userId, archived.id),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(StoreNotFoundError);
      expect((error as Error).message).toBe('space not found');
    }
    expect(await getActiveSpace(db, outsider.userId)).toBeNull();
  });

  it('a revoked membership clears the pointer on the next read', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: 'Shared' });
    await addMember(db, a.userId, group.id, b.userId, 'member');
    const set = await select(b.userId, group.id, 'device');
    await revokeMember(db, a.userId, group.id, b.userId);
    const read = await getActiveSpace(db, b.userId);
    expect(read).toMatchObject({ spaceId: null, name: null, cleared: true });
    expect(read!.changedAt).toBeGreaterThan(set.changedAt);
    expect(await getActiveSpace(db, b.userId)).toMatchObject({ spaceId: null, cleared: false });
  });

  it('an archived space clears the pointer on the next read', async () => {
    const a = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: 'Shelved' });
    await select(a.userId, group.id);
    await archiveSpace(db, a.userId, group.id);
    expect(await getActiveSpace(db, a.userId)).toMatchObject({ spaceId: null, cleared: true });
    expect(await getActiveSpace(db, a.userId)).toMatchObject({ spaceId: null, cleared: false });
  });

  it('clearActiveSpaceIf clears only a matching id', async () => {
    const a = await addAccount(pg);
    const one = await createSpace(db, a.userId, { kind: 'group', name: 'One' });
    const two = await createSpace(db, a.userId, { kind: 'group', name: 'Two' });
    const set = await select(a.userId, one.id);
    expect(await clearActiveSpaceIf(db, a.userId, two.id)).toBeNull();
    expect(await getActiveSpace(db, a.userId)).toMatchObject({ spaceId: one.id });
    const cleared = await clearActiveSpaceIf(db, a.userId, one.id);
    expect(cleared).toBeGreaterThan(set.changedAt);
    expect(await getActiveSpace(db, a.userId)).toMatchObject({ spaceId: null, changedAt: cleared });
    expect(await clearActiveSpaceIf(db, a.userId, one.id)).toBeNull();
  });

  it('RLS: another account cannot read the row, and an insert naming a non-member space is refused', async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: 'Private-ish' });
    await select(a.userId, group.id);
    const seen = await withUserRaw(pg, b.userId, (tx) =>
      tx.query('select * from bob.user_state where user_id = $1', [a.userId]));
    expect(seen.rows).toHaveLength(0);
    await expect(withUserRaw(pg, b.userId, (tx) =>
      tx.query(`insert into bob.user_state (user_id, active_space_id, space_surface) values ($1, $2, 'web')`,
        [b.userId, group.id]))).rejects.toThrow(/row-level security/);
  });

  it('changedAt strictly increases across writes', async () => {
    const a = await addAccount(pg);
    const group = await createSpace(db, a.userId, { kind: 'group', name: 'Clock' });
    const stamps: number[] = [];
    for (let i = 0; i < 5; i += 1) stamps.push((await select(a.userId, i % 2 === 0 ? group.id : null)).changedAt);
    for (let i = 1; i < stamps.length; i += 1) expect(stamps[i]).toBeGreaterThan(stamps[i - 1]!);
  });

  it("a device write moves its own pointer and the account pointer, without moving another device's (#900)", async () => {
    const a = await addAccount(pg);
    const deviceA = await newDevice(a.userId, 'A');
    const deviceB = await newDevice(a.userId, 'B');
    const one = await createSpace(db, a.userId, { kind: 'group', name: 'One' });
    const two = await createSpace(db, a.userId, { kind: 'group', name: 'Two' });

    expect(await getActiveSpace(db, a.userId, deviceA)).toBeNull();
    await select(a.userId, two.id, 'device', deviceB);
    // deviceA has no pointer of its own: it follows deviceB's write through the account pointer.
    expect(await getActiveSpace(db, a.userId, deviceA)).toMatchObject({ spaceId: two.id, name: 'Two' });

    const set = await select(a.userId, one.id, 'device', deviceA);
    expect(set.name).toBe('One');
    expect(await getActiveSpace(db, a.userId, deviceA)).toEqual({
      spaceId: one.id, name: 'One', changedAt: set.changedAt, cleared: false,
    });
    expect(await getActiveSpace(db, a.userId, deviceB)).toMatchObject({ spaceId: two.id, name: 'Two' });
    expect(await getActiveSpace(db, a.userId)).toEqual({
      spaceId: one.id, name: 'One', changedAt: set.changedAt, cleared: false,
    });
  });

  it('a device with no pointer of its own falls back to the account pointer (#900)', async () => {
    const a = await addAccount(pg);
    const deviceA = await newDevice(a.userId, 'A');
    const group = await createSpace(db, a.userId, { kind: 'group', name: 'Shared' });
    const set = await select(a.userId, group.id, 'web');
    expect(await getActiveSpace(db, a.userId, deviceA)).toEqual({
      spaceId: group.id, name: 'Shared', changedAt: set.changedAt, cleared: false,
    });
  });

  it('clearDeviceSpacePointers nulls every device, so both fall back to the account pointer (#900)', async () => {
    const a = await addAccount(pg);
    const deviceA = await newDevice(a.userId, 'A');
    const deviceB = await newDevice(a.userId, 'B');
    const one = await createSpace(db, a.userId, { kind: 'group', name: 'One' });
    const two = await createSpace(db, a.userId, { kind: 'group', name: 'Two' });
    await select(a.userId, one.id, 'device', deviceA);
    const last = await select(a.userId, two.id, 'device', deviceB);

    await clearDeviceSpacePointers(db, a.userId);

    expect(await getActiveSpace(db, a.userId, deviceA)).toEqual({
      spaceId: two.id, name: 'Two', changedAt: last.changedAt, cleared: false,
    });
    expect(await getActiveSpace(db, a.userId, deviceB)).toEqual({
      spaceId: two.id, name: 'Two', changedAt: last.changedAt, cleared: false,
    });
  });

  it('a non-member space is refused even for a device write (#900)', async () => {
    const owner = await addAccount(pg);
    const outsider = await addAccount(pg);
    const deviceId = await newDevice(outsider.userId, 'Outsider device');
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Hidden' });

    const error = await select(outsider.userId, group.id, 'device', deviceId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreNotFoundError);
    expect((error as Error).message).toBe('space not found');
    expect(await getActiveSpace(db, outsider.userId, deviceId)).toBeNull();
  });

  it("a second account's device stays untouched by clearDeviceSpacePointers, a write naming its device id, and an account-level write (#900 c1/c2)", async () => {
    const a = await addAccount(pg);
    const b = await addAccount(pg);
    const deviceB = await newDevice(b.userId, 'B');
    const bees = await createSpace(db, b.userId, { kind: 'group', name: 'Bees' });
    const set = await select(b.userId, bees.id, 'device', deviceB);

    // a writes naming b's own device id: the write is scoped to a's rows, so it matches nothing of b's.
    const other = await createSpace(db, a.userId, { kind: 'group', name: 'Other' });
    await select(a.userId, other.id, 'device', deviceB);
    expect(await getActiveSpace(db, b.userId, deviceB)).toEqual({
      spaceId: bees.id, name: 'Bees', changedAt: set.changedAt, cleared: false,
    });

    // a clearing its own devices never reaches b's.
    await clearDeviceSpacePointers(db, a.userId);
    expect(await getActiveSpace(db, b.userId, deviceB)).toEqual({
      spaceId: bees.id, name: 'Bees', changedAt: set.changedAt, cleared: false,
    });

    // a's own account-level write (no deviceId, #900 c2) clears only a's devices, never b's.
    await select(a.userId, other.id, 'web');
    expect(await getActiveSpace(db, b.userId, deviceB)).toEqual({
      spaceId: bees.id, name: 'Bees', changedAt: set.changedAt, cleared: false,
    });
  });

  it('clearActiveSpaceIf also nulls a device whose own pointer names that space (#900 c1)', async () => {
    const a = await addAccount(pg);
    const deviceA = await newDevice(a.userId, 'A');
    const group = await createSpace(db, a.userId, { kind: 'group', name: 'Leaving' });
    const set = await select(a.userId, group.id, 'device', deviceA);

    const cleared = await clearActiveSpaceIf(db, a.userId, group.id);
    expect(cleared).toBeGreaterThan(set.changedAt);
    expect(await getActiveSpace(db, a.userId, deviceA)).toMatchObject({ spaceId: null, cleared: false });
    expect(await getActiveSpace(db, a.userId)).toMatchObject({ spaceId: null, changedAt: cleared, cleared: false });
  });

  it('an account-level write makes a device that chose its own space follow again (#900 c2)', async () => {
    const a = await addAccount(pg);
    const deviceA = await newDevice(a.userId, 'A');
    const one = await createSpace(db, a.userId, { kind: 'group', name: 'One' });
    const two = await createSpace(db, a.userId, { kind: 'group', name: 'Two' });

    await select(a.userId, one.id, 'device', deviceA);
    expect(await getActiveSpace(db, a.userId, deviceA)).toMatchObject({ spaceId: one.id, name: 'One' });

    const set = await select(a.userId, two.id, 'web');
    expect(await getActiveSpace(db, a.userId, deviceA)).toEqual({
      spaceId: two.id, name: 'Two', changedAt: set.changedAt, cleared: false,
    });
    expect(await getActiveSpace(db, a.userId)).toEqual({
      spaceId: two.id, name: 'Two', changedAt: set.changedAt, cleared: false,
    });
  });
});
