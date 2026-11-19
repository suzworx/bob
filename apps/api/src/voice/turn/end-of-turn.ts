/**
 * Semantic end of turn from the streaming STT hypothesis and trailing silence
 * (docs/voice-latency-rca.md "Sub-second SLA"). Pure: no I/O, no session.
 * The server decides the user has finished about 300 ms after they stop talking,
 * instead of the device's fixed 1000 ms silence.
 */

/** Silence that ends a turn: long enough to skip a breath, short enough for a ~300 ms end. */
export const EOT_TRAILING_SILENCE_MS = 300;
/** How long the hypothesis must hold unchanged before it counts as what the user said. */
export const EOT_STABLE_MS = 200;
/** Frame RMS (LSB) below which a frame is silence: above mic noise, below normal speech. */
const EOT_VOICE_FLOOR_RMS = 100;
/** A frame is voiced at this share of the turn's peak frame RMS, so a quiet mic still works. */
const EOT_VOICE_RELATIVE = 0.1;
/** Per 10 ms frame the peak decays by this much: one loud click stops hiding speech after ~140 ms (0.99 would take ~690 ms, past the silence rule). */
const EOT_PEAK_RELEASE = 0.95;

/** Consecutive voiced frames that resume an ended turn: a single click must not. */
const RESUME_VOICED_FRAMES = 3;
const FRAME_MS = 10;
const FRAME_SAMPLES = 160; // 10 ms at 16 kHz
const FRAME_BYTES = FRAME_SAMPLES * 2; // PCM16LE mono

/** The terminal punctuation a finished sentence or question ends on, ignoring closing quotes and brackets. */
const TERMINAL_PUNCTUATION = /[.?!…。？！]["'”’)\]]*$/u;

export interface EndOfTurnDetector {
  /** Feeds one uplink payload and the hypothesis that goes with it; returns the event it fired, if any. */
  observe(pcm: Uint8Array, hypothesis: string): 'end' | 'resume' | null;
  /** Audio ms seen this turn, from whole frames (never wall clock). */
  readonly audioMs: number;
  /** Audio ms since the last voiced frame. */
  readonly silenceMs: number;
}

/** True when the trimmed text ends a sentence or a question. Punctuation only, never words. */
export function endsUtterance(hypothesis: string): boolean {
  return TERMINAL_PUNCTUATION.test(hypothesis.trim());
}

/** The transcript with case, punctuation, symbols and spacing removed, for comparing hypothesis and final. */
export function normaliseTranscript(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]/gu, '').replace(/\s+/g, ' ').trim();
}

/** DC-removed RMS of one 10 ms PCM16LE frame starting at `offset`. */
function frameRms(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, FRAME_BYTES);
  let sum = 0;
  for (let i = 0; i < FRAME_SAMPLES; i += 1) sum += view.getInt16(i * 2, true);
  const mean = sum / FRAME_SAMPLES;
  let energy = 0;
  for (let i = 0; i < FRAME_SAMPLES; i += 1) {
    const centred = view.getInt16(i * 2, true) - mean;
    energy += centred * centred;
  }
  return Math.sqrt(energy / FRAME_SAMPLES);
}

export function createEndOfTurnDetector(): EndOfTurnDetector {
  let carry: Uint8Array = new Uint8Array(0);
  let audioMs = 0;
  let silenceMs = 0;
  let peakRms = 0;
  let voicedSeen = false;
  let voicedRun = 0;
  let ended = false;
  let hypothesis = '';
  let stableMs = 0;

  /** Any raw change restarts the stability clock: punctuation arriving is the signal to wait for.
   *  After an end only a change of words resumes; case or punctuation revisions stay ended. */
  function onHypothesis(next: string): 'resume' | null {
    if (next === hypothesis) return null;
    const wordsChanged = normaliseTranscript(next) !== normaliseTranscript(hypothesis);
    hypothesis = next;
    stableMs = 0;
    if (!ended || !wordsChanged) return null;
    ended = false;
    return 'resume';
  }

  /** RMS of each whole 10 ms frame in `pcm`; a partial frame is carried to the next call. */
  function takeFrameRms(pcm: Uint8Array): number[] {
    const bytes = new Uint8Array(carry.length + pcm.length);
    bytes.set(carry);
    bytes.set(pcm, carry.length);
    const rms: number[] = [];
    let offset = 0;
    for (; offset + FRAME_BYTES <= bytes.length; offset += FRAME_BYTES) rms.push(frameRms(bytes, offset));
    carry = bytes.slice(offset);
    return rms;
  }

  /** Advances the audio, stability, peak, voiced-run and silence clocks by one frame. */
  function trackFrame(rms: number): void {
    audioMs += FRAME_MS;
    stableMs += FRAME_MS;
    peakRms = Math.max(rms, peakRms * EOT_PEAK_RELEASE);
    const voiced = rms >= Math.max(EOT_VOICE_FLOOR_RMS, EOT_VOICE_RELATIVE * peakRms);
    if (!voiced) {
      voicedRun = 0;
      silenceMs += FRAME_MS;
      return;
    }
    voicedSeen = true;
    voicedRun += 1;
    silenceMs = 0;
  }

  /** The event the latest frame fires: a resume after enough voice, else an end after enough silence. */
  function onFrame(): 'end' | 'resume' | null {
    if (ended && voicedRun >= RESUME_VOICED_FRAMES) {
      ended = false;
      return 'resume';
    }
    if (!ended && voicedSeen && endsUtterance(hypothesis)
      && stableMs >= EOT_STABLE_MS && silenceMs >= EOT_TRAILING_SILENCE_MS) {
      ended = true;
      return 'end';
    }
    return null;
  }

  return {
    observe(pcm, nextHypothesis) {
      // Only one event per call: a suppressed one is re-evaluated on the next frame or call.
      let event: 'end' | 'resume' | null = onHypothesis(nextHypothesis);
      for (const rms of takeFrameRms(pcm)) {
        trackFrame(rms);
        if (event === null) event = onFrame();
      }
      return event;
    },
    get audioMs() { return audioMs; },
    get silenceMs() { return silenceMs; },
  };
}

