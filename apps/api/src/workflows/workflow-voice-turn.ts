/**
 * Workflow: runs one device voice turn, from the uplink audio to the reply's speech on the device and the saved conversation.
 * Trigger: the device's WS `turn_end`. session-handlers.ts handleTurnEnd arms session.turnAbort and runs onTurnEnd inside the
 *   `turn-pipeline` span; device-socket.ts passes runTurn as onTurnEnd. A WS `cancel` (handleCancel) aborts it through turnAbort.
 * Steps:
 *   1. Send status thinking, take the captured PCM and clear the session's audio buffers. A too-short tap is journaled.
 *      takeSpeculation takes the reply the server's end of turn started on the streamed hypothesis (speculate.ts). A path that
 *      does not commit it discards it (no_transcript, aborted, error); the finally discards any live one.
 *   2. Start the memory context: the early prep from turn_start if one ran (takeEarlyPrep), else resolveTurnMemory.
 *   3. Empty, too-short or silent audio skips STT and closes the STT stream. Otherwise transcribeTurn runs: a clip the STT
 *      provider rejects becomes an empty turn, any other STT error fails the turn (failTurn 'stt') and returns.
 *   4. A hands-free turn with no transcript ends with an empty reply_text and status idle, and returns.
 *   5. Await the memory context. With a transcript and a signal not yet aborted, prepareTurn writes the anchor message
 *      while the agent runs.
 *   6. tryCommit commits a live speculation whose words match the final transcript (its buffered text streams out at once,
 *      the anchor write awaited after it); otherwise it is discarded (mismatch, or aborted), or a committed run ended not
 *      eligible, and generateReply runs with the early prep. An MP3 device hears each sentence as the agent writes it
 *      (createSentencePlayback); otherwise the reply is batch. With no transcript the reply is EMPTY_TURN_REPLY.
 *   7. Playback: a streamed reply finishes its stream. Otherwise reply_text is sent and streamPlayback runs batch TTS.
 *      A streamed reply whose TTS fails after audio started is a speech cut (journalSpeechCut) and playback_end still
 *      ends the turn. A streamed reply whose TTS fails before any audio played, and a batch TTS error, fail the turn
 *      (failTurn 'tts': INTERNAL, or the out-of-credit card; no playback_end).
 *   8. A completed turn persists its reply (persistTurn; cut to the heard characters if speech stopped early), then
 *      journals v2.turn_completed. A failed turn also persists in two cases (only when memory was prepared for the TTS
 *      one): a TTS failure saves the full reply text and tools with 0 heard characters, and an agent error after text
 *      streamed saves the streamed text, cut to the characters heard.
 *   9. Finally: record metrics, abort the STT stream, resetSession, await the anchor write, releaseTurn. resetSession
 *      sends no status: it sets session.stage ready, flushes the uplink, closes the turn root and flushes held pushes.
 *      The status idle the device sees comes from turn/playback.ts, turn/failure.ts or the local cancelled() helper.
 * Outcome:
 *   completed: the reply was spoken and saved. The device gets playback_end (streamed or batch), then status idle.
 *   cancelled (session.turnAbort aborted): the pipeline stops at once. Playback that had started gets playback_end; a
 *     reply cut short is saved as interrupted. Otherwise only status idle is sent. A cancel during STT saves nothing; a cancel during the agent saves any text already streamed.
 *   failed: failTurn journals v2.turn_failed and sends the device INTERNAL, or the out-of-credit card for a spent budget.
 *     When an agent failure follows audio already played, it journals only (notifyDevice false), so the device's audio is not aborted.
 *     Saved: a TTS failure saves the full reply (0 heard characters, when memory was prepared); an agent error saves the
 *     text already streamed (when memory was prepared). An STT or other agent failure saves nothing.
 * Journal (every event this file emits directly, or through the steps it calls):
 *   Direct: v2.turn_too_short (pcm_bytes); v2.turn_cancelled (stage stt | agent | tts | stream); v2.turn_completed;
 *     v2.turn_stage_input_completed (empty turn, via journalTurnStage). debugLog turn.completed (debug log, not journal).
 *   Via steps: v2.turn_stage_stt_started / _completed (transcribeTurn); v2.turn_stt_rejected (journalSttRejectedAudio);
 *     v2.turn_stage_prep_started / _completed, v2.agent_tools, v2.agent_tools_degraded (generateReply);
 *     v2.turn_stage_agent_started / _completed; v2.turn_stage_tts_started / _completed, v2.downlink_started,
 *     v2.downlink_trimmed (playback); v2.downlink_aborted (pacing.ts); v2.turn_stage_<stage>_failed (failTurn,
 *     journalSpeechCut, and journalSttRejectedAudio for stt) and v2.turn_failed (failTurn only);
 *     v2.ai_budget_exhausted (budget-alarm.ts, via failTurn and journalSpeechCut); v2.turn_prepare_failed,
 *     v2.turn_persist_failed, v2.turn_release_failed, v2.device_thread_saved, v2.device_thread_lost,
 *     v2.active_changed (persist.ts).
 *   Not emitted here: v2.device_turn_timing (voice/turn/device-timing.ts; session.ts only dispatches the device's
 *     turn_timing message to it).
 *   Traces: turn-pipeline (opened by handleTurnEnd, not here); device-stt (transcribe.ts); device-tts (playback.ts);
 *     ws.downlink (downlink.ts, streamed audio); device-announcement is the announce path, not this turn.
 */
