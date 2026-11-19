import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { createScopeChecker, parseOperatorIds, requireScope } from '../../src/platform/observability/operator-gate.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('parseOperatorIds', () => {
  it('gives an empty set for unset and empty input', () => {
    expect(parseOperatorIds(undefined).size).toBe(0);
    expect(parseOperatorIds('').size).toBe(0);
    expect(parseOperatorIds(' , ,').size).toBe(0);
  });

  it('trims, lower-cases and de-duplicates', () => {
    const ids = parseOperatorIds(` ${A.toUpperCase()} , ${B},${A}`);
    expect([...ids].sort()).toEqual([A, B]);
  });

  it('throws on a malformed entry without echoing it', () => {
    const bad = 'not-a-uuid-secret-value';
    let message = '';
    try {
      parseOperatorIds(`${A},${bad}`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('BOB_OPERATOR_USER_IDS');
    expect(message).not.toContain(bad);
    expect(message).not.toContain(A);
  });
});

async function run(check: (userId: string) => Promise<boolean>, account: { userId: string } | undefined) {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  const next = vi.fn();
  await requireScope('metrics.operator', check)(
    { account } as unknown as Request,
    { status, json } as unknown as Response,
    next as NextFunction,
  );
  return { status, json, next };
}

describe('requireScope', () => {
  afterEach(() => setJournalSink(null));

  it('answers 404 not_found for a missing account without calling the checker', async () => {
    const check = vi.fn(async () => true);
    const { status, json, next } = await run(check, undefined);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: { code: 'not_found' } });
    expect(next).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it('answers 404 when the checker returns false', async () => {
    const { status, next } = await run(async () => false, { userId: A });
    expect(status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when the checker returns true', async () => {
    const check = vi.fn(async () => true);
    const { status, next } = await run(check, { userId: A });
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledWith(A);
  });

  it('fails closed with one journal line carrying only the error name', async () => {
    const lines: string[] = [];
    setJournalSink((line) => lines.push(line));
    class ProbeError extends Error {
      override name = 'ProbeError';
    }
    const { status, json, next } = await run(async () => { throw new ProbeError(`secret ${A}`); }, { userId: A });
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: { code: 'not_found' } });
    expect(next).not.toHaveBeenCalled();
    const mine = lines.filter((l) => l.includes('v2.operator_scope_check_failed'));
    expect(mine).toHaveLength(1);
    const entry = JSON.parse(mine[0] as string) as Record<string, unknown>;
    const allowed = new Set(['ts', 'level', 'event', 'message', 'error', 'trace_id', 'span_id', 'source', 'module', 'conversation_id', 'conversation_source']);
    expect(Object.keys(entry).filter((key) => !allowed.has(key))).toEqual([]);
    expect(entry).toMatchObject({ event: 'v2.operator_scope_check_failed', error: 'ProbeError' });
    expect(entry.message).toBe('v2.operator_scope_check_failed');
    expect(entry).not.toHaveProperty('user_id');
    expect(entry).not.toHaveProperty('acct');
    expect(mine[0]).not.toContain(A);
    expect(mine[0]).not.toContain('secret');
  });
});

function fakeDb(answers: Array<boolean | Error>) {
  const query = vi.fn(async () => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return [{ ok: next === true }];
  });
  return { db: { query, tx: async () => { throw new Error('unused'); } } as unknown as Db, query };
}

describe('createScopeChecker', () => {
  afterEach(() => vi.useRealTimers());

  it('memoises true and false per user for 60 seconds, then asks again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { db, query } = fakeDb([true, false, false, true]);
    const check = createScopeChecker(async () => db);
    expect(await check(A)).toBe(true);
    expect(await check(B)).toBe(false);
    expect(await check(A)).toBe(true);
    expect(await check(B)).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]).toEqual([expect.stringContaining('bob_private.user_has_scope'), [A, 'metrics.operator']]);
    vi.advanceTimersByTime(61_000);
    expect(await check(B)).toBe(false);
    expect(await check(A)).toBe(true);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('does not cache a database error', async () => {
    const { db, query } = fakeDb([new Error('down'), true]);
    const check = createScopeChecker(async () => db);
    await expect(check(A)).rejects.toThrow('down');
    expect(await check(A)).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
