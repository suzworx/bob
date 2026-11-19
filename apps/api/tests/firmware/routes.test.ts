/** GET /v2/firmware/:board/:version.bin on the real local Postgres, over a real HTTP socket. */
import { createHash, randomBytes, verify } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFirmwareRouter } from '../../src/firmware/http.ts';
import { ingestRelease } from '../../src/firmware/store.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { adminDatabaseUrl, withAdmin } from '../support/pg-template.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { makeImage, makeKey, makeManifest, signManifest } from './fixture.ts';

const key = makeKey('k1');
const image = makeImage(7, 2048);
const token = `olxd_${randomBytes(32).toString('base64url')}`;

describe('firmware download route', () => {
  let pg: TestDb;
  let db: Db;
  let server: Server;
  let base = '';
  let deviceId = '';
  const admin = async (sql: string, params: unknown[] = []): Promise<Array<Record<string, string>>> =>
    withAdmin(await adminDatabaseUrl((pg as unknown as { databaseName: string }).databaseName), async (s) => [
      ...(await s.unsafe<Array<Record<string, string>>>(sql, params as never[])),
    ]);
  const get = (path: string, headers: Record<string, string> = {}, bearer: string | null = token): Promise<Response> =>
    fetch(`${base}/v2/firmware/${path}`, { headers: { ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }), ...headers } });
  const ingest = (version: string, fill: number): Promise<unknown> => {
    const img = makeImage(fill);
    return ingestRelease(db, { ...signManifest(makeManifest(img, key, { version }), key), image: img }, { k1: key.pem });
  };
  const setDevice = (set: string): Promise<unknown> => admin(`update bob.devices set ${set} where id = $1::uuid`, [deviceId]);

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    const { userId } = await addAccount(pg);
    const [row] = await admin(
      `insert into bob.devices (user_id, name, model, fw_version, fw_channel, token_hash) values ($1::uuid, 'd', 'cardputer', '1.0.0', 'stable', $2) returning id`,
      [userId, createHash('sha256').update(token).digest()],
    );
    deviceId = row?.id ?? '';
    const img = image;
    await ingestRelease(db, { ...signManifest(makeManifest(img, key, { version: '1.2.0' }), key), image: img }, { k1: key.pem });
    await ingest('1.3.0', 9);
    await admin(`insert into bob.firmware_channels (channel, board, version) values ('stable', 'cardputer', '1.2.0')`);
    const app = express();
    app.use('/v2/firmware', createFirmwareRouter({ getDb: async () => db }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await closeTestDb(pg);
  });

  it('serves the whole image with its etag and journals one download', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const response = await get('cardputer/1.2.0.bin?from=1.0.0');
    const body = Buffer.from(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(body.equals(image)).toBe(true);
    expect(response.headers.get('etag')).toBe(`"${createHash('sha256').update(image).digest('hex')}"`);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-length')).toBe('2048');
    await vi.waitFor(() => expect(log.mock.calls.filter(([line]) => String(line).includes('v2.ota.download'))).toHaveLength(1));
    const entry = JSON.parse(String(log.mock.calls.find(([line]) => String(line).includes('v2.ota.download'))?.[0])) as Record<string, unknown>;
    expect(entry).toMatchObject({ version: '1.2.0', board: 'cardputer', status: 'completed', bytes: 2048 });
    log.mockRestore();
  });

  it('serves the exact signed manifest bytes with the signature in a header, and 404s an unknown board', async () => {
    const signed = signManifest(makeManifest(image, key, { version: '1.2.0' }), key);
    const response = await get('cardputer/1.2.0.manifest?from=1.0.0');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const sig = Buffer.from(response.headers.get('x-bob-signature') ?? '', 'base64');
    expect(verify('sha256', signed.manifestBytes, { key: key.pem, dsaEncoding: 'der' }, sig)).toBe(true);
    expect(Buffer.from(await response.arrayBuffer()).equals(signed.manifestBytes)).toBe(true);
    expect((await get('other-board/1.2.0.manifest?from=1.0.0')).status).toBe(404);
    expect((await get('cardputer/1.2.0.manifest', {}, null)).status).toBe(401);
  });

  it('answers a single range with 206 and refuses an unsatisfiable one', async () => {
    const part = await get('cardputer/1.2.0.bin?from=1.0.0', { Range: 'bytes=10-19' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/2048');
    expect(Buffer.from(await part.arrayBuffer()).equals(image.subarray(10, 20))).toBe(true);
    const tail = await get('cardputer/1.2.0.bin?from=1.0.0', { Range: 'bytes=2040-' });
    expect(tail.headers.get('content-range')).toBe('bytes 2040-2047/2048');
    expect((await tail.arrayBuffer()).byteLength).toBe(8);
    const late = await get('cardputer/1.2.0.bin?from=1.0.0', { Range: 'bytes=5000-' });
    expect(late.status).toBe(416);
    expect(late.headers.get('content-range')).toBe('bytes */2048');
  });

  it('honours If-Range only for the current etag, and answers 304 for If-None-Match', async () => {
    const etag = (await get('cardputer/1.2.0.bin?from=1.0.0')).headers.get('etag') ?? '';
    expect((await get('cardputer/1.2.0.bin?from=1.0.0', { Range: 'bytes=0-9', 'If-Range': etag })).status).toBe(206);
    const stale = await get('cardputer/1.2.0.bin?from=1.0.0', { Range: 'bytes=0-9', 'If-Range': '"other"' });
    expect(stale.status).toBe(200);
    expect((await stale.arrayBuffer()).byteLength).toBe(2048);
    const same = await get('cardputer/1.2.0.bin?from=1.0.0', { 'If-None-Match': etag });
    expect(same.status).toBe(304);
    expect((await same.arrayBuffer()).byteLength).toBe(0);
  });

  it('answers 404 with one body for an unknown version and an unknown board', async () => {
    const [version, board, junk] = await Promise.all([get('cardputer/9.9.9.bin'), get('nope/1.2.0.bin'), get('cardputer/not-a-version.bin')]);
    expect([version.status, board.status, junk.status]).toEqual([404, 404, 404]);
    const bodies = await Promise.all([version.text(), board.text(), junk.text()]);
    expect(new Set(bodies).size).toBe(1);
  });

  it('answers 401 without a valid, active device', async () => {
    expect((await get('cardputer/1.2.0.bin', {}, null)).status).toBe(401);
    expect((await get('cardputer/1.2.0.bin', {}, `olxd_${randomBytes(32).toString('base64url')}`)).status).toBe(401);
    expect((await get('cardputer/1.2.0.bin', {}, 'not-a-device-token')).status).toBe(401);
    await setDevice('revoked_at = now()');
    expect((await get('cardputer/1.2.0.bin?from=1.0.0')).status).toBe(401);
    await setDevice('revoked_at = null');
  });

  it('answers 403 for a version the device could not be offered, unless it is pinned or running it', async () => {
    expect((await get('cardputer/1.3.0.bin?from=1.0.0')).status).toBe(403);
    expect((await get('cardputer/1.3.0.bin?from=1.3.0')).status).toBe(200);
    await setDevice(`fw_pin_version = '1.3.0'`);
    expect((await get('cardputer/1.3.0.bin?from=1.0.0')).status).toBe(200);
    await setDevice('fw_pin_version = null');
    expect((await get('cardputer/1.2.0.bin?from=1.2.0')).status).toBe(200);
  });

  it('answers 403 while the channel is halted', async () => {
    await admin(`update bob.firmware_channels set halted = true where channel = 'stable'`);
    expect((await get('cardputer/1.2.0.bin?from=1.0.0')).status).toBe(403);
    await admin(`update bob.firmware_channels set halted = false where channel = 'stable'`);
    expect((await get('cardputer/1.2.0.bin?from=1.0.0')).status).toBe(200);
  });
});
