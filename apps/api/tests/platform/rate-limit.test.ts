import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setJournalSink } from '../../src/platform/logger.ts';
import {
  clientIp,
  createApiRateLimitMiddleware,
  createDeviceUpgradeGuard,
  createTokenBucket,
  hashIp,
  holdForSocketLife,
} from '../../src/platform/http/rate-limit.ts';

afterEach(() => {
  delete process.env.BOB_PRODUCTION;
  delete process.env.BOB_RATE_LIMIT_API_RPM;
  delete process.env.BOB_RATE_LIMIT_DEVICE_RPM;
  delete process.env.BOB_MAX_DEVICE_SESSIONS;
  delete process.env.BOB_CLIENT_IP_HEADER;
});

interface FakeHttpResponse {
  statusCode: number;
  status(code: number): FakeHttpResponse;
  json(): FakeHttpResponse;
  reject(code?: number, message?: string): void;
}

function httpResponse(): FakeHttpResponse {
  return {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json() { return this; },
    reject(code?: number) { if (code) this.statusCode = code; },
  };
}

describe('rate limiting', () => {
  it('allows the bucket capacity then rejects the next take', () => {
    const bucket = createTokenBucket(3);
    expect(bucket.take('a')).toBe(true);
    expect(bucket.take('a')).toBe(true);
    expect(bucket.take('a')).toBe(true);
    expect(bucket.take('a')).toBe(false);
    expect(bucket.take('b')).toBe(true);
  });
  it('refills tokens as time passes', () => {
    vi.useFakeTimers();
    try {
      const bucket = createTokenBucket(1);
      expect(bucket.take('a')).toBe(true);
      expect(bucket.take('a')).toBe(false);
      vi.advanceTimersByTime(60_000);
      expect(bucket.take('a')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('refills fractional tokens so frequent callers regain a token once empty', () => {
    vi.useFakeTimers();
    try {
      const bucket = createTokenBucket(60);
      for (let i = 0; i < 60; i += 1) expect(bucket.take('a')).toBe(true);
      expect(bucket.take('a')).toBe(false);
      // 500ms later: 0.5 tokens accrued (partial progress kept), still < 1.
      vi.setSystemTime(Date.now() + 500);
      expect(bucket.take('a')).toBe(false);
      // 1000ms after exhaustion: >= 1 token accrued, allowed.
      vi.setSystemTime(Date.now() + 500);
      expect(bucket.take('a')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('never exceeds MAX_TRACKED_KEYS even with many distinct keys', () => {
    const bucket = createTokenBucket(10);
    for (let i = 0; i < 10_001; i += 1) bucket.take(`key-${i}`);
    expect(bucket.size()).toBeLessThanOrEqual(10_000);
  });
  it('rejects /api/* bursts over the configured rate with 429', () => {
    process.env.BOB_RATE_LIMIT_API_RPM = '3';
    const middleware = createApiRateLimitMiddleware();
    const next = vi.fn();
    for (let i = 0; i < 3; i += 1) middleware({ socket: { remoteAddress: '10.0.0.1' }, get: () => undefined } as never, httpResponse() as never, next);
    expect(next).toHaveBeenCalledTimes(3);
    const res = httpResponse();
    middleware({ socket: { remoteAddress: '10.0.0.1' }, get: () => undefined } as never, res as never, next);
    expect(res.statusCode).toBe(429);
  });
  describe('device upgrade guard (#708)', () => {
    /** A fake upgrade request whose socket can close like a real one. */
    function upgradeRequest(destroyed = false): { request: never; socket: EventEmitter & { destroyed: boolean } } {
      const socket = Object.assign(new EventEmitter(), { remoteAddress: '10.0.0.2', destroyed });
      return { request: { socket, get: () => undefined } as never, socket };
    }

    it('holds no slot for a socket that is already destroyed', () => {
      const onRelease = vi.fn();
      expect(holdForSocketLife(upgradeRequest(true).socket, onRelease)).toBeNull();
      expect(onRelease).not.toHaveBeenCalled();
    });

    it('releases a held slot once when its socket closes', () => {
      const onRelease = vi.fn();
      const { socket } = upgradeRequest();
      expect(holdForSocketLife(socket, onRelease)).toBeTypeOf('function');
      expect(onRelease).not.toHaveBeenCalled();
      socket.emit('close');
      socket.emit('close');
      expect(onRelease).toHaveBeenCalledTimes(1);
    });

    it('releases a held slot once when released twice and then closed', () => {
      const onRelease = vi.fn();
      const { socket } = upgradeRequest();
      const release = holdForSocketLife(socket, onRelease)!;
      release();
      release();
      socket.emit('close');
      expect(onRelease).toHaveBeenCalledTimes(1);
    });

    it('rejects a new device upgrade over the concurrency cap with 503', () => {
      process.env.BOB_MAX_DEVICE_SESSIONS = '2';
      const lines: string[] = [];
      setJournalSink((line) => lines.push(line));
      try {
        const upgrade = createDeviceUpgradeGuard();
        const next = vi.fn();
        upgrade.guard(upgradeRequest().request, httpResponse() as never, next);
        upgrade.guard(upgradeRequest().request, httpResponse() as never, next);
        expect(next).toHaveBeenCalledTimes(2);
        const res = httpResponse();
        upgrade.guard(upgradeRequest().request, res as never, next);
        expect(res.statusCode).toBe(503);
        expect(next).toHaveBeenCalledTimes(2);
        const limited = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry.event === 'v2.rate_limited');
        expect(limited).toMatchObject({ reason: 'concurrency', active: 2 });
        expect(JSON.stringify(limited)).not.toContain('10.0.0.2');
      } finally {
        setJournalSink(null);
      }
    });

    it('frees one slot only when an attempt is released twice', () => {
      process.env.BOB_MAX_DEVICE_SESSIONS = '2';
      const upgrade = createDeviceUpgradeGuard();
      const first = upgradeRequest();
      upgrade.guard(first.request, httpResponse() as never, vi.fn());
      upgrade.guard(upgradeRequest().request, httpResponse() as never, vi.fn());
      expect(upgrade.active()).toBe(2);
      upgrade.releaseFor(first.request)();
      upgrade.releaseFor(first.request)();
      first.socket.emit('close');
      expect(upgrade.active()).toBe(1);
    });

    it('frees the slot when the upgrade socket closes before accept', () => {
      process.env.BOB_MAX_DEVICE_SESSIONS = '1';
      const upgrade = createDeviceUpgradeGuard();
      const aborted = upgradeRequest();
      upgrade.guard(aborted.request, httpResponse() as never, vi.fn());
      expect(upgrade.active()).toBe(1);
      aborted.socket.emit('close');
      expect(upgrade.active()).toBe(0);
      const next = vi.fn();
      upgrade.guard(upgradeRequest().request, httpResponse() as never, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('never takes a slot for a socket already dead when the guard runs', () => {
      process.env.BOB_MAX_DEVICE_SESSIONS = '1';
      const upgrade = createDeviceUpgradeGuard();
      const next = vi.fn();
      upgrade.guard(upgradeRequest(true).request, httpResponse() as never, next);
      expect(next).not.toHaveBeenCalled();
      expect(upgrade.active()).toBe(0);
    });
  });
  it('uses the socket address when BOB_CLIENT_IP_HEADER is unset, even in production', () => {
    const forwarded = { socket: { remoteAddress: '1.2.3.4' }, get: (name: string) => (name.toLowerCase() === 'cf-connecting-ip' ? '203.0.113.9' : undefined) } as never;
    process.env.BOB_PRODUCTION = '1';
    expect(clientIp(forwarded)).toBe('1.2.3.4');
  });
  it('uses the first comma-separated entry of the configured header, else the socket address', () => {
    const socketOnly = { socket: { remoteAddress: '1.2.3.4' }, get: () => undefined } as never;
    expect(clientIp(socketOnly)).toBe('1.2.3.4');
    process.env.BOB_CLIENT_IP_HEADER = 'x-forwarded-for';
    const forwarded = { socket: { remoteAddress: '1.2.3.4' }, get: (name: string) => (name.toLowerCase() === 'x-forwarded-for' ? 'a, b' : undefined) } as never;
    expect(clientIp(forwarded)).toBe('a');
    expect(clientIp(socketOnly)).toBe('1.2.3.4');
  });
  it('hashes an IP to a short value that never equals the raw address', () => {
    const ip = '203.0.113.9';
    const hashed = hashIp(ip);
    expect(hashed).toMatch(/^[0-9a-f]{8}$/);
    expect(hashed).not.toContain(ip);
  });
});