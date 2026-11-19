/**
 * Workflow: pair a device with an account, from the device's pair_request to the approval.
 * Trigger: two. The device's pair_request over its socket (handlePairRequest, dispatched by voice/session.ts) asks for
 *   a code and waits on the socket. POST /api/pair/approve (route in devices/pairing-http.ts, behind requireActiveSession)
 *   approves the code (approvePairing).
 * Steps: WS half: 1. rate-limit the socket's pair_request by IP. 2. a resume that is still deliverable re-attaches the
 *   waiting socket; otherwise issue a fresh code and register the socket to receive the answer. HTTP half: 3. approve the
 *   pairing (creates the device row, delivers the token to a waiting socket, publishes device.changed). 4. resolve the
 *   device name (the one the client sent, else the stored name). 5. send the account's device_paired security notice.
 * Outcome: WS: the device holds a pairing code and is answered when the account decides it (paired or pair_denied;
 *   nothing pushes pair_expired), or the request is refused with an error (rate limit, wrong state, store failure). HTTP: on success
 *   the device exists and the account has its security notice, and the caller gets the device id and name. An unknown,
 *   decided or expired pairing throws PairingNotFoundError before anything else runs, so nothing is notified. A failure
 *   after approve (name read or notice) propagates after the approval has committed; the route maps errors, this file does not.
 * Journal: v2.pair_rejected (WS, rate_limited, and the pairing service's refusals), v2.pair_issued (issueCode),
 *   v2.pair_delivered and v2.pair_denied and v2.pair_approved (the pairing service: resume, deny and approve; delivered
 *   only when a socket waits), the device.changed account event, and the notice's v2.notifications_enqueued or
 *   v2.notifications_enqueue_failed with the notification-deliver trace (inside notifySecurityEvent).
 */
import type { WebSocket } from 'ws';
import { moduleJournal } from '../platform/logger.ts';
import { hashIp } from '../platform/http/rate-limit.ts';
import { issueCode, registerWaiting, resume, unregisterWaiting, type approve, type PairingPush } from '../devices/pairing-service.ts';
import type { notifySecurityEvent } from '../notifications/notify.ts';
import type { Db } from '../platform/db/db.ts';
import { messageId, V2_VERSION, type ClientControlDto } from '../voice/protocol.ts';
import { sendDto, sendError, takePairRequestToken, type ControlContext } from '../voice/session-handlers.ts';

const journal = moduleJournal('voice');
const DEFAULT_PAIRING_VERIFICATION_URI = 'https://app.heybob.xyz/pair';

export interface ApprovePairingDeps {
  approve: typeof approve;
  notifySecurityEvent: typeof notifySecurityEvent;
  storedDeviceName: (db: Db, userId: string, deviceId: string) => Promise<string>;
}

export interface ApprovePairingInput {
  db: Db;
  userId: string;
  pairingId: string;
  name?: string;
}

export interface ApprovePairingResult {
  deviceId: string;
  name: string;
}

export async function approvePairing(
  deps: ApprovePairingDeps,
  input: ApprovePairingInput,
): Promise<ApprovePairingResult> {
  const deviceId = await deps.approve(input.db, input.userId, input.pairingId, input.name);
  const name = input.name ?? (await deps.storedDeviceName(input.db, input.userId, deviceId));
  await deps.notifySecurityEvent(input.db, input.userId, 'device_paired', deviceId, 1);
  return { deviceId, name };
}

/** The client IP behind a ws WebSocket, read off its net.Socket: server.ts owns
 *  the request, so the session has no other way to see it. */
function socketIp(socket: WebSocket): string {
  const underlying = (socket as unknown as { _socket?: { remoteAddress?: string } })._socket;
  return underlying?.remoteAddress ?? 'unknown';
}

function pairingVerificationUri(): string {
  return process.env.BOB_PAIRING_URL ?? DEFAULT_PAIRING_VERIFICATION_URI;
}

/** The registered socket's send callback: maps each typed service push to its
 *  wire envelope, so denied and expired stay apart. */
function pairingSend(socket: WebSocket): (push: PairingPush) => void {
  return (push: PairingPush): void => {
    switch (push.kind) {
      case 'paired':
        sendDto(socket, {
          v: V2_VERSION, type: 'paired', id: messageId('paired'),
          payload: { device_id: push.deviceId, device_token: push.deviceToken, name: push.name },
        });
        return;
      case 'denied':
        sendDto(socket, { v: V2_VERSION, type: 'pair_denied', id: messageId('pdnd'), payload: { pairing_id: push.pairingId } });
        return;
    }
  };
}

export async function handlePairRequest(ctx: ControlContext, dto: Extract<ClientControlDto, { type: 'pair_request' }>): Promise<void> {
  const { deps, socket, session } = ctx;
  if (session.auth?.kind !== 'unpaired') return sendError(socket, session, 'STATE_VIOLATION');
  if (session.stage !== 'ready') return sendError(socket, session, 'STATE_VIOLATION');
  const ip = socketIp(socket);
  if (!takePairRequestToken(ip)) {
    journal('v2.pair_rejected', { reason: 'rate_limited', ip_hash: hashIp(ip) });
    return sendError(socket, session, 'PAIRING_RATE_LIMITED');
  }
  const { model, fw_version, claim } = dto.payload;
  const resumeId = dto.payload.resume;
  const send = pairingSend(socket);
  const close = (code?: number, reason?: string): void => socket.close(code, reason);
  // A new pair_request invalidates the previous code for this socket: the old
  // pairing can no longer be delivered here.
  if (session.pairingId !== undefined) {
    unregisterWaiting(session.pairingId);
    session.pairingId = undefined;
  }
  let db: Db;
  try { db = await deps.getDb(); } catch { return sendError(socket, session, 'INTERNAL'); }
  if (resumeId !== undefined) {
    const delivered = await resume(db, resumeId, claim, { send, close });
    if (delivered) return;
    // Not deliverable now (pending/unknown/claim mismatch): fresh request.
    unregisterWaiting(resumeId);
  }
  let result: Awaited<ReturnType<typeof issueCode>>;
  try { result = await issueCode(db, { model, fwVersion: fw_version, claim, ip }); } catch { return sendError(socket, session, 'INTERNAL'); }
  session.pairingId = result.pairingId;
  registerWaiting(result.pairingId, { claim, send, close });
  return sendDto(socket, {
    v: V2_VERSION, type: 'pair_code', id: messageId('pcode'),
    payload: { pairing_id: result.pairingId, user_code: result.userCode, verification_uri: pairingVerificationUri(), expires_in: result.expiresIn },
  });
}
