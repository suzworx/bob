import { describe, expect, it } from 'vitest';
import net from 'node:net';
import {
  DEFAULT_WEB_PORT,
  bindAdvice,
  checkPorts,
  isPrivilegedPort,
  resolvePort,
} from './dev-ports.mjs';

describe('resolvePort', () => {
  it('falls back when the variable is unset or empty', () => {
    expect(resolvePort(undefined, DEFAULT_WEB_PORT)).toBe(5173);
    expect(resolvePort('', DEFAULT_WEB_PORT)).toBe(5173);
    expect(resolvePort(null, 8443)).toBe(8443);
  });

  it('accepts a valid port', () => {
    expect(resolvePort('8443', DEFAULT_WEB_PORT)).toBe(8443);
    expect(resolvePort('1', DEFAULT_WEB_PORT)).toBe(1);
    expect(resolvePort('65535', DEFAULT_WEB_PORT)).toBe(65535);
  });

  it('throws rather than silently falling back on a bad value', () => {
    expect(() => resolvePort('0', 443)).toThrow(/Invalid port/);
    expect(() => resolvePort('65536', 443)).toThrow(/Invalid port/);
    expect(() => resolvePort('https', 443)).toThrow(/Invalid port/);
    expect(() => resolvePort('8443.5', 443)).toThrow(/Invalid port/);
  });
});

describe('isPrivilegedPort', () => {
  it('classifies ports below 1024 as privileged, and the default as not', () => {
    expect(isPrivilegedPort(DEFAULT_WEB_PORT)).toBe(false);
    expect(isPrivilegedPort(80)).toBe(true);
    expect(isPrivilegedPort(443)).toBe(true);
    expect(isPrivilegedPort(1023)).toBe(true);
    expect(isPrivilegedPort(1024)).toBe(false);
    expect(isPrivilegedPort(8443)).toBe(false);
  });
});

describe('checkPorts', () => {
  it('reports nothing when a port is free', async () => {
    expect(await checkPorts([0])).toEqual([]);
  });

  it('reports EADDRINUSE for a port already held', async () => {
    const held = net.createServer();
    await new Promise((resolve) => held.listen(0, '0.0.0.0', resolve));
    const { port } = held.address();
    try {
      const failures = await checkPorts([port]);
      expect(failures).toEqual([{ port, code: 'EADDRINUSE' }]);
    } finally {
      await new Promise((resolve) => held.close(resolve));
    }
  });
});

describe('bindAdvice', () => {
  it('explains a busy port and names the ways out', () => {
    const advice = bindAdvice([{ port: 5173, code: 'EADDRINUSE' }], 'darwin');
    expect(advice).toContain('EADDRINUSE');
    expect(advice).toContain('lsof');
    expect(advice).toContain('npm run cleanup');
    expect(advice).toContain('BOB_WEB_PORT=5174');
  });

  it('points at the unprivileged default when a chosen port is denied', () => {
    const advice = bindAdvice([{ port: 443, code: 'EACCES' }], 'darwin');
    expect(advice).toContain('EACCES');
    expect(advice).toContain('BOB_WEB_PORT');
    expect(advice).not.toContain('pfctl');
    expect(advice).not.toContain('sudo');
  });

  it('gives Windows the same busy-port guidance without lsof', () => {
    const advice = bindAdvice([{ port: 5173, code: 'EADDRINUSE' }], 'win32');
    expect(advice).toContain('EADDRINUSE');
    expect(advice).not.toContain('lsof');
  });
});
