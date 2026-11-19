import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { NoTranscriptGeneratedError } from 'ai';
import { capSpeechInput, traceSpan, toSpanAttrs, workflowTraceId } from '@bob/ai';
import { MIN_STT_AUDIO_MS, classifyFailure, isSttAudioRejection } from './turn-core.ts';
import { journalTurnStage } from './turn-journal.ts';
import { webSpeechRequestSchema, webVoiceRequestSchema } from '../web-schemas.ts';
import { withUser, type Db } from '../platform/db/db.ts';
import { getActive, setActive } from '../conversations/active.ts';
import { getAccountEvents } from '../devices/pairing-service.ts';
import { moduleJournal } from '../platform/logger.ts';
import { OUT_OF_CREDIT_ERROR, noteBudgetExhausted } from '../platform/observability/budget-alarm.ts';
import { readPcm16WavHeader } from './audio/wav.ts';
import { speakable } from './audio/speakable.ts';
import type { SpeechPort } from './speech-port.ts';

const journal = moduleJournal('voice');

/** What these routes need from the process: the database and speech. */
type RouteDeps = { getDb: () => Promise<Db>; speech: SpeechPort };

const maxAudioBytes = (): number => Number.parseInt(process.env.BOB_WEB_AUDIO_MAX_BYTES ?? '2097152', 10);
const isBase64 = (value: string): boolean => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);

/** The duration of a base64 PCM16 WAV in ms, or null when it is not one the
 *  header parser reads. Compressed formats (webm/ogg/m4a) are not decoded, so
 *  they get no length gate and only the STT 4xx mapping. */
function wavDurationMs(audio: string): number | null {
  try {
    const bytes = Buffer.from(audio, 'base64');
    const header = readPcm16WavHeader(bytes);
    const frameBytes = header.channels * (header.bitsPerSample / 8);
    return ((bytes.length - header.dataOffset) / frameBytes / header.sampleRateHz) * 1000;
  } catch {
    return null;
  }
}

/**
 * An accepted web voice turn moves the account's pointer to its active
 * conversation (surface `web_voice`); the transcript then goes through
 * /api/chat as the actual turn. A failed write must not fail the
 * transcription, so it is journaled and swallowed.
 */
