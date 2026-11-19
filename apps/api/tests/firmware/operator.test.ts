/** The operator firmware router behind the real operator gate, on the real local Postgres. */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IngestSourceError } from '../../src/firmware/ingest-github.ts';
import { createOperatorFirmwareRouter } from '../../src/firmware/operator-http.ts';
import { getChannel, ingestRelease, type IngestResult } from '../../src/firmware/store.ts';
import { FirmwareVerifyError } from '../../src/firmware/verify.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { OPERATOR_SCOPE, requireScope } from '../../src/platform/observability/operator-gate.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { makeImage, makeKey, makeManifest, signManifest } from './fixture.ts';

const key = makeKey('k1');
const OPERATOR = 'op-1';
let ingestStub: () => Promise<IngestResult> = () => Promise.reject(new Error('unset'));

describe('operator firmware router', () => {
  let pg: TestDb;
  let db: Db;
  let server: Server;
  let base = '';
  const call = (method: string, path: string, body?: unknown, user: string | null = OPERATOR): Promise<Response> =>
    fetch(`${base}/api/operator/firmware${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(user === null ? {} : { 'x-user': user }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const journalLines = (log: { mock: { calls: unknown[][] } }, event: string): Array<Record<string, unknown>> =>
    log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(event)).map((line) => JSON.parse(line) as Record<string, unknown>);

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    for (const [version, fill] of [['1.2.0', 7], ['1.3.0', 9]] as const) {
      const image = makeImage(fill);
      await ingestRelease(db, { ...signManifest(makeManifest(image, key, { version }), key), image }, { k1: key.pem });
    }
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
      const user = request.get('x-user');
      if (user !== undefined) (request as unknown as { account: { userId: string } }).account = { userId: user };
      next();
    });
    app.use('/api/operator/firmware', requireScope(OPERATOR_SCOPE, async (userId) => userId === OPERATOR), createOperatorFirmwareRouter({ getDb: async () => db, ingest: () => ingestStub() }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await closeTestDb(pg);
  });

  it('answers 404 to anyone who is not an operator, on every route', async () => {
    const calls = [call('GET', '', undefined, 'someone'), call('POST', '/channel', {}, 'someone'), call('POST', '/halt', {}, null), call('POST', '/ingest', {}, 'someone')];
    expect((await Promise.all(calls)).map((r) => r.status)).toEqual([404, 404, 404, 404]);
  });

  it('lists each channel with its release, rollout, halt flag and 7-day counts', async () => {
    const body = (await (await call('GET', '')).json()) as { channels: Array<Record<string, unknown>> };
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]).toMatchObject({
      channel: 'dev', board: 'cardputer', version: '1.3.0', rollout_pct: 100, halted: false,
      release: { boards: ['cardputer'], size: 2048, mandatory: false }, last_7_days: { attempts: 0, rollbacks: 0, fleet_size: 0 },
    });
    expect((await call('GET', '?board=nothing')).status).toBe(200);
  });

  it('validates a promote, then points the channel at the release and journals it', async () => {
    const bad = [{}, { channel: 'prod', board: 'cardputer', version: '1.2.0' }, { channel: 'beta', board: 'cardputer', version: 'nope' },
      { channel: 'beta', board: 'cardputer', version: '1.2.0', rollout_pct: 101 }, { channel: 'beta', board: 'cardputer', version: '1.2.0', extra: 1 }];
    for (const body of bad) expect((await call('POST', '/channel', body)).status).toBe(400);
    expect((await call('POST', '/channel', { channel: 'beta', board: 'cardputer', version: '9.9.9' })).status).toBe(404);
    expect((await call('POST', '/channel', { channel: 'beta', board: 'other', version: '1.2.0' })).status).toBe(400);
    expect(await getChannel(db, 'beta', 'cardputer')).toBeNull();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect((await call('POST', '/channel', { channel: 'beta', board: 'cardputer', version: '1.2.0', rollout_pct: 50 })).status).toBe(200);
    expect(await getChannel(db, 'beta', 'cardputer')).toMatchObject({ version: '1.2.0', rolloutPct: 50 });
    expect(journalLines(log, 'v2.ota.promote')).toMatchObject([{ channel: 'beta', board: 'cardputer', version: '1.2.0', rollout_pct: 50 }]);
    log.mockRestore();
  });

  it('halts and resumes a channel, journaling only a change', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const halt = (halted: boolean) => call('POST', '/halt', { channel: 'beta', board: 'cardputer', halted });
    expect((await halt(true)).status).toBe(200);
    expect((await halt(true)).status).toBe(200);
    expect((await getChannel(db, 'beta', 'cardputer'))?.halted).toBe(true);
    expect((await halt(false)).status).toBe(200);
    expect((await getChannel(db, 'beta', 'cardputer'))?.halted).toBe(false);
    expect(journalLines(log, 'v2.ota.halt').map((line) => line.halted)).toEqual([true, false]);
    expect((await call('POST', '/halt', { channel: 'stable', board: 'cardputer', halted: true })).status).toBe(404);
    expect((await call('POST', '/halt', { channel: 'beta', board: 'cardputer' })).status).toBe(400);
    log.mockRestore();
  });

  it('ingests a tag and maps refusals to neutral codes', async () => {
    ingestStub = () => Promise.resolve({ version: '1.4.0', inserted: true, advanced: ['cardputer'] });
    const ok = await call('POST', '/ingest', { tag: 'v1.4.0' });
    expect([ok.status, await ok.json()]).toEqual([200, { version: '1.4.0', inserted: true, advanced: ['cardputer'] }]);
    const refuse = async (error: Error): Promise<[number, unknown]> => {
      ingestStub = () => Promise.reject(error);
      const response = await call('POST', '/ingest', { tag: 'v1.4.0' });
      return [response.status, await response.json()];
    };
    expect(await refuse(new FirmwareVerifyError('bad_signature'))).toEqual([422, { error: { code: 'bad_signature' } }]);
    expect(await refuse(new IngestSourceError('too_large'))).toEqual([413, { error: { code: 'too_large' } }]);
    expect(await refuse(new IngestSourceError('release_not_found'))).toEqual([404, { error: { code: 'release_not_found' } }]);
    expect(await refuse(new IngestSourceError('fetch_failed'))).toEqual([502, { error: { code: 'fetch_failed' } }]);
    expect((await call('POST', '/ingest', { tag: '' })).status).toBe(400);
  });
});
