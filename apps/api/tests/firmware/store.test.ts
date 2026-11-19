/** The firmware store on the repo's real local Postgres, as bob_server (the server-only tables answer only through definers). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';
import {
  channelFor, evaluateAutoHalt, getChannel, getImage, ingestRelease, recentFailures, recordDeviceFirmware,
} from '../../src/firmware/store.ts';
import { FirmwareVerifyError } from '../../src/firmware/verify.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { makeImage, makeKey, makeManifest, signManifest } from './fixture.ts';

const key = makeKey('k1');
const keys: Record<string, string> = { k1: key.pem };

describe('firmware store', () => {
  let pg: TestDb;
  let db: Db;
  let userId = '';
  const admin = async <T,>(sql: string, params: unknown[] = []): Promise<T[]> =>
    withAdmin(await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName), async (s) => [
      ...(await s.unsafe<T[]>(sql, params as never[])),
    ]);
  const newDevice = async (channel = 'stable'): Promise<string> => {
    const [row] = await admin<{ id: string }>(
      `insert into bob.devices (user_id, name, model, fw_version, fw_channel) values ($1::uuid, 'seed', 'cardputer', '1.0.0', $2) returning id`,
      [userId, channel],
    );
    if (row === undefined) throw new Error('no device');
    return row.id;
  };
  const release = (version: string, image = makeImage(), over: Record<string, unknown> = {}) => {
    const manifest = makeManifest(image, key, { version, ...over });
    return { ...signManifest(manifest, key), image };
  };

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    userId = (await addAccount(pg)).userId;
  }, 120_000);

  afterAll(async () => {
    await closeTestDb(pg);
  });

  it('keeps the tables server-only: forced RLS and no policies', async () => {
    const rows = await admin<{ relname: string; forced: boolean }>(
      `select relname, relforcerowsecurity as forced from pg_class
        where oid = any (array['bob.firmware_releases'::regclass, 'bob.firmware_images'::regclass,
                               'bob.firmware_channels'::regclass, 'bob.firmware_events'::regclass])`,
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.forced)).toBe(true);
    expect(await admin(`select 1 from pg_policies where tablename like 'firmware_%'`)).toEqual([]);
    await expect(pg.query('select * from bob.firmware_releases')).rejects.toThrow();
  });

  it('ingests once, serves the image with an etag and is idempotent', async () => {
    const input = release('1.2.0');
    const first = await ingestRelease(db, input, keys);
    expect(first).toEqual({ version: '1.2.0', inserted: true, advanced: ['cardputer'] });
    const again = await ingestRelease(db, input, keys);
    expect(again.inserted).toBe(false);
    expect(await admin(`select 1 from bob.firmware_releases where version = '1.2.0'`)).toHaveLength(1);
    const served = await getImage(db, '1.2.0', 'cardputer');
    expect(served?.bytes.equals(input.image)).toBe(true);
    expect(served?.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(await getImage(db, '1.2.0', 'other-board')).toBeNull();
    expect(await getImage(db, '9.9.9', 'cardputer')).toBeNull();
  });

  it('refuses a bad signature, an unknown key and an image that differs from the manifest', async () => {
    const good = release('1.3.0');
    const refused = async (input: Parameters<typeof ingestRelease>[1], k = keys): Promise<string> =>
      ingestRelease(db, input, k).then(() => 'accepted', (e: unknown) => (e instanceof FirmwareVerifyError ? e.code : 'untyped'));
    expect(await refused({ ...good, sigB64: release('1.3.1').sigB64 })).toBe('bad_signature');
    expect(await refused(good, {})).toBe('unknown_key');
    expect(await refused({ ...good, image: makeImage(8) })).toBe('image_mismatch');
    expect(await refused({ ...good, image: makeImage(7, 100) })).toBe('image_mismatch');
    expect(await admin(`select 1 from bob.firmware_releases where version = '1.3.0'`)).toEqual([]);
    expect(await admin(`select 1 from bob.firmware_images`)).toHaveLength(1);
  });

  it('advances the dev channel only to a higher version', async () => {
    expect((await getChannel(db, 'dev', 'cardputer'))?.version).toBe('1.2.0');
    expect((await ingestRelease(db, release('1.1.0', makeImage(1)), keys)).advanced).toEqual([]);
    expect((await getChannel(db, 'dev', 'cardputer'))?.version).toBe('1.2.0');
    expect((await ingestRelease(db, release('1.2.1-dev+abc', makeImage(2)), keys)).advanced).toEqual(['cardputer']);
    expect((await ingestRelease(db, release('1.2.1', makeImage(3)), keys)).advanced).toEqual(['cardputer']);
    expect(await getChannel(db, 'dev', 'cardputer')).toMatchObject({ version: '1.2.1', rolloutPct: 100, halted: false });
  });

  it('records the board and results as events, dropping a repeated report', async () => {
    const id = await newDevice();
    expect(await channelFor(db, id)).toEqual({ channel: 'stable', pinVersion: null, board: null, attempts: 0 });
    await recordDeviceFirmware(db, id, { board: 'cardputer', version: '1.0.0', lastOta: null });
    const failed = { board: 'cardputer', version: '1.0.0', lastOta: { result: 'failed' as const, to: '1.2.1', reason: 'flash_write' } };
    await recordDeviceFirmware(db, id, failed);
    await recordDeviceFirmware(db, id, failed);
    expect(await channelFor(db, id)).toMatchObject({ board: 'cardputer' });
    expect(await admin(`select kind, from_version, to_version, reason_code from bob.firmware_events where device_id = $1::uuid`, [id]))
      .toEqual([{ kind: 'failed', from_version: '1.0.0', to_version: '1.2.1', reason_code: 'flash_write' }]);
    expect(await admin(`select fw_last_result as r from bob.devices where id = $1::uuid`, [id])).toEqual([{ r: 'failed' }]);
    expect(await recentFailures(db, id, '1.2.1')).toBe(1);
    expect(await channelFor(db, '00000000-0000-4000-8000-00000000dead')).toBeNull();
  });

  it('counts a repeated result once even when an offer was recorded in between', async () => {
    const id = await newDevice();
    const failed = { board: 'cardputer', version: '1.0.0', lastOta: { result: 'failed' as const, to: '1.2.1', reason: 'manifest_bad' } };
    await recordDeviceFirmware(db, id, failed);
    for (let i = 0; i < 3; i += 1) {
      await admin(`insert into bob.firmware_events (device_id, kind, to_version) values ($1::uuid, 'offer', '1.2.1')`, [id]);
      await recordDeviceFirmware(db, id, failed);
    }
    expect(await recentFailures(db, id, '1.2.1')).toBe(1);
    await admin(`insert into bob.firmware_events (device_id, kind, from_version, to_version) values ($1::uuid, 'start', '1.0.0', '1.2.1')`, [id]);
    await recordDeviceFirmware(db, id, failed);
    expect(await recentFailures(db, id, '1.2.1')).toBe(2);
  });

  it('halts a small channel at two rollbacks and not before', async () => {
    const [a, b] = [await newDevice('beta'), await newDevice('beta')];
    await admin(`insert into bob.firmware_channels (channel, board, version) values ('beta', 'cardputer', '1.2.1')`);
    const rolledBack = (id: string) =>
      recordDeviceFirmware(db, id, { board: 'cardputer', version: '1.2.0', lastOta: { result: 'rolled_back', to: '1.2.1', reason: 'boot_loop' } });
    await rolledBack(a);
    expect(await evaluateAutoHalt(db, 'beta', 'cardputer')).toBe(false);
    expect((await getChannel(db, 'beta', 'cardputer'))?.halted).toBe(false);
    await rolledBack(b);
    expect(await evaluateAutoHalt(db, 'beta', 'cardputer')).toBe(true);
    expect((await getChannel(db, 'beta', 'cardputer'))?.halted).toBe(true);
  });
});