async function noteAcceptedVoiceTurn(deps: RouteDeps, request: Request): Promise<void> {
  const userId = request.account?.userId;
  if (userId === undefined) return;
  try {
    const db = await deps.getDb();
    const active = await getActive(db, userId);
    if (active === null || active.conversationId === null) return;
    const changedAt = await withUser(db, userId, (tx) =>
      setActive(tx, userId, active.conversationId, 'web_voice'),
    );
    getAccountEvents().publish(userId, {
      type: 'active.changed',
      conversation_id: active.conversationId,
      title: active.title,
      surface: 'web_voice',
      changed_at: changedAt,
    });
    journal('v2.active_changed', { surface: 'web_voice' });
  } catch (error) {
    journal('v2.active_write_failed', {
      surface: 'web_voice',
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/** The response and journal events for a caught STT error. An empty
 *  transcript thrown as NoTranscriptGeneratedError is not an stt failure (the
 *  device path journals it 'completed'), so it skips the stt-failed event. */
interface SttFailureResponse {
  status: 422 | 502 | 503;
  /** The JSON error body; a spent budget (402) is web chat's out_of_credit. */
  error: { code: string; message?: string };
  /** Fields for stage:'stt' outcome:'failed', or undefined to skip that event. */
  sttFailedFields?: Record<string, unknown>;
  /** Fields for stage:'input' outcome:'failed', sent only when status is 422. */
  inputFailedFields?: Record<string, unknown>;
}

function sttFailureResponse(error: unknown, audioChars: number, format: string, durationMs: number): SttFailureResponse {
  if (NoTranscriptGeneratedError.isInstance(error)) {
    return {
      status: 422,
      error: { code: 'no_speech_detected' },
      inputFailedFields: { reason: 'no_speech_detected', kind: 'invalid_input', audio_chars: audioChars, duration_ms: durationMs },
    };
  }
  const failure = classifyFailure('stt', error);
  const outOfCredit = noteBudgetExhausted(failure, 'web_voice');
  const sttFailedFields = {
    audio_chars: audioChars,
    format,
    duration_ms: durationMs,
    kind: failure.kind,
    error_name: failure.errorName,
    ...(failure.upstreamStatus !== undefined ? { upstream_status: failure.upstreamStatus } : {}),
    ...(failure.timedOut ? { timed_out: true } : {}),
  };
  if (outOfCredit) return { status: 503, error: OUT_OF_CREDIT_ERROR, sttFailedFields };
  // The provider refused the audio itself -- the same
  // "didn't hear you" answer an empty transcript gets, not a 502.
  if (isSttAudioRejection(failure)) {
    return {
      status: 422,
      error: { code: 'no_speech_detected' },
      sttFailedFields,
      inputFailedFields: { reason: 'stt_rejected', kind: failure.kind, upstream_status: failure.upstreamStatus },
    };
  }
  return { status: 502, error: { code: 'upstream_error' }, sttFailedFields };
}

async function webVoiceHandler(deps: RouteDeps, request: Request, response: Response, turnId: string): Promise<void> {
  const started = Date.now();
  const parsed = webVoiceRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    journalTurnStage({ interface: 'web', turnId, stage: 'input', outcome: 'failed', fields: { reason: 'unsupported_format', kind: 'invalid_input' } });
    response.status(400).json({ error: { code: 'unsupported_format' } });
    return;
  }
  const maxChars = Math.ceil(maxAudioBytes() / 3) * 4;
  if (parsed.data.audio.length > maxChars) {
    journalTurnStage({ interface: 'web', turnId, stage: 'input', outcome: 'failed', fields: { reason: 'audio_too_large', kind: 'invalid_input', audio_chars: parsed.data.audio.length, max_chars: maxChars } });
    response.status(413).json({ error: { code: 'audio_too_large' } });
    return;
  }
  if (!isBase64(parsed.data.audio)) {
    journalTurnStage({ interface: 'web', turnId, stage: 'input', outcome: 'failed', fields: { reason: 'invalid_audio', kind: 'invalid_input', audio_chars: parsed.data.audio.length } });
    response.status(400).json({ error: { code: 'invalid_audio' } });
    return;
  }
  const audioMs = parsed.data.format === 'wav' ? wavDurationMs(parsed.data.audio) : null;
  if (audioMs !== null && audioMs < MIN_STT_AUDIO_MS) {
    journalTurnStage({ interface: 'web', turnId, stage: 'input', outcome: 'failed', fields: { reason: 'too_short', kind: 'invalid_input', audio_ms: Math.round(audioMs) } });
    response.status(422).json({ error: { code: 'no_speech_detected' } });
    return;
  }
  try {
    const result = await deps.speech.transcribeEncoded({ audio: parsed.data.audio, format: parsed.data.format });
    journalTurnStage({ interface: 'web', turnId, stage: 'stt', outcome: 'completed', fields: { audio_chars: parsed.data.audio.length, format: parsed.data.format, duration_ms: Date.now() - started } });
    if (!result.text.trim()) {
      journalTurnStage({ interface: 'web', turnId, stage: 'input', outcome: 'failed', fields: { reason: 'no_speech_detected', kind: 'invalid_input', audio_chars: parsed.data.audio.length, duration_ms: Date.now() - started } });
      response.status(422).json({ error: { code: 'no_speech_detected' } });
      return;
    }
    await noteAcceptedVoiceTurn(deps, request);
    response.json({ text: result.text });
  } catch (error) {
    const outcome = sttFailureResponse(error, parsed.data.audio.length, parsed.data.format, Date.now() - started);
    if (outcome.sttFailedFields) {
      journalTurnStage({ interface: 'web', turnId, stage: 'stt', outcome: 'failed', fields: outcome.sttFailedFields });
    }
    if (outcome.inputFailedFields) {
      journalTurnStage({ interface: 'web', turnId, stage: 'input', outcome: 'failed', fields: outcome.inputFailedFields });
    }
    response.status(outcome.status).json({ error: outcome.error });
  }
}

export const webVoice = (deps: RouteDeps) => (request: Request, response: Response): Promise<void> => {
  const turnId = randomUUID();
  const parsed = webVoiceRequestSchema.safeParse(request.body);
  return traceSpeechRequest('web-voice-transcription', request, response, turnId, parsed.success ? parsed.data.workflowId : undefined,
    () => webVoiceHandler(deps, request, response, turnId));
};

async function webSpeechHandler(deps: Pick<RouteDeps, 'speech'>, request: Request, response: Response, turnId: string): Promise<void> {
  const started = Date.now();
  const parsed = webSpeechRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    journalTurnStage({ interface: 'web', turnId, stage: 'input', outcome: 'failed', fields: { reason: 'invalid_request', kind: 'invalid_input' } });
    response.status(400).json({ error: { code: 'invalid_request' } });
    return;
  }
  try {
    const capped = capSpeechInput(parsed.data.text);
    const result = await deps.speech.synthesizeEncoded({ text: speakable(capped) || capped, format: 'mp3' });
    const audio = Buffer.from(result.audio, 'base64');
    response.status(200).type(result.contentType).set('Content-Length', String(audio.length));
    if (capped !== parsed.data.text) response.setHeader('X-Bob-Speech-Truncated', 'true');
    journalTurnStage({ interface: 'web', turnId, stage: 'tts', outcome: 'completed', fields: { text_chars: capped.length, audio_bytes: audio.length, format: result.format, duration_ms: Date.now() - started } });
    response.end(audio);
  } catch (error) {
    const failure = classifyFailure('tts', error);
    const outOfCredit = noteBudgetExhausted(failure, 'web_voice');
    journalTurnStage({
      interface: 'web',
      turnId,
      stage: 'tts',
      outcome: 'failed',
      fields: {
        text_chars: parsed.data.text.length,
        duration_ms: Date.now() - started,
        kind: failure.kind,
        error_name: failure.errorName,
        ...(failure.upstreamStatus !== undefined ? { upstream_status: failure.upstreamStatus } : {}),
        ...(failure.timedOut ? { timed_out: true } : {}),
      },
    });
    if (outOfCredit) response.status(503).json({ error: OUT_OF_CREDIT_ERROR });
    else response.status(502).json({ error: { code: 'upstream_error' } });
  }
}

export const webSpeech = (deps: Pick<RouteDeps, 'speech'>) => (request: Request, response: Response): Promise<void> => {
  const turnId = randomUUID();
  const parsed = webSpeechRequestSchema.safeParse(request.body);
  return traceSpeechRequest('web-speech-synthesis', request, response, turnId, parsed.success ? parsed.data.workflowId : undefined,
    () => webSpeechHandler(deps, request, response, turnId));
};

async function traceSpeechRequest(name: string, request: Request, response: Response, turnId: string, workflowId: string | undefined, run: () => Promise<void>): Promise<void> {
  const userId = request.account?.userId;
  const attrs = toSpanAttrs({
    surface: 'web', turnId, userId, metadata: { interface: 'web' },
    ...(workflowId && userId ? { workflowId, workflowNamespace: `web-voice/${userId}` } : {}),
  });
  const traceId = await workflowTraceId(attrs);
  if (traceId) response.setHeader('X-Bob-Trace-Id', traceId);
  return traceSpan(name, attrs, run);
}
