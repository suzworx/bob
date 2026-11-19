// #757 contract lock: the device-settings API and store as they are today, on
// bob.device_settings. Real router over the test database, volatile ids and
// times normalised, every response snapshotted with its exact status. Moving
// the columns onto bob.devices must leave this snapshot byte-identical.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

// AI-stub mode as thread-conversation-contract.test.ts: no real model call anywhere.
vi.mock('@bob/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bob/ai')>()),
  AI_STUB_MODE: true,
}));

import type { Db } from '../../src/platform/db/db.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import * as pairing from '../../src/devices/pairing-service.ts';
import { revokeDevice } from '../../src/devices/pairing-store.ts';
import { createDevicesRouter } from '../../src/devices/http.ts';
import {
  DEFAULT_DEVICE_SETTINGS, forFirmware, getAccountTimeZone, getDeviceSettings, patchDeviceSettings, pickSettings,
  setDeviceSettings,
} from '../../src/devices/settings-store.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { DeviceSettingsResponseSchema, DevicesResponseSchema } from '../../src/web-schemas.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let ids = new Map<string, string>();
beforeEach(() => {
  ids = new Map();
});

/** One stable placeholder per distinct id, numbered in order of first sight within a test. */
function stable(raw: string, kind: string): string {
  const key = raw.toLowerCase();
  if (!ids.has(key)) ids.set(key, `<${kind}-${ids.size + 1}>`);
  return ids.get(key)!;
}

function normalize(value: unknown): unknown {
  if (typeof value === 'string') {
    if (UUID.test(value)) return stable(value, 'uuid');
    const prefixed = /^([a-z]+[_:])(.+)$/.exec(value);
    if (prefixed && UUID.test(prefixed[2]!)) return `${prefixed[1]}${stable(prefixed[2]!, 'uuid')}`;
    return value;
  }
  if (typeof value === 'number' && value > 1e12) return '<epoch-ms>';
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, normalize(inner)]));
  }
  return value;
}

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  const getDb = (): Promise<Db> => Promise.resolve(db);
  const app = express();
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use('/api/devices', createDevicesRouter({
    getDb, requireActiveSession: requireActiveSession(getDb), events: pairing.getAccountEvents(), deviceSessions: getDeviceSessions(),
  }));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  getDeviceSessions().clear();
  server?.close();
  await closeTestDb(pg).catch(() => undefined);
});

type Owner = { userId: string; token: string; deviceId: string };

/** A fresh account with one paired, offline Cardputer, so every list has one row. */
async function owner(): Promise<Owner> {
  const account = await addAccount(pg);
  const issued = await pairing.issueCode(db, {
    model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim: `claim-${randomUUID()}`, ip: '203.0.113.91',
  });
  const deviceId = await pairing.approve(db, account.userId, issued.pairingId, 'Desk');
  return { userId: account.userId, token: await signToken({ userId: account.userId, sessionId: account.sessionId }), deviceId };
}

/** Sends a request, asserts the exact status, Zod-parses a success body when given a schema, normalises. */
async function call(
  method: string, path: string, token: string, status: number, body?: unknown, schema?: z.ZodTypeAny,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as unknown;
  expect({ status: res.status, body: json }).toMatchObject({ status });
  if (schema) schema.parse(json);
  return normalize({ status: res.status, body: json });
}

/** A store call's normalised value, or the error it threw (class and message). */
async function settle(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return normalize({ value: await run() });
  } catch (error) {
    return { error: error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error) };
  }
}

const OLD_REPORT = { volume: 3, muted: true, mode: 'wake' as const, dnd: true };
const RING_REPORT = { ...OLD_REPORT, ring_seconds: 90, ring_sound: 'chime' as const };
const KEEP = { keepPending: true };

