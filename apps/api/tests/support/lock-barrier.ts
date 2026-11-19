import type { TestDb } from './test-db.ts';

/**
 * Polls pg_stat_activity until a backend is blocked on a row lock, proving that
 * a competing store call has reached its SELECT...FOR UPDATE and is waiting for
 * the current transaction to release the lock. Used to make race tests
 * deterministic: instead of sleeping ~300ms and hoping the competing call blocked,
 * wait until we know it did.
 *
 * Throws if no lock waiter appears within timeoutMs.
 */
export async function waitForLockWaiter(pg: TestDb, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  const pollIntervalMs = 50;

  while (Date.now() - start < timeoutMs) {
    const result = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database()
       AND wait_event_type = 'Lock'`,
    );
    const n = result.rows[0]?.n ?? 0;
    if (n >= 1) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`no backend blocked on a row lock within ${timeoutMs} ms`);
}
