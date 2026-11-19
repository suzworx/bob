/**
 * Workflow: answers a device's firmware update check and records the start of its OTA.
 * Trigger: the device's check_update and ota_progress control messages, dispatched by voice/session.ts.
 * Steps: check_update: 1. reuse the session's last answer when it is under a minute old. 2. otherwise read the device's
 *   current offer (currentOffer), `offer: null` for a legacy or unpaired session or when nothing is on offer. 3. send
 *   update_offer. ota_progress: 1. a paired device's 'start' is stored (recordOtaStart); ok and failed reach the server as
 *   the next hello's last_ota.
 * Outcome: the device gets one fresh update_offer a minute at most; a store failure answers `offer: null` and is journaled.
 *   A failed start record is journaled and the device carries on with its update.
 * Journal: v2.ota.error (reason check_failed, progress_failed). No trace names of its own.
 */
import { V2_VERSION, messageId, otaOfferWire, type ClientControlDto } from '../voice/protocol.ts';
import { moduleJournal } from '../platform/logger.ts';
import { currentOffer, recordOtaStart } from '../firmware/device-offer.ts';
import { sendDto, type ControlContext, type UpdateOfferPayload } from '../voice/session-handlers.ts';

const journal = moduleJournal('voice');

/** One check_update answer per session per minute; a faster one gets the last answer again. */
const CHECK_UPDATE_INTERVAL_MS = 60_000;

/** check_update: answers with update_offer, `offer: null` when nothing is on offer. */
export async function handleCheckUpdate(ctx: ControlContext): Promise<void> {
  const { deps, socket, session } = ctx;
  const now = Date.now();
  let answer = session.lastUpdateCheck;
  if (answer === undefined || now - answer.at >= CHECK_UPDATE_INTERVAL_MS) {
    let payload: UpdateOfferPayload = { offer: null };
    if (session.auth?.kind === 'device') {
      try {
        const offer = await currentOffer(await deps.getDb(), session.auth.deviceId, session.fwVersion ?? 'unknown');
        if (offer !== null) payload = otaOfferWire(offer);
      } catch {
        journal('v2.ota.error', { session: session.id, reason: 'check_failed' });
      }
    }
    answer = { at: now, payload };
    session.lastUpdateCheck = answer;
  }
  sendDto(socket, { v: V2_VERSION, type: 'update_offer', id: messageId('updo'), payload: answer.payload });
}

/** ota_progress: only 'start' is stored; ok and failed reach the server as the next hello's last_ota. */
export async function handleOtaProgress(ctx: ControlContext, dto: Extract<ClientControlDto, { type: 'ota_progress' }>): Promise<void> {
  const { deps, session } = ctx;
  if (dto.payload.stage !== 'start' || session.auth?.kind !== 'device') return;
  try {
    await recordOtaStart(await deps.getDb(), session.auth.deviceId, session.fwVersion ?? 'unknown', dto.payload.to);
  } catch {
    journal('v2.ota.error', { session: session.id, reason: 'progress_failed' });
  }
}
