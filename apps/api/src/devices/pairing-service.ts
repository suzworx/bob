/**
 * Transport-agnostic pairing service (T017, specs/008-supabase-auth-pairing,
 * plan.md §D). Owns user-code generation and normalization, the rate-limited
 * code lookup, approval/denial, the in-process delivery registry (pairing_id →
 * waiting socket with its claim), and same-boot resume.
 *
 * It never talks to a socket directly: every push goes through a registered
 * `send` callback supplied by the session layer (T018). Raw codes, claims, and
 * tokens never enter the journal or SQL — only their SHA-256 hashes do
 * (FR-014, R8, R15). Accounts appear only as `acct=<first 8 hex of sha256>`
 * (R15).
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { AccountEvents } from '../account/events-bus.ts';
import { moduleJournal } from '../platform/logger.ts';
import { toSpanAttrs, traceSpan } from '@bob/ai';
import { type Db } from '../platform/db/db.ts';
import {
  approvePairing,
  claimPairing,
  denyPairing,
  issuePairing,
  lookupPairing,
  PairingCodeCollisionError,
  PairingNotFoundError,
  sha256,
} from './pairing-store.ts';

const journal = moduleJournal('devices');

const PAIRING_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const PAIRING_CODE_LENGTH = 8;
const PAIRING_TTL_SECONDS = 600;
const PAIRING_MAX_LOOKUP_FAILURES = 5;
const PAIRING_LOOKUP_WINDOW_MS = 15 * 60 * 1000;

type Clock = () => number;

/** Raised for a non-normalizable code; never counts a failure (FR-015). */
export class InvalidCodeError extends Error {
  constructor() {
    super('invalid pairing code');
    this.name = 'InvalidCodeError';
  }
}

/** Raised when the account or the IP exceeds the lookup failure budget. */
export class PairingRateLimitedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('pairing code entry rate limited');
    this.name = 'PairingRateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 8 characters from the no-lookalike alphabet, displayed as XXXX-XXXX. */
