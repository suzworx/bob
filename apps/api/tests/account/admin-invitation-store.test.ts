import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asDb,
  addAccount,
  withAdminAuth,
  closeTestDb,
  createTestDb,
  type TestDb,
  type TestAccount,
} from '../support/test-db.ts';
import { ackOutbox, claimOutboxBatch, releaseOutbox } from '../../src/platform/outbox/store.ts';
import { markEmailEffectSent } from '../../src/notifications/store.ts';

let pg: TestDb;
let actor: TestAccount;
async function recipient(): Promise<{ userId: string; email: string }> {
  const account = await addAccount(pg);
  const email = `${account.userId}@example.test`;
  await withAdminAuth(pg, (auth) => auth.setProfile(account.userId, { email }));
  return { userId: account.userId, email };
}
async function queue(email: string, retry = false, identity = actor): Promise<string | undefined> {
  const { rows } = await pg.query<{ status: string }>(
    'select bob_private.admin_invitation_queue($1::uuid,$2::uuid,$3::text,$4::boolean) as status',
    [identity.userId, identity.sessionId, email, retry],
  );
  return rows[0]?.status;
}
async function databaseNow(): Promise<number> {
  // Postgres retains microseconds; round up so JS Date cannot put the claim
  // before a just-enqueued row. Release and claim must share the DB clock.
  const { rows } = await pg.query<{ now: string }>(
    'select extract(epoch from clock_timestamp()) * 1000 as now',
  );
  return Math.ceil(Number(rows[0]?.now));
}
async function claim(userId: string, now?: number) {
  const rows = await claimOutboxBatch(asDb(pg), {
    owner: 'invite-test',
    limit: 50,
    leaseMs: 30_000,
    now: now ?? await databaseNow(),
  });
  const row = rows.find((item) => item.resourceId === userId);
  if (!row) throw new Error('expected queued invitation');
  return row;
}
describe('durable admin invitation queue', () => {
  beforeAll(async () => {
    pg = await createTestDb();
    actor = await addAccount(pg);
    await pg.query("select bob_private.grant_user_scope($1::uuid,'accounts.admin')", [
      actor.userId,
    ]);
  });
  afterAll(async () => {
    if (pg) await closeTestDb(pg);
  });
  it('deduplicates concurrent submissions and records only SMTP acceptance as sent', async () => {
    const target = await recipient();
    expect(await Promise.all([queue(target.email), queue(target.email)])).toEqual([
      'queued',
      'queued',
    ]);
    const row = await claim(target.userId);
    expect(row.payload).toEqual({ recipient_user_id: target.userId });
    expect(await queue(target.email, true)).toBe('queued');
    expect(await markEmailEffectSent(asDb(pg), row.effectKey, target.userId)).toBe(true);
    expect(await queue(target.email, true)).toBe('sent');
  });
  it('does not steal a lease and lets an explicit retry recover parked work', async () => {
    const target = await recipient();
    await queue(target.email);
    const row = await claim(target.userId);
    await queue(target.email, true);
    expect(
      await releaseOutbox(asDb(pg), {
        owner: 'invite-test',
        id: row.id,
        retryInMs: 86_400_000,
        errorCode: 'parked',
        now: await databaseNow(),
      }),
    ).toMatchObject({ lastErrorCode: 'parked' });
    expect(await queue(target.email)).toBe('failed');
    expect(await queue(target.email, true)).toBe('queued');
    expect((await claim(target.userId)).attempts).toBe(0);
  });
  it('keeps ordinary retry backoff queued and never treats skipped delivery as sent', async () => {
    const target = await recipient();
    await queue(target.email);
    const row = await claim(target.userId);
    const released = await releaseOutbox(asDb(pg), {
      owner: 'invite-test',
      id: row.id,
      now: await databaseNow(),
      retryInMs: 1_000,
      errorCode: 'EmailSendError',
    });
    expect(await queue(target.email)).toBe('queued');
    if (!released) throw new Error('expected released invitation');
    const premature = await claimOutboxBatch(asDb(pg), {
      owner: 'invite-test', limit: 50, leaseMs: 30_000, now: released.availableAt - 1,
    });
    expect(premature.some((item) => item.resourceId === target.userId)).toBe(false);
    const retry = await claim(target.userId, released.availableAt);
    await ackOutbox(asDb(pg), { owner: 'invite-test', id: retry.id });
    expect(await queue(target.email)).toBe('failed');
  });
  it('refuses an ordinary actor, mismatched session and revoked scope', async () => {
    const target = await recipient();
    const ordinary = await addAccount(pg);
    await expect(queue(target.email, false, ordinary)).rejects.toThrow();
    await expect(
      queue(target.email, false, { ...actor, sessionId: ordinary.sessionId }),
    ).rejects.toThrow();
    await pg.query("select bob_private.revoke_user_scope($1::uuid,'accounts.admin')", [
      actor.userId,
    ]);
    await expect(queue(target.email)).rejects.toThrow();
    await pg.query("select bob_private.grant_user_scope($1::uuid,'accounts.admin')", [
      actor.userId,
    ]);
  });
  it('suppresses banned recipients after enqueue', async () => {
    const target = await recipient();
    await queue(target.email);
    await withAdminAuth(pg, (auth) => auth.banUser(target.userId, '2099-01-01T00:00:00Z'));
    expect(await queue(target.email, true)).toBe('failed');
    const { rows } = await pg.query<{ email: string | null }>(
      'select bob_private.admin_invitation_recipient($1::uuid) as email',
      [target.userId],
    );
    expect(rows[0]?.email).toBeNull();
  });
  it('purges a queued recipient effect and makes an already claimed handler ineligible', async () => {
    const target = await recipient();
    await queue(target.email);
    await claim(target.userId);
    const { rows: purged } = await pg.query<{ count: number }>(
      'select bob_private.purge_account_email_effects($1::uuid) as count',
      [target.userId],
    );
    expect(purged[0]?.count).toBe(1);
    const { rows } = await pg.query<{ email: string | null }>(
      'select bob_private.admin_invitation_recipient($1::uuid) as email',
      [target.userId],
    );
    expect(rows[0]?.email).toBeNull();
  });
});
