/**
 * Device authentication for the /v2/cardputer WebSocket upgrade. Runs before
 * res.accept(), so a rejected upgrade never creates a session. The outcome
 * depends on the Authorization header alone:
 *
 * | Header                          | Result                       |
 * |---------------------------------|------------------------------|
 * | `Bearer olxd_<43>` active device| device { userId, deviceId }  |
 * | `Bearer olxd_<43>` unknown/rev  | unpaired { reason }          |
 * | `Bearer <secret>` + legacy owner| legacy { userId }            |
 * | `Bearer <other>` any other case | 401                          |
 * | no header                       | unpaired { reason: 'none' }  |
 *
 * Unpaired sockets are capped at 3 per IP (the 4th upgrade is 503). Raw
 * tokens and secrets never enter the journal.
 */
import { createHash } from 'node:crypto';
import type { NextFunction, Request } from 'express';
import type { WSResponse } from 'websocket-express';
import { moduleJournal } from '../platform/logger.ts';
import { validToken } from '../account/auth.ts';
import type { Db } from '../platform/db/db.ts';
import { deviceForToken, touchDevice } from './pairing-store.ts';
import { clientIp, hashIp, holdForSocketLife } from '../platform/http/rate-limit.ts';

const journal = moduleJournal('devices');

const DEVICE_TOKEN_PREFIX = 'olxd_';
const UNPAIRED_MAX_SOCKETS_PER_IP = 3;

type UnpairedReason = 'none' | 'unknown' | 'revoked';

export type DeviceAuth =
  | { kind: 'device'; userId: string; deviceId: string; name: string }
  | { kind: 'legacy'; userId: string; deviceId: null }
  | { kind: 'unpaired'; reason: UnpairedReason };

declare global {
  namespace Express {
    interface Request {
      deviceAuth?: DeviceAuth;
    }
  }
}

const unpairedPerIp = new Map<string, number>();

/** Test seam: clears the per-IP unpaired socket counters. */
export function resetUnpairedSockets(): void {
  unpairedPerIp.clear();
}

function countUnpaired(ipHash: string): number {
  return unpairedPerIp.get(ipHash) ?? 0;
}

function tokenHash(token: string): Uint8Array {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** The first handler of app.ws(...). */
export function createDeviceAuthGuard(expectedSecret: string | undefined, getDb: () => Promise<Db>) {
  return async (request: Request, response: WSResponse, next: NextFunction): Promise<void> => {
    const header = request.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;

    // A bearer that is not a device token: the legacy shared secret or 401.
    if (token !== undefined && !token.startsWith(DEVICE_TOKEN_PREFIX)) {
      const legacyOwner = process.env.BOB_LEGACY_DEVICE_OWNER;
      if (legacyOwner !== undefined && legacyOwner !== '' && validToken(token, expectedSecret ?? '')) {
        request.deviceAuth = { kind: 'legacy', userId: legacyOwner, deviceId: null };
        journal('v2.device_authenticated', { kind: 'legacy' });
        return next();
      }
      journal('v2.device_refused', { reason: 'invalid_token' });
      response.reject(401, 'invalid_token');
      return;
    }

    if (token !== undefined) {
      let device: Awaited<ReturnType<typeof deviceForToken>>;
      try {
        const db = await getDb();
        device = await deviceForToken(db, tokenHash(token));
      } catch (error) {
        // Undecidable, not unpaired: a store outage must not push a valid
        // device onto the pairing screen. Refuse rather than guess.
        journal('v2.device_refused', {
          reason: 'store_unavailable',
          error_name: error instanceof Error ? error.name : 'unknown',
        });
        response.reject(503, 'auth_unavailable');
        return;
      }
      if (device !== null && !device.revoked && !device.disabled) {
        try {
          const db = await getDb();
          await touchDevice(db, device.deviceId);
        } catch {
          // last_seen is best-effort; authentication already succeeded.
        }
        request.deviceAuth = { kind: 'device', userId: device.userId, deviceId: device.deviceId, name: device.name };
        journal('v2.device_authenticated', { kind: 'device', device_id: device.deviceId });
        return next();
      }
      // A disabled account counts as revoked: the device erases its NVS token.
      const reason: UnpairedReason = device === null ? 'unknown' : 'revoked';
      acceptUnpaired(request, response, next, reason);
      return;
    }

    acceptUnpaired(request, response, next, 'none');
  };
}

function acceptUnpaired(
  request: Request,
  response: WSResponse,
  next: NextFunction,
  reason: UnpairedReason,
): void {
  const ipHash = hashIp(clientIp(request));
  if (countUnpaired(ipHash) >= UNPAIRED_MAX_SOCKETS_PER_IP) {
    journal('v2.device_refused', { reason: 'unpaired_limit', ip_hash: ipHash });
    response.reject(503, 'too_many_unpaired');
    return;
  }
  // A socket that died during the async auth above takes no slot.
  const release = holdForSocketLife(request.socket, () => {
    const nextCount = countUnpaired(ipHash) - 1;
    if (nextCount <= 0) unpairedPerIp.delete(ipHash);
    else unpairedPerIp.set(ipHash, nextCount);
  });
  if (release === null) {
    journal('v2.accept_failed', { error_name: 'SocketClosed' });
    return;
  }
  unpairedPerIp.set(ipHash, countUnpaired(ipHash) + 1);
  request.deviceAuth = { kind: 'unpaired', reason };
  journal('v2.device_authenticated', { kind: 'unpaired', reason });
  next();
}