describe('GET /api/devices settings contract', () => {
  it('a device with no stored settings shows the firmware defaults', async () => {
    const a = await owner();
    expect(await call('GET', '/api/devices', a.token, 200, undefined, DevicesResponseSchema)).toMatchSnapshot('no stored settings');
    expect(await getDeviceSettings(db, a.userId, a.deviceId)).toBeNull();
  });

  it('stored non-default settings the device reported (no ring keys)', async () => {
    const a = await owner();
    await setDeviceSettings(db, a.userId, a.deviceId, OLD_REPORT, KEEP);
    expect(await call('GET', '/api/devices', a.token, 200, undefined, DevicesResponseSchema)).toMatchSnapshot('stored, device reported, no ring');
  });

  it('a pending push from a web change', async () => {
    const a = await owner();
    await patchDeviceSettings(db, a.userId, a.deviceId, { volume: 8, muted: true });
    expect(await call('GET', '/api/devices', a.token, 200, undefined, DevicesResponseSchema)).toMatchSnapshot('pending push');
  });

  it('a device that reported ring support', async () => {
    const a = await owner();
    await setDeviceSettings(db, a.userId, a.deviceId, RING_REPORT, KEEP);
    expect(await call('GET', '/api/devices', a.token, 200, undefined, DevicesResponseSchema)).toMatchSnapshot('ring reported');
  });

  it('a revoked device drops out of the list', async () => {
    const a = await owner();
    await setDeviceSettings(db, a.userId, a.deviceId, RING_REPORT, KEEP);
    await revokeDevice(db, a.userId, a.deviceId);
    expect(await call('GET', '/api/devices', a.token, 200, undefined, DevicesResponseSchema)).toMatchSnapshot('revoked');
  });
});

describe('PATCH /api/devices/:id/settings contract', () => {
  it('200 for each field, merged and pending', async () => {
    const a = await owner();
    await setDeviceSettings(db, a.userId, a.deviceId, RING_REPORT, KEEP);
    const path = `/api/devices/${a.deviceId}/settings`;
    const bodies: Array<Record<string, unknown>> = [
      { volume: 0 }, { volume: 10 }, { muted: false }, { mode: 'announce_only' }, { dnd: false },
      { ring_seconds: 10 }, { ring_seconds: 120 }, { ring_sound: 'pulse' },
      { volume: 4, muted: true, mode: 'ptt', dnd: true, ring_seconds: 45, ring_sound: 'classic' },
    ];
    for (const body of bodies) {
      expect(await call('PATCH', path, a.token, 200, body, DeviceSettingsResponseSchema)).toMatchSnapshot(`200 ${JSON.stringify(body)}`);
    }
    expect(await call('GET', '/api/devices', a.token, 200, undefined, DevicesResponseSchema)).toMatchSnapshot('list after the patches');
  });

  it('400 for each out-of-range value and bad body', async () => {
    const a = await owner();
    await setDeviceSettings(db, a.userId, a.deviceId, RING_REPORT, KEEP);
    const path = `/api/devices/${a.deviceId}/settings`;
    const bodies: unknown[] = [
      {}, { volume: -1 }, { volume: 11 }, { volume: 1.5 }, { volume: '5' }, { muted: 'yes' }, { mode: 'loud' }, { dnd: 1 },
      { ring_seconds: 9 }, { ring_seconds: 121 }, { ring_seconds: 30.5 }, { ring_sound: 'siren' },
      { volume: 5, extra: true }, { unknown: 1 }, [],
    ];
    for (const body of bodies) {
      expect(await call('PATCH', path, a.token, 400, body)).toMatchSnapshot(`400 ${JSON.stringify(body)}`);
    }
    expect(await getDeviceSettings(db, a.userId, a.deviceId)).toMatchObject({ volume: 3, pendingPush: false });
  });

  it('404 for a foreign, revoked, unknown and malformed id', async () => {
    const a = await owner();
    const b = await owner();
    const revoked = await owner();
    await revokeDevice(db, revoked.userId, revoked.deviceId);
    const targets = [
      ['foreign', b.deviceId], ['revoked', revoked.deviceId], ['unknown', randomUUID()], ['malformed', 'not-a-uuid'],
    ] as const;
    for (const [label, id] of targets) {
      const token = label === 'revoked' ? revoked.token : a.token;
      expect(await call('PATCH', `/api/devices/${id}/settings`, token, 404, { volume: 5 })).toMatchSnapshot(`404 ${label}`);
    }
    expect(await getDeviceSettings(db, b.userId, b.deviceId)).toBeNull();
  });

  it('409 ring_unsupported before the device reports ring support, nothing written', async () => {
    const a = await owner();
    const path = `/api/devices/${a.deviceId}/settings`;
    expect(await call('PATCH', path, a.token, 409, { ring_seconds: 60 })).toMatchSnapshot('409 no settings row');
    expect(await call('PATCH', path, a.token, 409, { ring_sound: 'chime', volume: 2 })).toMatchSnapshot('409 ring + volume');
    expect(await getDeviceSettings(db, a.userId, a.deviceId)).toBeNull();
    await setDeviceSettings(db, a.userId, a.deviceId, OLD_REPORT, KEEP);
    expect(await call('PATCH', path, a.token, 409, { ring_sound: 'pulse' })).toMatchSnapshot('409 old firmware row');
    expect(await call('PATCH', path, a.token, 200, { volume: 9 }, DeviceSettingsResponseSchema)).toMatchSnapshot('200 non-ring patch still works');
  });
});

