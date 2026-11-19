/**
 * In-memory token-bucket rate limiting, keyed by client IP with no dependency.
 * Backing an IPv4/IPv6 address into a hash keeps raw IPs out of the journal.
 */
import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { WSResponse } from 'websocket-express';
import { moduleJournal } from '../logger.ts';

const journal = moduleJournal('platform');

const API_RPM_DEFAULT = 120;
const DEVICE_RPM_DEFAULT = 20;
const DEVICE_SESSIONS_DEFAULT = 3;
const MAX_TRACKED_KEYS = 10_000;

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolves the caller's address. When BOB_CLIENT_IP_HEADER names a header,
 * the first comma-separated entry of that header is used (trimmed), falling
 * back to the socket address when the header is missing or empty. When the
 * env is unset or empty, the socket address is always used so no header is
 * trusted implicitly. The env is read on every call so tests can toggle it.
 */
export function clientIp(request: Request): string {
  const headerName = process.env.BOB_CLIENT_IP_HEADER;
  if (headerName) {
    const header = request.get(headerName);
    if (header) {
      const first = header.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  return request.socket.remoteAddress ?? '';
}

/** Short, stable hash of an address for journaling; never the raw IP. */
export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 8);
}

interface Bucket {
  tokens: number;
  last: number;
}

/** A token bucket per key, refilling one token per `60000/rate` milliseconds. */
export function createTokenBucket(ratePerMinute: number): { take: (key: string) => boolean; size: () => number } {
  const capacity = ratePerMinute;
  const refillMs = 60000 / ratePerMinute;
  const buckets = new Map<string, Bucket>();
  const evictStale = (now: number): void => {
    if (buckets.size < MAX_TRACKED_KEYS) return;
    for (const [key, bucket] of buckets) {
      if (buckets.size < MAX_TRACKED_KEYS) return;
      if (now - bucket.last >= capacity * refillMs) buckets.delete(key);
    }
    while (buckets.size >= MAX_TRACKED_KEYS) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  };
  return {
    size(): number {
      return buckets.size;
    },
    take(key: string): boolean {
      const now = Date.now();
      let bucket = buckets.get(key);
      if (!bucket) {
        evictStale(now);
        buckets.set(key, { tokens: capacity - 1, last: now });
        return true;
      }
      bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.last) / refillMs);
      bucket.last = now;
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
  };
}

/** Per-IP HTTP guard for /api/*; rejects bursts over the rate with 429. */
export function createApiRateLimitMiddleware() {
  const bucket = createTokenBucket(envInt('BOB_RATE_LIMIT_API_RPM', API_RPM_DEFAULT));
  return (request: Request, response: Response, next: NextFunction): void => {
    const ip = clientIp(request);
    if (!bucket.take(ip)) {
      journal('v2.rate_limited', { route: '/api', ip_hash: hashIp(ip) });
      response.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests.' } });
      return;
    }
    next();
  };
}

/** The part of a connection socket a slot needs: whether it is gone, and its close. */
export interface SlotSocket {
  readonly destroyed: boolean;
  once(event: 'close', listener: () => void): unknown;
}

/**
 * Ties a counted slot to one socket's life (#708). Returns an idempotent
 * release that runs `onRelease` exactly once: when called, or when the socket
 * closes. Returns null for a socket already destroyed, whose close has fired
 * and would never reach a listener: the caller must take no slot then.
 */
export function holdForSocketLife(socket: SlotSocket, onRelease: () => void): (() => void) | null {
  if (socket.destroyed) return null;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    onRelease();
  };
  socket.once('close', release);
  return release;
}

export interface DeviceUpgradeGuard {
  guard: (request: Request, response: WSResponse, next: NextFunction) => void;
  /** The idempotent release of the slot this upgrade attempt holds (a no-op if it holds none). */
  releaseFor: (request: Request) => () => void;
  /** Slots currently held. */
  active: () => number;
}

/**
 * Guard for /v2/cardputer WebSocket upgrades: per-IP rate limit (429) and a
 * global cap on concurrent device sessions (503). A slot belongs to one
 * upgrade attempt (#708): it is freed exactly once, when that attempt's TCP
 * socket closes (abort before accept, a failed accept or the session's end) or
 * when the accept handler releases it early. A socket already dead when the
 * guard runs never takes a slot, since its close has already fired.
 */
export function createDeviceUpgradeGuard(): DeviceUpgradeGuard {
  const bucket = createTokenBucket(envInt('BOB_RATE_LIMIT_DEVICE_RPM', DEVICE_RPM_DEFAULT));
  const maxSessions = envInt('BOB_MAX_DEVICE_SESSIONS', DEVICE_SESSIONS_DEFAULT);
  const releases = new WeakMap<Request, () => void>();
  let active = 0;
  return {
    guard(request: Request, response: WSResponse, next: NextFunction): void {
      const ip = clientIp(request);
      if (!bucket.take(ip)) {
        journal('v2.rate_limited', { route: '/v2/cardputer', ip_hash: hashIp(ip) });
        response.reject(429, 'rate_limited');
        return;
      }
      if (active >= maxSessions) {
        journal('v2.rate_limited', { route: '/v2/cardputer', ip_hash: hashIp(ip), reason: 'concurrency', active });
        response.reject(503, 'too_many_sessions');
        return;
      }
      const release = holdForSocketLife(request.socket, () => { active -= 1; });
      if (release === null) {
        // The upgrade cannot be accepted any more: same event as a failed accept.
        journal('v2.accept_failed', { error_name: 'SocketClosed' });
        return;
      }
      active += 1;
      releases.set(request, release);
      next();
    },
    releaseFor(request: Request): () => void {
      return releases.get(request) ?? ((): void => undefined);
    },
    active(): number {
      return active;
    },
  };
}