/** Order basis: turn_end this soon after our end_of_turn means the device had not closed capture yet (observed 110-170 ms). */
const EOT_ORDER_LAG_MS = 400;
/** Device basis: the devices' own silence endpointer waits 1000 ms (Waveshare) or 1200 ms (Cardputer) after speech, so a shorter gap was ours. */
const EOT_DEVICE_SILENCE_GAP_MS = 950;

/** What the server knows about one turn's end. */
export interface EndOfTurnEvidence {
  /** ms epoch when this server sent end_of_turn for the turn; absent when it sent none. */
  sentAt?: number;
  /** ms epoch when this server received the turn's turn_end. */
  turnEndAt?: number;
  /** The device's turn_timing summary for the turn, once it has arrived (after playback). Device clock offsets. */
  timing?: { source: string; endReason: string; speechEndMs?: number | null; captureEndMs?: number | null };
}

export interface EndOfTurnSource {
  eot_source: 'server' | 'device';
  /** `device`: the device's own capture timing decided it. `order`: an inference from message order and timing. */
  eot_basis: 'device' | 'order';
}

/** turn_end minus our end_of_turn send, in ms, when both are known (turn_end is only stamped after a send). */
function eotLagMs({ sentAt, turnEndAt }: EndOfTurnEvidence): number | undefined {
  return sentAt === undefined || turnEndAt === undefined ? undefined : turnEndAt - sentAt;
}

/**
 * Who closed capture for a turn. With the device's turn_timing (end_reason, speech_end_ms and
 * capture_end_ms all present), the server closed it only when it sent end_of_turn before turn_end,
 * the device reported silence, the turn was not push-to-talk, and capture ended under
 * EOT_DEVICE_SILENCE_GAP_MS after the last voiced frame. Otherwise only the message order and the
 * turn_end lag are known: the server closed it when turn_end followed its send within EOT_ORDER_LAG_MS.
 */
export function endOfTurnSource(evidence: EndOfTurnEvidence): EndOfTurnSource {
  const lag = eotLagMs(evidence);
  const sentFirst = lag !== undefined && lag >= 0;
  const { timing } = evidence;
  const speechEnd = timing?.speechEndMs;
  const captureEnd = timing?.captureEndMs;
  if (timing !== undefined && typeof speechEnd === 'number' && typeof captureEnd === 'number') {
    const server = sentFirst && timing.endReason === 'silence' && timing.source !== 'ptt' && captureEnd - speechEnd < EOT_DEVICE_SILENCE_GAP_MS;
    return { eot_source: server ? 'server' : 'device', eot_basis: 'device' };
  }
  const server = lag !== undefined && lag >= 0 && lag <= EOT_ORDER_LAG_MS;
  return { eot_source: server ? 'server' : 'device', eot_basis: 'order' };
}

/** The journal fields for who closed a turn's capture: the source and basis, and the lag when both times are known. */
export function eotJournalFields(evidence: EndOfTurnEvidence): EndOfTurnSource & { eot_lag_ms?: number } {
  const lag = eotLagMs(evidence);
  return { ...endOfTurnSource(evidence), ...(lag === undefined ? {} : { eot_lag_ms: lag }) };
}
