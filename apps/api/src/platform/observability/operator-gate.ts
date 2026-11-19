/**
 * The operator gate: the scope `metrics.operator` on an account
 * (bob.user_scopes, read through bob_private.user_has_scope), plus an
 * optional emergency allowlist of account ids in BOB_OPERATOR_USER_IDS.
 * A caller without access gets the same 404 an unknown route gets, so the
 * surface is never advertised, and a failing check fails closed.
 */
import type { RequestHandler } from 'express';
import { createMemoCache } from '../cache/memo-cache.ts';
import { asServer, type Db } from '../db/db.ts';
import { moduleJournal } from '../logger.ts';

const journal = moduleJournal('platform');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OPERATOR_SCOPE = 'metrics.operator';

/** Parses the comma-separated allowlist. A malformed entry throws without
 *  echoing the entry, so the server refuses to start and no id reaches a log. */
export function parseOperatorIds(raw: string | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    if (!UUID.test(entry)) {
      throw new Error('BOB_OPERATOR_USER_IDS must be a comma-separated list of account uuids');
    }
    ids.add(entry.toLowerCase());
  }
  return ids;
}

/** Runs after the JWT guard: no account, a false check, or a check that throws
 *  all answer 404 not_found, never 401 or 403. Only the error name is logged. */
export function requireScope(scope: string, check: (userId: string) => Promise<boolean>): RequestHandler {
  return async (request, response, next) => {
    const userId = request.account?.userId;
    if (userId === undefined) {
      response.status(404).json({ error: { code: 'not_found' } });
      return;
    }
    let allowed = false;
    try {
      allowed = await check(userId);
    } catch (error) {
      journal('v2.operator_scope_check_failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
    if (!allowed) {
      response.status(404).json({ error: { code: 'not_found' } });
      return;
    }
    next();
  };
}

/** Asks the database whether an account holds a scope, memoised per account for
 *  60 seconds by default: a grant or revoke takes effect within a minute. A
 *  database error rejects and is never cached. */
export function createScopeChecker(
  getDb: () => Promise<Db>,
  opts: { ttlMs?: number; scope?: string } = {},
): (userId: string) => Promise<boolean> {
  const scope = opts.scope ?? OPERATOR_SCOPE;
  const cache = createMemoCache<boolean>({ max: 500, ttlMs: opts.ttlMs ?? 60_000 });
  return async (userId) => {
    const { value } = await cache.getOrCreate(`${userId.toLowerCase()}|${scope}`, async () => {
      const db = await getDb();
      const rows = await asServer(db, (s) =>
        s.query<{ ok: boolean }>('SELECT bob_private.user_has_scope($1::uuid, $2::text) AS ok', [userId, scope]),
      );
      return rows[0]?.ok === true;
    });
    return value;
  };
}
