import { describe, expect, it } from 'vitest';
import { isLoopbackHost, isProduction, validToken } from '../../src/account/auth.ts';

describe('retained web-auth primitives (T011)', () => {
  it('validToken distinguishes missing, wrong, and matching tokens', () => {
    expect(validToken(undefined, 'secret')).toBe(false);
    expect(validToken('wrong', 'secret')).toBe(false);
    expect(validToken('secret', 'secret')).toBe(true);
    expect(validToken('secret', '')).toBe(false);
  });

  it('isLoopbackHost recognises only loopback addresses', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
  });

  it('isProduction reads BOB_PRODUCTION=1 only', () => {
    delete process.env.BOB_PRODUCTION;
    expect(isProduction()).toBe(false);
    process.env.BOB_PRODUCTION = '1';
    expect(isProduction()).toBe(true);
    process.env.BOB_PRODUCTION = '0';
    expect(isProduction()).toBe(false);
    delete process.env.BOB_PRODUCTION;
  });
});