import { describe, expect, it } from 'vitest';
import { classifyDbError } from '../../../src/platform/db/db-error.ts';
import { isSupabaseDirectHost } from '../../../src/platform/db/db.ts';

const withCode = (code: string): Error => Object.assign(new Error('private connection details'), { code });

describe('classifyDbError (#1306)', () => {
  it.each([
    ['28P01', 'auth_failed'],
    ['28000', 'auth_failed'],
    ['ENOTFOUND', 'host_not_found'],
    ['EAI_AGAIN', 'host_not_found'],
    ['ECONNREFUSED', 'connection_refused'],
    ['ECONNRESET', 'connection_lost'],
    ['ETIMEDOUT', 'timeout'],
    ['57014', 'timeout'],
    ['42501', 'permission_denied'],
    ['3F000', 'schema_missing'],
    ['42P01', 'schema_missing'],
    ['XX000', 'unknown'],
  ])('maps driver code %s to %s', (code, reason) => {
    expect(classifyDbError(withCode(code))).toBe(reason);
  });

  it('finds the code inside a cause or an AggregateError', () => {
    expect(classifyDbError(new Error('wrapped', { cause: withCode('28P01') }))).toBe('auth_failed');
    expect(classifyDbError(new AggregateError([new Error('no code'), withCode('ECONNREFUSED')]))).toBe('connection_refused');
  });

  it('is unknown for anything without a recognised code, and never reads the message', () => {
    expect(classifyDbError(new Error('password authentication failed'))).toBe('unknown');
    expect(classifyDbError('ENOTFOUND')).toBe('unknown');
    expect(classifyDbError(null)).toBe('unknown');
  });
});

describe('isSupabaseDirectHost (#1306)', () => {
  it.each([
    ['postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres', true],
    ['postgresql://postgres:pw@DB.ABCDEFGHIJKLMNOP.SUPABASE.CO:5432/postgres', true],
    ['postgresql://postgres.abcdefghijklmnop:pw@aws-0-ca-central-1.pooler.supabase.com:5432/postgres', false],
    ['postgresql://postgres:postgres@127.0.0.1:54322/postgres', false],
    ['postgresql://u:pw@db.example.com:5432/postgres', false],
    ['postgresql://u:pw@db.abc.supabase.co.evil.example:5432/postgres', false],
    ['not a url', false],
    ['', false],
  ])('%s -> %s', (url, expected) => {
    expect(isSupabaseDirectHost(url)).toBe(expected);
  });
});