describe('settings-store contract', () => {
  it('pure helpers: defaults, pickSettings, forFirmware', () => {
    expect({
      defaults: DEFAULT_DEVICE_SETTINGS,
      picked: pickSettings({ ...DEFAULT_DEVICE_SETTINGS, volume: 2 }),
      forOldFirmware: forFirmware({ ...DEFAULT_DEVICE_SETTINGS, ring_seconds: 99 }, false),
      forRingFirmware: forFirmware({ ...DEFAULT_DEVICE_SETTINGS, ring_seconds: 99 }, true),
    }).toMatchSnapshot('pure helpers');
  });

  it('getDeviceSettings: missing row is null, then stored, pending, ring reported', async () => {
    const a = await owner();
    const get = (): Promise<unknown> => settle(() => getDeviceSettings(db, a.userId, a.deviceId));
    const states: Record<string, unknown> = { missing: await get() };
    await patchDeviceSettings(db, a.userId, a.deviceId, { volume: 9 });
    states.afterWebPatch = await get();
    await setDeviceSettings(db, a.userId, a.deviceId, OLD_REPORT, { keepPending: false });
    states.afterOldReport = await get();
    await setDeviceSettings(db, a.userId, a.deviceId, RING_REPORT, KEEP);
    states.afterRingReport = await get();
    expect(states).toMatchSnapshot('getDeviceSettings states');
  });

  it('patchDeviceSettings: every return value', async () => {
    const a = await owner();
    const b = await owner();
    const gone = await owner();
    await revokeDevice(db, gone.userId, gone.deviceId);
    const patch = (who: Owner, id: string, p: Parameters<typeof patchDeviceSettings>[3]): Promise<unknown> =>
      settle(() => patchDeviceSettings(db, who.userId, id, p));
    const results: Record<string, unknown> = {
      firstPatchMergesDefaults: await patch(a, a.deviceId, { mode: 'wake' }),
      ringBeforeSupport: await patch(a, a.deviceId, { ring_seconds: 20 }),
      foreign: await patch(b, a.deviceId, { volume: 1 }),
      revoked: await patch(gone, gone.deviceId, { volume: 1 }),
      unknown: await patch(a, randomUUID(), { volume: 1 }),
      malformed: await patch(a, 'nope', { volume: 1 }),
      volumeCheckViolation: await patch(a, a.deviceId, { volume: 99 }),
      ringCheckViolation: await (async () => {
        await setDeviceSettings(db, a.userId, a.deviceId, RING_REPORT, KEEP);
        return patch(a, a.deviceId, { ring_seconds: 5 });
      })(),
      modeCheckViolation: await patch(a, a.deviceId, { mode: 'bogus' as never }),
      mergeAfterRingSupport: await patch(a, a.deviceId, { ring_sound: 'pulse', dnd: true }),
      finalStore: await settle(() => getDeviceSettings(db, a.userId, a.deviceId)),
    };
    expect(results).toMatchSnapshot('patchDeviceSettings results');
  });

  it('setDeviceSettings: stored, synced, kept_pending, device_override, old firmware, refused', async () => {
    const a = await owner();
    const b = await owner();
    const gone = await owner();
    await revokeDevice(db, gone.userId, gone.deviceId);
    const report = (who: Owner, id: string, r: Parameters<typeof setDeviceSettings>[3], keepPending: boolean): Promise<unknown> =>
      settle(() => setDeviceSettings(db, who.userId, id, r, { keepPending }));
    const results: Record<string, unknown> = {};
    results.firstReportStored = await report(a, a.deviceId, OLD_REPORT, true);
    results.oldFirmwareKeepsRing = await report(a, a.deviceId, { ...OLD_REPORT, volume: 4 }, true);
    results.ringReportStored = await report(a, a.deviceId, RING_REPORT, true);
    await patchDeviceSettings(db, a.userId, a.deviceId, { volume: 7 });
    results.syncedOnMatch = await report(a, a.deviceId, { ...RING_REPORT, volume: 7 }, true);
    await patchDeviceSettings(db, a.userId, a.deviceId, { volume: 8 });
    results.keptPending = await report(a, a.deviceId, RING_REPORT, true);
    results.stillPending = await settle(() => getDeviceSettings(db, a.userId, a.deviceId));
    results.deviceOverride = await report(a, a.deviceId, { ...RING_REPORT, volume: 1 }, false);
    results.refusedForeign = await report(b, a.deviceId, OLD_REPORT, true);
    results.refusedRevoked = await report(gone, gone.deviceId, OLD_REPORT, true);
    results.refusedBadVolume = await report(a, a.deviceId, { ...RING_REPORT, volume: 99 }, true);
    results.foreignStoreUntouched = await settle(() => getDeviceSettings(db, b.userId, a.deviceId));
    expect(results).toMatchSnapshot('setDeviceSettings results');
  });

  it('getAccountTimeZone is null without user_metadata', async () => {
    const a = await owner();
    expect(await settle(() => getAccountTimeZone(db, a.userId))).toMatchSnapshot('account time zone');
  });
});