import type { WebSocket } from 'ws';
import { sessionBoard } from '../voice/session-board.ts';
import { hasPcmSignal } from '../voice/audio/pcm-signal.ts';
import { debugLog } from '@bob/ai';
import {
  assemblePcm16,
  isEmptyTurn,
  isTooShortTurn,
} from '../voice/audio/stt-tts.ts';
import {
  MP3_16K_MONO_FORMAT,
  replyTextDto,
  type SessionDto,
} from '../voice/protocol.ts';
import { moduleJournal } from '../platform/logger.ts';
import { resetSession, sendDto, sendStatus } from '../voice/session-handlers.ts';
import {
  classifyFailure,
  isSttAudioRejection,
  NO_AGENT_ACTION,
  type AgentActionOutcome,
  type TurnStage,
} from '../voice/turn-core.ts';
import { journalTurnStage } from '../voice/turn-journal.ts';
import { type MemoryExtractionWorker } from '../memory/extract.ts';
import { transcribeTurn } from '../voice/turn/transcribe.ts';
import { abortSttStream, endOfTurnEvidence } from '../voice/turn/stream-stt.ts';
import { eotJournalFields } from '../voice/turn/end-of-turn.ts';
import { resolveTurnMemory, type TurnMemoryContext } from '../voice/turn/context.ts';
import type { TurnDeps } from '../voice/turn/deps.ts';
import { generateReply, takeEarlyPrep, type GeneratedReply } from '../voice/turn/generate.ts';
import { takeSpeculation, type Speculation } from '../voice/turn/speculate.ts';
import { pcmFrames } from '../voice/turn/uplink.ts';
import { PlaybackResult, streamPlayback, SentencePlaybackResult, SentencePlayback, createSentencePlayback } from '../voice/turn/playback.ts';
import { journalSpeechCut, journalSttRejectedAudio, failTurn } from '../voice/turn/failure.ts';
import { pushTurnScene } from '../voice/turn/scenes.ts';
import { persistTurn, prepareTurn, releaseTurn } from '../voice/turn/persist.ts';
import { createTurnMetrics, recordTurnMetrics } from '../voice/turn/metrics.ts';

const journal = moduleJournal('voice');

const EMPTY_TURN_REPLY = 'I did not hear anything. Please try again.';

/**
 * Runs one full turn: STT (if audio) -> agent -> TTS -> downlink frame stream.
 * Session.turnAbort (armed at turn_end) cancels it at any stage. The
 * pipeline stops waiting at once, sends playback_end if playback had started,
 * then status idle, and saves a reply that was cut short as interrupted.
 */
