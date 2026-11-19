import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { addGoogleAccount, deleteGoogleAccount } from '../../src/integrations/google-store.ts';
import { accountTablesPresent, purgeAccountContent } from '../../src/account/store.ts';
import { eraseAccount } from '../../src/account/erasure-service.ts';
import { createRoutine, deleteRoutine, listRoutines, updateRoutine } from '../../src/routines/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

describe('owner-scoped routine definitions', () => {
  let pg: TestDb;
  let db: Db;
  const now = Date.parse('2026-10-22T00:00:00Z');
  beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
  afterAll(async () => { if (pg) await closeTestDb(pg); });

  async function fixture(): Promise<{ owner: string; googleAccountId: string }> {
    const { userId } = await addAccount(pg);
    const google = await addGoogleAccount(db, userId, {
      installationId: randomUUID(), accountId: randomUUID(), email: 'routine@example.test',
    });
    await withUser(db, userId, (tx) => tx.query("update bob.google_accounts set authorization_capabilities = array['gmail.read'] where id = $1", [google.id]));
    return { owner: userId, googleAccountId: google.id };
  }
  function input(googleAccountId: string): { kind: 'daily_gmail_digest'; googleAccountId: string; localTime: string; timeZone: string; scheduledReadConsent: true } {
    return { kind: 'daily_gmail_digest', googleAccountId, localTime: '08:00', timeZone: 'UTC', scheduledReadConsent: true };
  }

  it('creates a durable definition and isolates reads, writes, and account relationships', async () => {
    const first = await fixture();
    const other = await fixture();
    const routine = await createRoutine(db, first.owner, input(first.googleAccountId), now);
    expect(routine).toMatchObject({ revision: 1, status: 'active', nextRunAt: now + 8 * 3_600_000 });
    expect(await listRoutines(db, first.owner)).toEqual([routine]);
    expect(await listRoutines(db, other.owner)).toEqual([]);
    await expect(updateRoutine(db, other.owner, routine.id, { expectedRevision: 1, status: 'paused' }, now)).rejects.toThrow('routine_not_found');
    await expect(deleteRoutine(db, other.owner, routine.id, { expectedRevision: 1 })).rejects.toThrow('routine_not_found');
    await expect(createRoutine(db, other.owner, input(first.googleAccountId), now)).rejects.toThrow('routine_account_unavailable');
    await expect(withUser(db, other.owner, (tx) => tx.query(
      `insert into bob.routines (user_id,google_account_id,kind,local_time,time_zone,scheduled_read_consent,status,next_run_at)
       values ($1,$2,'daily_gmail_digest','08:00','UTC',true,'active',now())`,
      [other.owner, first.googleAccountId],
    ))).rejects.toMatchObject({ code: '23503' });
    expect(await withUser(db, other.owner, (tx) => tx.query('update bob.routines set status = $1, next_run_at = null where id = $2 returning id', ['paused', routine.id]))).toEqual([]);
    expect(await withUser(db, other.owner, (tx) => tx.query('delete from bob.routines where id = $1 returning id', [routine.id]))).toEqual([]);
    await expect(withUser(db, other.owner, (tx) => tx.query(
      `insert into bob.routines (user_id,google_account_id,kind,local_time,time_zone,scheduled_read_consent,status,next_run_at)
       values ($1,$2,'daily_gmail_digest','08:00','UTC',true,'active',now())`,
      [first.owner, first.googleAccountId],
    ))).rejects.toMatchObject({ code: '42501' });
  });

  it('serializes revision edits, pauses, resumes strictly in the future, and deletes conditionally', async () => {
    const { owner, googleAccountId } = await fixture();
    const routine = await createRoutine(db, owner, input(googleAccountId), now);
    const outcomes = await Promise.allSettled([
      updateRoutine(db, owner, routine.id, { expectedRevision: 1, status: 'paused' }, now),
      updateRoutine(db, owner, routine.id, { expectedRevision: 1, localTime: '09:00' }, now),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const paused = await updateRoutine(db, owner, routine.id, { expectedRevision: 2, status: 'paused' }, now);
    expect(paused.nextRunAt).toBeNull();
    const resumed = await updateRoutine(db, owner, routine.id, { expectedRevision: 3, status: 'active', localTime: '08:00' }, now + 8 * 3_600_000);
    expect(resumed.nextRunAt).toBe(now + 32 * 3_600_000);
    await expect(deleteRoutine(db, owner, routine.id, { expectedRevision: 3 })).rejects.toThrow('routine_revision_conflict');
    await deleteRoutine(db, owner, routine.id, { expectedRevision: 4 });
    expect(await listRoutines(db, owner)).toEqual([]);
  });

  it('requires requested Gmail access and cascades disconnect', async () => {
    const { owner, googleAccountId } = await fixture();
    const routine = await createRoutine(db, owner, input(googleAccountId), now);
    await withUser(db, owner, (tx) => tx.query('update bob.google_accounts set authorization_capabilities = null where id = $1', [googleAccountId]));
    await expect(createRoutine(db, owner, input(googleAccountId), now)).rejects.toThrow('routine_account_unavailable');
    await updateRoutine(db, owner, routine.id, { expectedRevision: 1, status: 'paused' }, now);
    await expect(updateRoutine(db, owner, routine.id, { expectedRevision: 2, status: 'active' }, now)).rejects.toThrow('routine_account_unavailable');
    expect(await listRoutines(db, owner)).toMatchObject([{ status: 'paused', revision: 2, nextRunAt: null }]);
    await deleteGoogleAccount(db, owner, googleAccountId);
    expect(await listRoutines(db, owner)).toEqual([]);
  });

  it('erases definitions with account content and leaves another owner intact', async () => {
    const first = await fixture();
    const other = await fixture();
    await createRoutine(db, first.owner, input(first.googleAccountId), now);
    const kept = await createRoutine(db, other.owner, input(other.googleAccountId), now);
    await eraseAccount({ db, userId: first.owner, now });
    await purgeAccountContent(db, first.owner, await accountTablesPresent(db));
    expect(await listRoutines(db, first.owner)).toEqual([]);
    expect(await listRoutines(db, other.owner)).toEqual([kept]);
  });

  it('does not expose database details when storage fails', async () => {
    const unavailable: Db = {
      query: async () => { throw new Error('sensitive database detail'); },
      tx: async () => { throw new Error('sensitive database detail'); },
    };
    await expect(listRoutines(unavailable, randomUUID())).rejects.toThrow('routine_storage_unavailable');
  });
});
