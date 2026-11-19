/**
 * The email exactly-once marker on bob.outbox (20261003110000_outbox_email_marker,
 * #757 merge 6 expand) on real Postgres: every earlier migration is applied and old
 * bob.email_effects rows are seeded, then the migration runs (twice). The
 * backfill keeps every row, mark/sent/purge read the outbox columns while still
 * honouring the old table, and no account role can read either new column.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from '../support/pg-template.ts';

const dir = new URL('../../../../supabase/migrations/', import.meta.url);
const MARKER = '20261003110000_outbox_email_marker.sql';
const U = (n: number): string => `00000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
const [A, B, C, D] = [U(0xa1), U(0xa2), U(0xa3), U(0xa4)];
const SENT_AT = '2026-09-30 10:00:00+00';

const seedOutbox = (key: string): string => `insert into bob.outbox
  (event_type, resource_type, resource_id, effect_key, payload)
  values ('email.notification', 'notification', gen_random_uuid(), '${key}',
          '{"resource_type":"notification","event_type":"email.notification"}')`;

describe('outbox email marker (#757 merge 6 expand)', () => {
  let db: TestDb;
  const rows = async <T,>(sql: string): Promise<T[]> => (await db.query<T>(sql)).rows;
  const one = async <T,>(sql: string): Promise<T> => (await rows<{ v: T }>(`select (${sql}) as v`))[0]!.v;
  const mark = (key: string, user: string): Promise<boolean> => one(`bob_private.email_effect_mark('${key}', '${user}')`);
  const sent = (key: string): Promise<boolean> => one(`bob_private.email_effect_sent('${key}')`);
  const apply = async (): Promise<void> =>
    void (await db.transaction(async (tx) => void (await tx.exec(readFileSync(new URL(MARKER, dir), 'utf8')))));

  beforeAll(async () => {
    db = await createMigratedDb({ before: MARKER });
    await db.exec(`insert into auth.users (id) values ('${A}'), ('${B}'), ('${C}'), ('${D}');
      ${seedOutbox('email:old1')}; ${seedOutbox('email:old2')}; ${seedOutbox('email:old3')};
      insert into bob.email_effects (effect_key, recipient_user_id, sent_at) values
        ('email:old1', '${A}', '${SENT_AT}'), ('email:old2', '${B}', '${SENT_AT}'), ('email:old3', '${A}', now());`);
    await apply();
    await apply();
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('backfills every email_effects row onto its outbox row, count and values, and re-runs cleanly', async () => {
    expect(await one<number>('select count(*)::int from bob.email_effects')).toBe(3);
    expect(await one<number>('select count(*)::int from bob.outbox where email_sent_at is not null')).toBe(3);
    expect(await one<number>(`select count(*)::int from bob.email_effects e join bob.outbox o using (effect_key)
      where o.email_sent_at = e.sent_at and o.recipient_user_id = e.recipient_user_id`)).toBe(3);
    expect(await one<boolean>(`(select email_sent_at = '${SENT_AT}' from bob.outbox where effect_key = 'email:old1')`)).toBe(true);
  });

  it('mark is idempotent: true once, then false, and sent follows', async () => {
    await db.exec(seedOutbox('email:new1'));
    expect(await sent('email:new1')).toBe(false);
    expect(await mark('email:new1', A)).toBe(true);
    expect(await mark('email:new1', A)).toBe(false);
    expect(await sent('email:new1')).toBe(true);
    expect(await sent('email:never')).toBe(false);
  });

  it('sent is true for a key that exists only in the old table', async () => {
    await db.exec(`insert into bob.email_effects (effect_key, recipient_user_id) values ('email:oldonly', '${A}')`);
    expect(await sent('email:oldonly')).toBe(true);
  });

  it('a crash between send and ack never mails twice', async () => {
    await db.exec(seedOutbox('email:crash'));
    const claim = (owner: string, minutes: number): Promise<{ k: string }[]> => rows(
      `select "effectKey" as k from bob_private.outbox_claim_batch('${owner}', 100, 1000, now() + interval '${minutes} minutes')`);
    expect((await claim('w1', 1)).map((r) => r.k)).toContain('email:crash');
    expect(await sent('email:crash')).toBe(false);
    expect(await mark('email:crash', B)).toBe(true);
    await db.exec(`select bob_private.outbox_reclaim_expired(now() + interval '10 minutes')`);
    expect((await claim('w2', 11)).map((r) => r.k)).toContain('email:crash');
    expect(await sent('email:crash')).toBe(true);
    expect(await mark('email:crash', B)).toBe(false);
  });

  it('purge removes only that user\'s rows', async () => {
    for (const k of ['p1', 'p2', 'p3']) await db.exec(seedOutbox(`email:${k}`));
    await mark('email:p1', C);
    await mark('email:p2', C);
    await mark('email:p3', D);
    expect(await one<number>(`bob_private.purge_account_email_effects('${C}')`)).toBe(2);
    expect(await rows(`select effect_key from bob.outbox where effect_key in ('email:p1', 'email:p2', 'email:p3')`))
      .toEqual([{ effect_key: 'email:p3' }]);
    expect(await sent('email:p3')).toBe(true);
    await db.exec(`insert into bob.email_effects (effect_key, recipient_user_id) values ('email:oldC', '${C}')`);
    await db.exec(`select bob_private.purge_account_email_effects('${C}')`);
    expect(await one<number>(`select count(*)::int from bob.email_effects where recipient_user_id = '${C}'`)).toBe(0);
  });

  it('an authenticated account reads neither column of anyone\'s row, nor calls the definers', async () => {
    await db.exec(`set request.jwt.claim.sub = '${B}'; set role authenticated`);
    try {
      for (const col of ['email_sent_at', 'recipient_user_id']) {
        await expect(db.query(`select ${col} from bob.outbox`)).rejects.toThrow(/permission denied/i);
      }
      await expect(db.query(`select bob_private.email_effect_sent('email:old1')`)).rejects.toThrow(/permission denied/i);
    } finally {
      await db.exec('reset role; reset request.jwt.claim.sub');
    }
  });
});
