import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from './support/test-db.ts';
import { listPushDevices, registerPushDevice, removePushDevice } from '../src/notifications/push-store.ts';

let testDb: TestDb;
beforeAll(async () => { testDb = await createTestDb(); });
afterAll(async () => { await closeTestDb(testDb); });
it('upserts one installation while isolating account reads and deletion', async () => {
  const owner = await addAccount(testDb);
  const other = await addAccount(testDb);
  const db = asDb(testDb);
  const installation = randomUUID();
  const input = { installation_id: installation, token: 'ab'.repeat(32), environment: 'sandbox' as const,
    topic: 'xyz.heybob.ios', app_version: '1.0', local_timer_ids: [] };
  await registerPushDevice(db, owner.userId, owner.sessionId, input);
  await registerPushDevice(db, owner.userId, owner.sessionId, { ...input, app_version: '1.1' });
  expect(await listPushDevices(db, other.userId)).toEqual([]);
  await removePushDevice(db, other.userId, installation);
  const devices = await listPushDevices(db, owner.userId);
  expect(devices).toHaveLength(1);
  expect(devices[0]?.appVersion).toBe('1.1');
  await removePushDevice(db, owner.userId, installation);
  expect(await listPushDevices(db, owner.userId)).toEqual([]);
});

it('moves a physical token to the new account and does not let the former account delete it',async () => {
 const a=await addAccount(testDb); const b=await addAccount(testDb); const db=asDb(testDb);
 const input={ installation_id:randomUUID(),token:'cd'.repeat(32),environment:'sandbox' as const,topic:'xyz.heybob.ios',app_version:'1',local_timer_ids:[] };
 await registerPushDevice(db,a.userId,a.sessionId,input);
 await registerPushDevice(db,b.userId,b.sessionId,input);
 expect(await listPushDevices(db,a.userId)).toEqual([]);
 await removePushDevice(db,a.userId,input.installation_id);
 expect(await listPushDevices(db,b.userId)).toHaveLength(1);
});

it('rejects registration bound to another account session',async () => {
 const a=await addAccount(testDb); const b=await addAccount(testDb);
 expect(await registerPushDevice(asDb(testDb),a.userId,b.sessionId,{ installation_id:randomUUID(),token:'ef'.repeat(32),environment:'sandbox',topic:'xyz.heybob.ios',app_version:'1',local_timer_ids:[] })).toBe(false);
 expect(await listPushDevices(asDb(testDb),a.userId)).toEqual([]);
});

it('rebinds the same installation across accounts even when APNs rotated the token and old deletion failed', async () => {
  const a = await addAccount(testDb);
  const b = await addAccount(testDb);
  const db = asDb(testDb);
  const installation = randomUUID();
  const old = { installation_id: installation, token: '56'.repeat(32), environment: 'sandbox' as const,
    topic: 'xyz.heybob.ios', app_version: '1', local_timer_ids: [] };
  await registerPushDevice(db, a.userId, a.sessionId, old);
  // No old-account DELETE reaches the service. The new sign-in must own the
  // installation even if Apple has issued a different token meanwhile.
  await registerPushDevice(db, b.userId, b.sessionId, { ...old, token: '78'.repeat(32) });
  expect(await listPushDevices(db, a.userId)).toEqual([]);
  const current = await listPushDevices(db, b.userId);
  expect(current).toHaveLength(1);
  expect(current[0]?.token).toBe('78'.repeat(32));
  await removePushDevice(db, a.userId, installation);
  expect(await listPushDevices(db, b.userId)).toHaveLength(1);
});

it('serializes concurrent account registrations for one installation and preserves unrelated devices', async () => {
  const a = await addAccount(testDb);
  const b = await addAccount(testDb);
  const unrelated = await addAccount(testDb);
  const db = asDb(testDb);
  const installation = randomUUID();
  const base = { installation_id: installation, token: '9a'.repeat(32), environment: 'sandbox' as const,
    topic: 'xyz.heybob.ios', app_version: '1', local_timer_ids: [] };
  await registerPushDevice(db, unrelated.userId, unrelated.sessionId, { ...base, installation_id: randomUUID(), token: 'bc'.repeat(32) });
  await Promise.all([
    registerPushDevice(db, a.userId, a.sessionId, base),
    registerPushDevice(db, b.userId, b.sessionId, { ...base, token: 'de'.repeat(32), environment: 'production' }),
  ]);
  const devices = [...await listPushDevices(db, a.userId), ...await listPushDevices(db, b.userId)];
  expect(devices).toHaveLength(1);
  expect(devices[0]?.installationId).toBe(installation);
  expect(await listPushDevices(db, unrelated.userId)).toHaveLength(1);
});