export async function runTurn(
  deps: TurnDeps,
  socket: WebSocket,
  session: SessionDto,
  turnRef: string,
  worker?: MemoryExtractionWorker,
): Promise<void> {
  const signal = session.turnAbort?.signal;
  // Before anything can abort the STT stream: its 'drop' would end the speculative reply.
  const speculation: Speculation = takeSpeculation(session, turnRef);
  sendStatus(socket, session, 'thinking', turnRef);
  const pcm = assemblePcm16(session.audioChunks);
  const hasAudio = !isEmptyTurn(session.audioChunks);
  const tooShort = isTooShortTurn(session.audioChunks);
  const handsFree = session.deviceState?.mode === 'wake';
  const clearSilence = handsFree && !hasPcmSignal(pcm);
  session.audioChunks = [];
  session.totalAudioBytes = 0;
  const turnStartedAt = Date.now();
  const m = createTurnMetrics('device');
  // Started at turn_start (startEarlyPrep, with the rest of the transcript-free
  // prep), else here before STT, since it does not need the transcript; awaited
  // just before it is first needed (generateReply). The STT failure paths
  // below return without ever awaiting this, so a rejection needs its own
  // handler here or it becomes an unhandled rejection later.
  const early = takeEarlyPrep(session, turnRef);
  // A cancel or abort closes the early gate at once and aborts the early Google and app calls: no gated tool runs after it.
  // A false wake (no transcript) and any other turn that never wrote its anchor close it in the finally below.
  if (early !== undefined) signal?.addEventListener('abort', early.closeGate, { once: true });
  const memoryPrep = early?.context ?? resolveTurnMemory(deps, session, worker);
  memoryPrep.catch(() => undefined);
  let preparedMemory: TurnMemoryContext | null = null;
  // The anchor write, started once the transcript is known and overlapped
  // with the agent's prep (generateReply). prepareTurn never rejects; the
  // finally below waits for it so releaseTurn always sees the anchor.
  let prepare: Promise<void> = Promise.resolve();
  // A cancel before playback_start: nothing was streamed, so only idle follows.
  const cancelled = (stage: TurnStage): void => {
    m.cancel();
    journal('v2.turn_cancelled', { session: session.id, stage, conversation_id: session.activeConversationId, ...speculation.outcome() });
    sendStatus(socket, session, 'idle', turnRef);
  };
  // A cancel after playback_start: the stream already sent playback_end and status idle.
  const cancelledStream = (downFrames: number, heardChars: number): void => {
    m.cancel(true);
    journal('v2.turn_cancelled', {
      session: session.id, stage: 'stream', down_frames: downFrames, heard_chars: heardChars,
      conversation_id: session.activeConversationId, ...speculation.outcome(),
    });
  };
  try {
    let replyText: string;
    let transcriptText: string | null = null;
    let actions: AgentActionOutcome = NO_AGENT_ACTION;
    // The tools the agent finished, saved with the reply so the next turn sees them.
    let toolParts: Array<Record<string, unknown>> = [];
    // A stray tap's few ms of audio is not sent to STT at all;
    // it ends the same visible way an empty turn does.
    if (tooShort) journal('v2.turn_too_short', { session: session.id, turn_id: turnRef, pcm_bytes: pcm.length });
    // No STT for this turn: close its stream now rather than at the reset after the reply.
    if (!hasAudio || tooShort || clearSilence) abortSttStream(session);
    if (hasAudio && !tooShort && !clearSilence) {
      const sttStartedAt = Date.now();
      try {
        transcriptText = await transcribeTurn(deps, session, pcm, turnRef, signal);
      } catch (error) {
        if (signal?.aborted) return cancelled('stt');
        const failure = classifyFailure('stt', error);
        if (!isSttAudioRejection(failure)) {
          m.fail('stt', failTurn(socket, session, turnRef, 'stt', error, turnStartedAt));
          return;
        }
        journalSttRejectedAudio(session, turnRef, failure, turnStartedAt);
      } finally {
        m.stt(Date.now() - sttStartedAt);
      }
    }
    if (transcriptText === null) speculation.discard('no_transcript');
    // Unattended no-input must not speak a retry prompt back into the mic.
    // Empty heard text also closes the current firmware's follow-up chain.
    if (handsFree && transcriptText === null) {
      m.empty();
      journalTurnStage({
        interface: 'cardputer', turnId: turnRef, stage: 'input', outcome: 'completed',
        fields: { board: sessionBoard(session), empty: true, reason: clearSilence ? 'clear_silence' : 'no_transcript' },
      });
      sendDto(socket, replyTextDto(turnRef, '', ''));
      sendStatus(socket, session, 'idle', turnRef);
      return;
    }
    const { memory, contextMs } = await memoryPrep;
    // The early context was resolved without the extraction worker.
    if (memory !== null && worker !== undefined) memory.worker = worker;
    preparedMemory = memory;
    if (transcriptText !== null && !signal?.aborted) {
      // A snapshot history read that settles from here on may hold the anchor.
      if (early !== undefined) early.sealed = true;
      prepare = prepareTurn(session, transcriptText, memory);
      // The early prep's gate: its Google and app tools, and every tool of a reply whose model started before this write,
      // wait for it (prepareTurn never rejects). A cancel closes it first (below), and the gate then stays closed.
      if (early !== undefined) prepare.then(early.openGate, early.openGate);
    }
    // An MP3 device hears the reply sentence by sentence while the agent
    // is still writing it. PCM devices keep batch.
    // Built on the first text delta, so a reply generateReply does not stream
    // (a game turn, a generate-only agent) never touches it.
    const live: { playback: SentencePlayback | null } = { playback: null };
    let streamedText = '';
    let firstTokenMs: number | undefined;
    const onText = transcriptText !== null && session.formatId === MP3_16K_MONO_FORMAT
      ? (delta: string): void => {
        streamedText += delta;
        firstTokenMs ??= Date.now() - turnStartedAt;
        m.firstToken(firstTokenMs);
        live.playback ??= createSentencePlayback(deps, socket, session, turnRef, turnStartedAt, signal);
        live.playback.push(delta);
      }
      : undefined;
    let stream: SentencePlaybackResult | null = null;
    if (transcriptText !== null) {
      try {
        // A speculative reply that started on these very words is the reply; it waits for the anchor write only before playback ends.
        // Otherwise (mismatch, aborted, or a committed run that ended not eligible) the real run takes over.
        const reply: GeneratedReply = await speculation.tryCommit(transcriptText, onText, signal, prepare)
          ?? await generateReply(deps, session, transcriptText, turnRef, memory, signal, contextMs, onText, prepare, early);
        // An early reply's model did not wait for the anchor write; the save below reads its anchor (memory.prepared).
        await prepare;
        replyText = reply.text;
        actions = reply.actions;
        toolParts = reply.toolParts;
        pushTurnScene(deps, session, memory?.userId, toolParts);
        m.agent(reply);
        // Streamed text with no sentence to speak (a fence or table alone) takes the normal fallback on this playback, not a second one.
        live.playback?.fallback(reply.text);
        // The screen's copy, as soon as the reply is final. A streamed
        // reply may already be playing; the device keeps reply_text for the
        // turn in flight until playback_end, so the card is unchanged.
        if (live.playback !== null) {
          // A game opened after some text streamed; its
          // guarded rest joins the same playback (one playback_start and end).
          if (reply.heldTail) live.playback.push(` ${reply.heldTail}`);
          sendDto(socket, replyTextDto(turnRef, transcriptText, replyText));
          // TTS failed after some audio went out: journaled (a 402 also
          // replaces the card) before playback_end ends the device's turn.
          stream = await live.playback.finish((played) => {
            if (played.cut === 'tts_failed') journalSpeechCut(socket, session, turnRef, played.ttsError, turnStartedAt, reply.text);
          });
        }
      } catch (error) {
        // Sentences already sent finish playing, then the stream ends cleanly.
        live.playback?.stop();
        await prepare;
        const partial = live.playback === null ? null : await live.playback.finish();
        if (memory?.prepared && streamedText.length > 0) {
          await persistTurn(deps, session, turnRef, transcriptText, streamedText, memory, partial?.heardChars ?? 0);
        }
        if (signal?.aborted) {
          if (partial?.started !== true) return cancelled('agent');
          cancelledStream(partial.downFrames, partial.heardChars);
          return;
        }
        // Audio already played and playback_end went out: journal the failure
        // but send no INTERNAL (the device would abort the audio it is playing).
        m.fail('agent', failTurn(socket, session, turnRef, 'agent', error, turnStartedAt, partial?.started !== true));
        return;
      }
    } else {
      replyText = EMPTY_TURN_REPLY;
      m.empty();
      journalTurnStage({
        interface: 'cardputer', turnId: turnRef, stage: 'input', outcome: 'completed',
        fields: { board: sessionBoard(session), empty: true },
      });
    }
    if (stream !== null && !stream.started) {
      // Nothing reached the device: the same ends as the batch path's.
      if (signal?.aborted) {
        cancelled('tts');
        if (transcriptText !== null) await persistTurn(deps, session, turnRef, transcriptText, replyText, memory, 0, toolParts);
        return;
      }
      if (stream.ttsError !== undefined) {
        if (transcriptText !== null && memory?.prepared) await persistTurn(deps, session, turnRef, transcriptText, replyText, memory, 0, toolParts);
        m.fail('tts', failTurn(socket, session, turnRef, 'tts', stream.ttsError, turnStartedAt, true, replyText));
        return;
      }
      // No speakable sentence was streamed: batch TTS decides.
      stream = null;
    }
    let playback: PlaybackResult;
    if (stream !== null) {
      playback = stream;
    } else {
      // The screen's copy of the turn, always before playback_start
      // (a streamed reply that fell back here already sent it).
      // User text: never journaled, on either side.
      if (live.playback === null) sendDto(socket, replyTextDto(turnRef, transcriptText ?? '', replyText));
      try {
        playback = await streamPlayback(deps, socket, session, replyText, turnRef, turnStartedAt, signal);
      } catch (error) {
        if (signal?.aborted) {
          cancelled('tts');
          if (transcriptText !== null) await persistTurn(deps, session, turnRef, transcriptText, replyText, memory, 0, toolParts);
          return;
        }
        m.fail('tts', failTurn(socket, session, turnRef, 'tts', error, turnStartedAt, true, replyText));
        if (transcriptText !== null && memory?.prepared) await persistTurn(deps, session, turnRef, transcriptText, replyText, memory, 0, toolParts);
        return;
      }
    }
    m.playback(playback, turnStartedAt);
    const { downFrames, replyBytes, totalFrames, firstAudioAt } = playback;
    // A reply played sentence by sentence (streamed live, or a finished one
    // streamPlayback split) knows how many of its characters were spoken, and
    // whether it was cut short.
    const sentences = stream ?? ('cut' in playback ? playback as SentencePlaybackResult : null);
    const spokenChars = sentences === null
      ? (totalFrames === 0 ? 0 : Math.floor((replyText.length * downFrames) / totalFrames))
      : Math.min(sentences.heardChars, replyText.length);
    if (signal?.aborted) {
      // The stream already sent playback_end and status idle. The heard
      // share of the reply is the share of its audio that went out.
      cancelledStream(downFrames, spokenChars);
      if (transcriptText !== null) await persistTurn(deps, session, turnRef, transcriptText, replyText, memory, spokenChars, toolParts);
      return;
    }
    // TTS failed mid-reply or the 3 MB cap was reached. The audio sent
    // was played; the full reply is stored, marked as cut to what was heard.
    const cut = sentences?.cut ?? null;
    m.complete(cut === 'tts_failed');
    // Persist the completed turn to the durable store. A failure here must not
    // block, delay, or alter the reply already streamed to the device.
    if (transcriptText !== null) await persistTurn(deps, session, turnRef, transcriptText, replyText, memory, cut === null ? undefined : spokenChars, toolParts);
    journal('v2.turn_completed', {
      session: session.id,
      turn_id: turnRef,
      conversation_id: session.activeConversationId,
      // 10 ms PCM frames (a message may batch several) and the audio_up messages that carried them.
      frames: pcmFrames(pcm.length),
      msgs: session.nextUplinkSeq,
      reply_bytes: replyBytes,
      down_frames: downFrames,
      // Pipeline completion is not action success: counts and an enum only.
      ...actions,
      // The speculative reply's fate and who ended the turn: enums and ms only.
      ...speculation.outcome(),
      // Who closed capture, inferred from message order and the turn_end lag (basis order); device-timing may refine it.
      ...eotJournalFields(endOfTurnEvidence(session, turnRef)),
      ...(firstAudioAt !== null ? { first_audio_ms: firstAudioAt - turnStartedAt } : {}),
      // Counts and ms only, never sentence text.
      // `streamed` is the live stream only; a finished reply played sentence by sentence reports the rest too.
      ...(stream !== null
        ? { streamed: true, ...(firstTokenMs !== undefined ? { first_token_ms: firstTokenMs } : {}) }
        : {}),
      ...(sentences !== null
        ? {
          sentences: sentences.sentences,
          tts_ms_per_sentence: sentences.ttsMs.join(','),
          ...(cut !== null ? { partial: cut } : {}),
          ...(sentences.charCapped ? { chars_capped: true } : {}),
        }
        : {}),
    });
    debugLog('turn.completed', {
      session: session.id,
      turn_ref: turnRef,
      had_audio: hasAudio,
      uplink_frames: pcmFrames(pcm.length),
      uplink_msgs: session.nextUplinkSeq,
      uplink_pcm_bytes: pcm.length,
      reply_text: replyText,
      reply_bytes: replyBytes,
      down_frames: downFrames,
      // A short count here against frame_count in turn.downlink_frames means
      // the stream was cut before the reply finished sending.
      total_ms: Date.now() - turnStartedAt,
    });
  } finally {
    // A live run that never committed (cancel, STT error, failure) stops here; a no-op after a commit.
    speculation.discard(signal?.aborted === true ? 'aborted' : 'error');
    // A turn that never wrote its anchor (no transcript, cancel, failure) closes the early gate; a no-op once it opened.
    early?.closeGate();
    recordTurnMetrics(deps, m, session, turnStartedAt);
    abortSttStream(session); // a turn that failed before STT must not leave its stream open
    resetSession(deps, session);
    // Completion observers may start the next turn immediately. Restore ready
    // synchronously before the remaining database cleanup yields control.
    // A turn that ended before generateReply awaited its anchor write still
    // waits for it here, so the anchor it made is released.
    await prepare;
    await releaseTurn(preparedMemory);
  }
}
