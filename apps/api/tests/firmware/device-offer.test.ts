/** What a device session asks of the firmware module: the offer at hello, the offer on request and the start event, on the real local Postgres. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';
import { currentOffer, offerOnHello, recordOtaStart } from '../../src/firmware/device-offer.ts';
import { getRelease, ingestRelease, recordOffer } from '../../src/firmware/store.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { makeImage, makeKey, makeManifest, signManifest } from './fixture.ts';

const key = makeKey('k1');
const keys: Record<string, string> = { k1: key.pem };

describe('firmware device offers', () => {
  let pg: TestDb;
  let db: Db;
  let userId = '';
  const admin = async <T,>(sql: string, params: unknown[] = []): Promise<T[]> =>
    withAdmin(await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName), async (s) => [
      ...(await s.unsafe<T[]>(sql, params as never[])),
    ]);
  const newDevice = async (): Promise<string> => {
    const [row] = await admin<{ id: string }>(
      `insert into bob.devices (user_id, name, model, fw_version) values ($1::uuid, 'seed', 'cardputer', '1.0.0') returning id`,
      [userId],
    );
    if (row === undefined) throw new Error('no device');
    return row.id;
  };
  const ingest = (version: string, fill: number, over: Record<string, unknown> = {}) => {
    const image = makeImage(fill);
    return ingestRelease(db, { ...signManifest(makeManifest(image, key, { version, ...over }), key), image }, keys);
  };
  const events = (id: string) =>
    admin<{ kind: string; to_version: string | null }>(
      `select kind, to_version from bob.firmware_events where device_id = $1::uuid order by id`, [id],
    );

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    userId = (await addAccount(pg)).userId;
    await ingest('1.2.0', 1);
    await ingest('2.0.0', 2, { min_from: '1.2.0' });
    await admin(`insert into bob.firmware_channels (channel, board, version) values ('stable', 'cardputer', '2.0.0')`);
  }, 120_000);

  afterAll(async () => {
    await closeTestDb(pg);
  });

  it('reads a release as the offer policy needs it, and null for an unknown version', async () => {
    expect(await getRelease(db, '2.0.0')).toMatchObject({ version: '2.0.0', boards: ['cardputer'], minFrom: '1.2.0', keyId: 'k1', mandatory: false, notes: 'test build' });
    expect(await getRelease(db, '9.9.9')).toBeNull();
  });

  it('offers the stepping stone first to a device below min_from, then the target, recording each offer once', async () => {
    const id = await newDevice();
    const first = await offerOnHello(db, id, { board: 'cardputer', version: '1.0.0' });
    expect(first).toMatchObject({ version: '1.2.0', key_id: 'k1', mandatory: false });
    await offerOnHello(db, id, { board: 'cardputer', version: '1.0.0' });
    expect(await events(id)).toEqual([{ kind: 'offer', to_version: '1.2.0' }]);
    expect(await offerOnHello(db, id, { version: '1.2.0' })).toMatchObject({ version: '2.0.0' });
    expect(await currentOffer(db, id, '2.0.0')).toBeNull();
  });

  it('answers null for an unknown device or a device whose board is not known', async () => {
    expect(await offerOnHello(db, '00000000-0000-4000-8000-00000000dead', { board: 'cardputer', version: '1.0.0' })).toBeNull();
    const id = await newDevice();
    expect(await offerOnHello(db, id, { version: '1.0.0' })).toBeNull();
    expect(await currentOffer(db, id, '1.0.0')).toBeNull();
    expect(await events(id)).toEqual([]);
  });

  it('stores a reported result and stops offering after two failures of the same version', async () => {
    const id = await newDevice();
    const failed = { board: 'cardputer', version: '1.2.0', lastOta: { result: 'failed' as const, to: '2.0.0', reason: 'flash_write' } };
    expect(await offerOnHello(db, id, failed)).toMatchObject({ version: '2.0.0' });
    await recordOtaStart(db, id, '1.2.0', '2.0.0');
    expect(await offerOnHello(db, id, failed)).toBeNull();
    expect(await currentOffer(db, id, '1.2.0')).toBeNull();
    expect((await events(id)).map((e) => e.kind)).toEqual(['failed', 'offer', 'start', 'failed']);
  });

  it('recordOtaStart ignores a device with no known board, and recordOffer drops a repeat', async () => {
    const id = await newDevice();
    await recordOtaStart(db, id, '1.2.0', '2.0.0');
    expect(await events(id)).toEqual([]);
    await recordOffer(db, id, '2.0.0');
    await recordOffer(db, id, '2.0.0');
    expect(await events(id)).toEqual([{ kind: 'offer', to_version: '2.0.0' }]);
  });
});
