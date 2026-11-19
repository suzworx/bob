/**
 * REST routes for device pairing, mounted under /api/pair; approve/deny
 * additionally run under requireActiveSession. All journaling happens inside
 * the pairing service -- these handlers never log.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { route, sendError } from '../platform/http/route.ts';
import { InvalidCodeError, PairingRateLimitedError } from './pairing-service.ts';
import type { approve, deny, lookupCode } from './pairing-service.ts';
import { notifySecurityEvent } from '../notifications/notify.ts';
import { PairingNotFoundError } from './pairing-store.ts';
import { approvePairing } from '../workflows/workflow-device-pairing.ts';
import { withUser, type Db } from '../platform/db/db.ts';
import {
  PairApproveRequestSchema,
  PairDenyRequestSchema,
  PairLookupRequestSchema,
} from '../web-schemas.ts';

/** The pairing service surface the router needs; the real module satisfies
 *  this structurally. */
interface PairingService {
  lookupCode: typeof lookupCode;
  approve: typeof approve;
  deny: typeof deny;
}

interface PairingRouterDeps {
  getDb: () => Promise<Db>;
  pairing: PairingService;
  requireActiveSession: (request: Request, response: Response, next: NextFunction) => Promise<void>;
}

/** The client address used for rate limiting, with the socket as fallback. */
function clientIp(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}

/** Reads the name approve_pairing stored when the client sent none (the device
 *  model truncated to 40). RLS on bob.devices scopes it to the owner. */
async function storedDeviceName(db: Db, userId: string, deviceId: string): Promise<string> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx.query<{ name: string }>(
      'select name from bob.devices where id = $1',
      [deviceId],
    );
    const row = rows[0];
    return row !== undefined ? row.name : deviceId;
  });
}

function mapLookupError(response: Response, error: unknown): void {
  if (error instanceof InvalidCodeError) {
    sendError(response, 400, 'invalid_request');
    return;
  }
  if (error instanceof PairingRateLimitedError) {
    response
      .status(429)
      .set('Retry-After', String(error.retryAfterSeconds))
      .json({
        error: {
          code: 'rate_limited',
          message: 'Too many pairing code attempts. Try again later.',
          retry_after_seconds: error.retryAfterSeconds,
        },
      });
    return;
  }
  mapNotFound(response, error);
}

/** One generic body for wrong, expired, and used codes or pairings. */
function mapNotFound(response: Response, error: unknown): void {
  if (error instanceof PairingNotFoundError) {
    sendError(response, 404, 'not_found');
    return;
  }
  throw error;
}

export function createPairingRouter({
  getDb,
  pairing,
  requireActiveSession,
}: PairingRouterDeps): Router {
  const router = Router();

  router.post('/lookup', route({ body: PairLookupRequestSchema, mapError: mapLookupError },
    async ({ body, userId }, request, response) => {
      const result = await pairing.lookupCode(await getDb(), userId, body.user_code, clientIp(request));
      response.status(200).json({
        pairing_id: result.pairingId,
        device_model: result.deviceModel,
        requested_at: result.requestedAt,
        expires_at: result.expiresAt,
      });
    }));

  router.post('/approve', requireActiveSession, route({ body: PairApproveRequestSchema, mapError: mapNotFound },
    async ({ body, userId }, _request, response) => {
      const { deviceId, name } = await approvePairing(
        { approve: pairing.approve, notifySecurityEvent, storedDeviceName },
        { db: await getDb(), userId, pairingId: body.pairing_id, name: body.name },
      );
      response.status(200).json({ device_id: deviceId, name });
    }));

  router.post('/deny', requireActiveSession, route({ body: PairDenyRequestSchema },
    async ({ body, userId }, _request, response) => {
      // deny_pairing is silent: pending, unknown, and already-decided pairings
      // all answer 204 (pair ids are unguessable, so no oracle).
      await pairing.deny(await getDb(), userId, body.pairing_id);
      response.status(204).end();
    }));

  return router;
}