export function generateUserCode(): string {
  let raw = '';
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    raw += PAIRING_CODE_ALPHABET.charAt(randomInt(PAIRING_CODE_ALPHABET.length));
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Uppercases and strips hyphens/spaces; null unless exactly 8 alphabet chars. */
export function normalizeUserCode(input: string): string | null {
  const normalized = input.toUpperCase().replace(/[-\s]/g, '');
  if (normalized.length !== PAIRING_CODE_LENGTH) return null;
  return /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(normalized) ? normalized : null;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** R15: an account appears only as the first 8 hex of its id's sha256. */
function accountTag(userId: string): string {
  return `acct=${sha256Hex(userId).slice(0, 8)}`;
}

interface IssueCodeInput {
  model: string;
  fwVersion: string;
  claim: string;
  ip: string;
}

interface IssueCodeResult {
  pairingId: string;
  userCode: string;
  expiresIn: 600;
}

/**
 * Issues a pending pairing, retrying with a fresh code up to 3 times on a
 * pending-code collision (data-model §2.5). Only the hashes are stored.
 */
export async function issueCode(
  db: Db,
  input: IssueCodeInput,
  options: { generateCode?: () => string } = {},
): Promise<IssueCodeResult> {
  const generateCode = options.generateCode ?? generateUserCode;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const userCode = generateCode();
    try {
      const pairingId = await issuePairing(db, {
        codeHash: sha256(normalizeUserCode(userCode)!),
        claimHash: sha256(input.claim),
        model: input.model,
        fwVersion: input.fwVersion,
        ipHash: sha256Hex(input.ip),
        ttlSeconds: PAIRING_TTL_SECONDS,
      });
      journal('v2.pair_issued', { pairing_id: pairingId });
      return { pairingId, userCode, expiresIn: 600 };
    } catch (error) {
      if (!(error instanceof PairingCodeCollisionError) || attempt === 2) {
        throw error;
      }
    }
  }
  throw new PairingCodeCollisionError('pairing code already pending');
}

/**
 * In-memory sliding window of lookup failures, keyed per account and per IP.
 * The clock is injectable so tests can advance time (FR-015).
 */
interface PairingRateLimiter {
  /** Throws PairingRateLimitedError when either window holds maxFailures+. */
  check(userId: string, ip: string): void;
  /** Records one failure in both windows. */
  recordFailure(userId: string, ip: string): void;
}

export function createPairingRateLimiter(
  options: { now?: Clock; maxFailures?: number; windowMs?: number } = {},
): PairingRateLimiter {
  const now = options.now ?? (() => Date.now());
  const maxFailures = options.maxFailures ?? PAIRING_MAX_LOOKUP_FAILURES;
  const windowMs = options.windowMs ?? PAIRING_LOOKUP_WINDOW_MS;
  const failures = new Map<string, number[]>();

  const prune = (key: string, current: number): number[] => {
    const kept = (failures.get(key) ?? []).filter((t) => current - t < windowMs);
    failures.set(key, kept);
    return kept;
  };

  return {
    check(userId: string, ip: string): void {
      const current = now();
      let retryAfterSeconds = 0;
      for (const key of [`user:${userId}`, `ip:${ip}`]) {
        const list = prune(key, current);
        if (list.length >= maxFailures) {
          const oldest = list[0]!;
          retryAfterSeconds = Math.max(
            retryAfterSeconds,
            Math.ceil((oldest + windowMs - current) / 1000),
          );
        }
      }
      if (retryAfterSeconds > 0) {
        journal('v2.pair_rejected', { acct: accountTag(userId), reason: 'rate_limited' });
        throw new PairingRateLimitedError(retryAfterSeconds);
      }
    },
    recordFailure(userId: string, ip: string): void {
      const current = now();
      for (const key of [`user:${userId}`, `ip:${ip}`]) {
        const list = prune(key, current);
        list.push(current);
        failures.set(key, list);
      }
    },
  };
}

const defaultLimiter = createPairingRateLimiter();

interface LookupResult {
  pairingId: string;
  deviceModel: string;
  requestedAt: number;
  expiresAt: number;
}

interface LookupCodeOptions {
  now?: Clock;
  limiter?: PairingRateLimiter;
}

/**
 * Resolves a user code for the pairing page. A malformed code throws
 * InvalidCodeError and does not count; a wrong/expired/used code throws
 * PairingNotFoundError and counts a failure per account and per IP (FR-015).
 */
export async function lookupCode(
  db: Db,
  userId: string,
  rawCode: string,
  ip: string,
  options: LookupCodeOptions = {},
): Promise<LookupResult> {
  const now = options.now ?? (() => Date.now());
  const limiter = options.limiter ?? defaultLimiter;
  const normalized = normalizeUserCode(rawCode);
  if (normalized === null) {
    throw new InvalidCodeError();
  }
  limiter.check(userId, ip);
  const lookup = await lookupPairing(db, userId, sha256(normalized));
  if (lookup === null || lookup.expiresAt <= now()) {
    limiter.recordFailure(userId, ip);
    journal('v2.pair_rejected', { acct: accountTag(userId), reason: 'not_found' });
    throw new PairingNotFoundError('pairing not found');
  }
  return lookup;
}

/**
 * A registered device socket: the claim secret that gates token delivery, and
 * the send/close callbacks supplied by the session layer. An expired code is
 * refused when it is read (lookupCode), so nothing pushes pair_expired.
 */
export type PairingPush =
  | { kind: 'paired'; deviceId: string; deviceToken: string; name: string }
  | { kind: 'denied'; pairingId: string };

export interface WaitingSocket {
  claim: string;
  send: (push: PairingPush) => void;
  close: (code?: number, reason?: string) => void;
}

const waitingSockets = new Map<string, WaitingSocket>();

export function registerWaiting(pairingId: string, socket: WaitingSocket): void {
  waitingSockets.set(pairingId, socket);
}

export function unregisterWaiting(pairingId: string): void {
  waitingSockets.delete(pairingId);
}

function generateDeviceToken(): string {
  return `olxd_${randomBytes(32).toString('base64url')}`;
}

/**
 * Delivers the device token through the registered socket, if one with a
 * matching claim is present. The raw token is generated only here, stored only
 * as its sha256, and never survives the call (plan §D, data-model §4). Returns
 * whether `paired` was sent.
 */
async function deliver(db: Db, pairingId: string): Promise<boolean> {
  const socket = waitingSockets.get(pairingId);
  if (socket === undefined) return false;
  const token = generateDeviceToken();
  const result = await claimPairing(db, pairingId, sha256(socket.claim), sha256(token));
  if (result === null) {
    // Claim mismatch or device already authenticated: never leak the token.
    unregisterWaiting(pairingId);
    return false;
  }
  socket.send({ kind: 'paired', deviceId: result.deviceId, deviceToken: token, name: result.name });
  traceSpan('device-paired', toSpanAttrs({ surface: 'pairing' }), () =>
    journal('v2.pair_delivered', { pairing_id: pairingId, device_id: result.deviceId }),
  );
  unregisterWaiting(pairingId);
  return true;
}

const sharedAccountEvents = new AccountEvents();

/** The process-wide device event bus; web-events (T033) subscribes to it. */
export function getAccountEvents(): AccountEvents {
  return sharedAccountEvents;
}

/**
 * Approves a pending pairing: creates the device row (token still NULL), then
 * delivers `paired` if a socket is waiting, then publishes device.changed.
 */
export async function approve(
  db: Db,
  userId: string,
  pairingId: string,
  name?: string,
  events: AccountEvents = sharedAccountEvents,
): Promise<string> {
  const deviceId = await approvePairing(db, userId, pairingId, name);
  await deliver(db, pairingId);
  events.publish(userId, { type: 'device.changed', device_id: deviceId });
  journal('v2.pair_approved', { acct: accountTag(userId), device_id: deviceId });
  return deviceId;
}

/** Denies a pending pairing and pushes pair_denied to the waiting socket. */
export async function deny(db: Db, userId: string, pairingId: string): Promise<void> {
  await denyPairing(db, userId, pairingId);
  const socket = waitingSockets.get(pairingId);
  if (socket !== undefined) {
    socket.send({ kind: 'denied', pairingId });
    unregisterWaiting(pairingId);
  }
  journal('v2.pair_denied', { acct: accountTag(userId), pairing_id: pairingId });
}

type SocketIo = Pick<WaitingSocket, 'send' | 'close'>;

/**
 * Same-boot resume: re-registers the reconnected socket with the replayed
 * claim and attempts delivery. A claim mismatch yields no token (claimPairing
 * returns null); the caller falls back to issuing a fresh code (R8, S-3).
 */
export async function resume(
  db: Db,
  pairingId: string,
  claim: string,
  socket: SocketIo,
): Promise<boolean> {
  registerWaiting(pairingId, { claim, send: socket.send, close: socket.close });
  return deliver(db, pairingId);
}
