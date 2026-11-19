import type { WebSocket } from 'ws';
import { ttsVoiceFor } from '@bob/ai';
import { downlinkMp3Frames } from '../audio/stt-tts.ts';
import { speakable } from '../audio/speakable.ts';
import {
  MP3_16K_MONO_FORMAT,
  V2_VERSION,
  messageId,
  type SessionDto,
} from '../protocol.ts';
import { moduleJournal } from '../../platform/logger.ts';
import { mp3DrainBytesPerSecond } from '../audio/mp3.ts';
import { resetSession, sendDto } from '../session-handlers.ts';
import type { Announcement } from '../device-sessions.ts';
import { wholeMp3 } from '../speech-port.ts';
import { abortable } from './abort.ts';
import type { TurnDeps } from './deps.ts';
import { DOWNLINK_FRAME_INTERVAL_MS, newPacerState, streamFrames } from './pacing.ts';
import { flushDownlink } from './downlink.ts';
import { traceWorkflow } from '../../platform/observability/workflow-diagnostics.ts';

const journal = moduleJournal('voice');

/**
 * Speaks a ring:false announcement right after its `announce` card, through
 * the same MP3 synthesis and pacing as a reply. The session is `responding`
 * throughout, so turn_start is refused, pushes are held and `cancel` aborts it.
 * Only MP3 sessions get the speech; a TTS failure ends it silently. The stage
 * flips before the first await so the registry sees it busy at once.
 */
export async function runAnnouncement(deps: TurnDeps, socket: WebSocket, session: SessionDto, announcement: Announcement): Promise<void> {
  const speech = announcement.speech === undefined ? undefined : (speakable(announcement.speech) || announcement.speech);
  if (session.formatId !== MP3_16K_MONO_FORMAT || speech === undefined || speech === '' || session.stage !== 'ready') {
    await traceWorkflow('device-announcement', { detached: true, metadata: { action: announcement.kind } }, (outcome) => outcome('skipped'));
    return;
  }
  const turnRef = `ann_${announcement.announce_id}`;
  const abort = new AbortController();
  let settle: () => void = () => undefined;
  session.stage = 'responding';
  session.turnRef = turnRef;
  session.turnAbort = abort;
  session.turnDone = new Promise<void>((resolve) => { settle = resolve; });
  return traceWorkflow('device-announcement', { detached: true, tags: ['device'],
    workflowNamespace: session.id, turnId: turnRef, metadata: { action: announcement.kind },
  }, async (report) => {
    let outcome: 'played' | 'cancelled' | 'tts_failed' = 'played';
    let mp3Bytes = 0;
    try {
      const audio = await abortable(deps.ttsMp3(speech, ttsVoiceFor(session.assistantName)), abort.signal);
      const mp3 = await abortable(wholeMp3(audio), abort.signal);
      mp3Bytes = mp3.length;
      sendDto(socket, { v: V2_VERSION, type: 'playback_start', id: messageId('playback_start'), turn_ref: turnRef, payload: {} });
      const frames = downlinkMp3Frames(mp3);
      const pacer = newPacerState();
      await streamFrames(socket, session, frames, DOWNLINK_FRAME_INTERVAL_MS, mp3DrainBytesPerSecond(mp3), abort.signal, undefined, pacer);
      void flushDownlink(session, pacer);
      sendDto(socket, { v: V2_VERSION, type: 'playback_end', id: messageId('playback_end'), turn_ref: turnRef, payload: {} });
      if (abort.signal.aborted) outcome = 'cancelled';
    } catch {
      outcome = abort.signal.aborted ? 'cancelled' : 'tts_failed';
    } finally {
      if (outcome === 'cancelled') report('cancelled');
      else if (outcome === 'tts_failed') report('failed');
      // Kind, outcome and size only: the speech is user text.
      journal('v2.announce_played', { session: session.id, kind: announcement.kind, outcome, mp3_bytes: mp3Bytes });
      resetSession(deps, session);
      settle();
    }
  });
}
