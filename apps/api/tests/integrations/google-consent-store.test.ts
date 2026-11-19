import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser, type Db } from '../../src/platform/db/db.ts';
import { createGoogleConsentAttempt, consumeGoogleConsentAttempt } from '../../src/integrations/google-consent-store.ts';
import { addGoogleAccount, deleteGoogleAccount } from '../../src/integrations/google-store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

describe('durable Google consent intent', () => {
  let pg: TestDb;
  let db: Db;
  beforeAll(async () => { pg = await createTestDb(); db = asDb(pg); });
  afterAll(async () => { await closeTestDb(pg); });

  it('persists only hashed state and consumes once for its owner', async () => {
    const owner = await addAccount(pg);
    const other = await addAccount(pg);
    const attempt = await createGoogleConsentAttempt(db, owner.userId, { capabilities: ['gmail.read', 'gmail.draft'] });
    expect(attempt.subject).toMatch(/^gc_[A-Za-z0-9_-]{43}$/);
    const rows = await withUser(db, owner.userId, tx => tx.query<{ state_hash: string }>('select state_hash from bob.google_consent_attempts'));
    expect(rows).toEqual([{ state_hash: createHash('sha256').update(attempt.state).digest('hex') }]);
    expect(await consumeGoogleConsentAttempt(db, other.userId, attempt.state)).toBeNull();
    expect(await consumeGoogleConsentAttempt(db, owner.userId, attempt.state)).toEqual({
      subject: attempt.subject, capabilities: ['gmail.read', 'gmail.draft'], reconnectAccountId: null, expiresAt: attempt.expiresAt,
      completionHash: createHash('sha256').update(attempt.state).digest('hex'),
    });
    expect(await consumeGoogleConsentAttempt(db, owner.userId, attempt.state)).toBeNull();
  });

  it('allows exactly one concurrent callback and gives new connections distinct subjects', async () => {
    const owner = await addAccount(pg);
    const first = await createGoogleConsentAttempt(db, owner.userId, { capabilities: ['calendar.read'] });
    const second = await createGoogleConsentAttempt(db, owner.userId, { capabilities: ['calendar.read'] });
    expect(first.subject).not.toBe(second.subject);
    const results = await Promise.all(Array.from({ length: 5 }, () => consumeGoogleConsentAttempt(db, owner.userId, first.state)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('rejects expired and malformed state without wall-clock sleeps', async () => {
    const owner = await addAccount(pg);
    const state = randomBytes(32).toString('base64url');
    await withUser(db, owner.userId, tx => tx.query(
      `insert into bob.google_consent_attempts (user_id,state_hash,connect_subject,capabilities,expires_at)
       values ($1,$2,$3,array['gmail.read'],now()-interval '1 second')`,
      [owner.userId, createHash('sha256').update(state).digest('hex'), `gc_${randomBytes(32).toString('base64url')}`],
    ));
    expect(await consumeGoogleConsentAttempt(db, owner.userId, state)).toBeNull();
    expect(await consumeGoogleConsentAttempt(db, owner.userId, 'invalid')).toBeNull();
  });

  it('reconnects only an owned explicit subject and invalidates intent on unlink', async () => {
    const owner = await addAccount(pg);
    const other = await addAccount(pg);
    const legacy = await addGoogleAccount(db, owner.userId, { installationId: 'legacy', accountId: 'legacy', email: 'test@example.com' });
    await expect(createGoogleConsentAttempt(db, owner.userId, { capabilities: ['gmail.read'], reconnectAccountId: legacy.id })).rejects.toThrow('google_reconnect_unavailable');
    const subject = `gc_${randomBytes(32).toString('base64url')}`;
    const rows = await withUser(db, owner.userId, tx => tx.query<{ id: string }>(
      `insert into bob.google_accounts (user_id,installation_id,provider_account_id,email,connect_subject)
       values ($1,'explicit','provider','test@example.com',$2) returning id`, [owner.userId, subject],
    ));
    const id = rows[0]?.id;
    if (!id) throw new Error('fixture failed');
    await expect(createGoogleConsentAttempt(db, other.userId, { capabilities: ['gmail.read'], reconnectAccountId: id })).rejects.toThrow('google_reconnect_unavailable');
    const attempt = await createGoogleConsentAttempt(db, owner.userId, { capabilities: ['gmail.read'], reconnectAccountId: id });
    expect(attempt.subject).toBe(subject);
    await expect(withUser(db, owner.userId, tx => tx.query('update bob.google_accounts set connect_subject = $1 where id = $2', [`gc_${randomBytes(32).toString('base64url')}`, id]))).rejects.toThrow();
    await deleteGoogleAccount(db, owner.userId, id);
    expect(await consumeGoogleConsentAttempt(db, owner.userId, attempt.state)).toBeNull();
  });
});
