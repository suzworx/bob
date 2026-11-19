/**
 * Account erasure core (S14-ERASURE, issue #143, specs/014-family-collaboration/
 * data-model.md "Retention, migration and portability"; S14-PG-ERASURE). Leaving
 * must be clean for everyone: the person's own content and connections go, but
 * the tasks they completed, the notes they edited and the messages others
 * replied to stay — with authorship anonymized rather than the work destroyed.
 * And an owner who still owns a group must transfer or delete it first, so a
 * household is never orphaned.
 *
 * eraseAccount is a single asServer call to bob_private.erase_account
 * (supabase/migrations/20260918000000_erase_account_definer.sql), which does
 * the guard, the sentinel insert and every data-access step as ONE definer
 * call: a partial erasure can never commit (the call is one implicit
 * transaction), an injected mid-way failure leaves NOTHING changed, and it is
 * idempotent — running it twice yields the same shape and touches nothing the
 * second time (all proven in erasure.test.ts).
 *
 * This moved server-side because a bare bob_server transaction cannot do
 * it: under FORCE RLS, bob_server (nobypassrls) sees zero rows in the
 * owned-groups guard, so EraseRefusedError could never fire, and
 * `INSERT INTO auth.users` as bob_server is refused outright. The definer
 * (owned by the migration owner, who bypasses the lock, exactly like the
 * outbox/invitations definers) fixes both.
 *
 * Extension points a later unit fills (named here, not stubbed):
 *   - Storage object purge: when Storage lands, delete the erased account's
 *     uploaded object blobs. This core touches only the database rows; a
 *     later unit walks the asset/album tables and calls the Storage API
 *     idempotently, most naturally from inside the same definer.
 * Push installations, receipts and recipient-bound push outbox work are purged
 * in the same erasure transaction. A push-specific session-age fence prevents
 * delayed registration from restoring the erased account's dormant channel.
 *
 * The sentinel account: the definer repoints authorship to a fixed sentinel
 * account and idempotently ensures its auth.users row exists (GoTrue-safe —
 * see the migration). Keep ERASED_USER_ID below in sync with the literal uuid
 * hardcoded in the migration.
 *
 * Journaling: one event with counts ONLY — rows anonymized, memberships
 * revoked, jobs invalidated — never a resource id, a space name or an email.
 */
import { moduleJournal } from '../platform/logger.ts';
import type { Db } from '../platform/db/db.ts';
import { ERASE_REFUSED_SQLSTATE, eraseAccountRow } from './erasure-store.ts';

const journal = moduleJournal('account');

/** The fixed anonymous/sentinel account authorship is repointed at on erasure. It
 *  never owns content; it only carries attribution for work the family retains.
 *  Must match the literal hardcoded in the erase_account migration. */
export const ERASED_USER_ID = '00000000-0000-4000-8000-0000000000de';

/** The named refusal for criterion 3: an owner who still solely owns a group must
 *  transfer or delete it first. Carries ONLY the count — never the group names, so
 *  a refusal cannot leak what the caller can no longer see. */
export class EraseRefusedError extends Error {
  override readonly name = 'EraseRefusedError';
  readonly count: number;
  constructor(count: number) {
    super(`account still owns ${count} group${count === 1 ? '' : 's'}; transfer or delete before erasing`);
    this.count = count;
  }
}

/** The typed result of a completed erasure: counts only, no identifiers. */
type EraseResult = {
  anonymized: number;
  assignmentsCleared: number;
  privateSpacesDeleted: number;
  membershipsRevoked: number;
  jobsInvalidated: number;
};

type EraseInput = {
  db: Db;
  userId: string;
  /** Epoch-ms clock, injectable so revocation timestamps are deterministic. */
  now: number;
};

/** True when `err` is the definer's refusal (SQLSTATE OX001), narrowed enough
 *  to read `.detail` (postgres.js surfaces both directly on the thrown error;
 *  see apps/api/src/conversations/thread-store.ts and friends for the same cast style). */
function isEraseRefusal(err: unknown): err is { code: string; detail?: unknown } {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === ERASE_REFUSED_SQLSTATE
  );
}

/** Erases an account's reach in one definer call. Refuses (EraseRefusedError)
 *  when the account still solely owns a group. Idempotent: a second call
 *  repoints, clears and revokes nothing (the rows already moved to the
 *  sentinel or were revoked) and returns the same shape. Journals one
 *  counts-only event — never on a refused or thrown call. */
export async function eraseAccount({ db, userId, now }: EraseInput): Promise<EraseResult> {
  let counts: Awaited<ReturnType<typeof eraseAccountRow>>;
  try {
    counts = await eraseAccountRow(db, userId, now);
  } catch (err) {
    if (isEraseRefusal(err)) {
      const count = Number(err.detail);
      throw new EraseRefusedError(Number.isFinite(count) ? count : 0);
    }
    throw err;
  }
  const result: EraseResult = {
    anonymized: counts.anonymized,
    assignmentsCleared: counts.assignmentsCleared,
    privateSpacesDeleted: counts.privateSpacesDeleted,
    membershipsRevoked: counts.membershipsRevoked,
    jobsInvalidated: counts.jobsInvalidated,
  };
  // Journal only what committed: a refused or thrown erasure never emits.
  journal('v2.erasure', result);
  return result;
}