describe('two-account isolation', () => {
  it("account B gets 404 or nothing for account A's device on every route and store call", async () => {
    const a = await owner();
    const b = await owner();
    await setDeviceSettings(db, a.userId, a.deviceId, RING_REPORT, KEEP);
    await patchDeviceSettings(db, a.userId, a.deviceId, { volume: 8 });
    const before = await getDeviceSettings(db, a.userId, a.deviceId);
    const out: Record<string, unknown> = {
      bList: await call('GET', '/api/devices', b.token, 200, undefined, DevicesResponseSchema),
      bPatchSettings: await call('PATCH', `/api/devices/${a.deviceId}/settings`, b.token, 404, { volume: 1 }),
      bPatchRing: await call('PATCH', `/api/devices/${a.deviceId}/settings`, b.token, 404, { ring_seconds: 15 }),
      bGet: await settle(() => getDeviceSettings(db, b.userId, a.deviceId)),
      bPatch: await settle(() => patchDeviceSettings(db, b.userId, a.deviceId, { volume: 1 })),
      bRingPatch: await settle(() => patchDeviceSettings(db, b.userId, a.deviceId, { ring_sound: 'pulse' })),
      bSet: await settle(() => setDeviceSettings(db, b.userId, a.deviceId, OLD_REPORT, KEEP)),
    };
    expect(await getDeviceSettings(db, a.userId, a.deviceId)).toEqual(before);
    out.aListStillOwn = await call('GET', '/api/devices', a.token, 200, undefined, DevicesResponseSchema);
    expect(out).toMatchSnapshot('account B versus account A');
  });
});
