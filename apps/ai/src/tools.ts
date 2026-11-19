/**
 * Tool implementations for the assistant: text-to-speech, speech-to-text,
 * and current date/time. Each is callable directly or through an AI SDK
 * tool wrapper, with system-test stubs for BOB_SYSTEM_TEST=1.
 */
import { tool, transcribe, generateSpeech } from 'ai';
import { debugLog } from './debug.ts';
import { gateway, ttsTimingStore, type TtsFetchMarks } from './gateway.ts';
import { traceSpeechUsage } from './telemetry.ts';
import { traceSpeechCall } from './speech-observability.ts';
import { recordObservationMetrics } from './observation-metrics.ts';
import { providerErrorStatus } from './errors.ts';
import {
  BOB_STT_MODEL,
  BOB_STT_OPTIONS_NAMESPACE,
  STT_TIMEOUT_MS,
  STT_HEDGE_MS,
  BOB_STT_BACKUP_MODEL,
  BOB_TTS_MODEL,
  BOB_TTS_VOICE,
  TTS_TIMEOUT_MS,
  MAX_TTS_INPUT_CHARS,
} from './config.ts';

import {
  speechToTextInputSchema,
  speechToTextOutputSchema,
  currentDateTimeInputSchema,
  currentDateTimeOutputSchema,
  textToSpeechInputSchema,
  textToSpeechOutputSchema,
} from './schemas.ts';
import type {
  SpeechToTextInput,
  SpeechToTextOutput,
  TextToSpeechInput,
  TextToSpeechOutput,
} from './schemas.ts';

/** Ms from the start of the successful TTS HTTP attempt to its response headers, its last body byte, and the SDK's resolved speech. */
interface TtsHttpTiming { headers_ms: number; last_byte_ms: number; done_ms: number }

/** The TTS result plus, when the HTTP call was timed, where its time went (ms only). */
type TimedTextToSpeechOutput = TextToSpeechOutput & { timing?: TtsHttpTiming };

/** The attempt's timing, or undefined when the wrapper did not see a whole response. */
function ttsTimingFrom({ start, headers, lastByte }: TtsFetchMarks, done: number): TtsHttpTiming | undefined {
  if (start === undefined || headers === undefined || lastByte === undefined) return undefined;
  return { headers_ms: headers - start, last_byte_ms: lastByte - start, done_ms: done - start };
}

/**
 * Trims text to at most MAX_TTS_INPUT_CHARS, preferring the last sentence
 * boundary inside the limit so the spoken reply ends on a complete thought
 * rather than mid-word. Returns the text unchanged when it already fits.
 */
export function capSpeechInput(text: string, limit = MAX_TTS_INPUT_CHARS): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const lastBoundary = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  // Only honour a boundary in the last third, or a single long opening
  // sentence would collapse the reply to almost nothing.
  if (lastBoundary > limit * 0.6) return head.slice(0, lastBoundary + 1);
  // The ellipsis must fit inside the limit: this is a hard bound on what is
  // sent to TTS, not an approximate one.
  return `${head.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

/**
 * Records a bounded failure category, status and timing without the provider's
 * response message. Debug-only, and a no-op when off.
 */
function debugSpeechFailure(event: string, fields: Record<string, unknown>, error: unknown, startedAt: number): void {
  debugLog(event, {
    ...fields,
    elapsed_ms: Date.now() - startedAt,
    error_name: error instanceof Error && error.name === 'TimeoutError' ? 'TimeoutError' : 'SpeechError',
    upstream_status: providerErrorStatus(error),
  });
}

const NETWORK_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']);

function isTimeoutOrAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return true;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code);
}

/**
 * The Gateway's speech doGenerate wraps every failure (asGatewayError in
 * @ai-sdk/gateway), so our own AbortSignal.timeout and a raw network error
 * both arrive as a GatewayResponseError with the real cause one or two
 * `.cause` levels down, not as a bare TimeoutError/AbortError.
 */
function ttsErrorCauses(error: unknown): unknown[] {
  const cause1 = error instanceof Error ? error.cause : undefined;
  const cause2 = cause1 instanceof Error ? cause1.cause : undefined;
  return [cause1, cause2];
}

/**
 * Classifies a TTS failure as retry-eligible, or undefined to fail fast. Only
 * a timeout/abort, a network/transport failure, or a 5xx from the gateway
 * are worth one retry; a 4xx (e.g. a bad voice) never is.
 */
function classifyTtsRetry(error: unknown): 'timeout' | '5xx' | 'network' | undefined {
  if (isTimeoutOrAbort(error) || (error instanceof Error && error.name === 'GatewayTimeoutError')) return 'timeout';
  const causes = ttsErrorCauses(error);
  if (causes.some(isTimeoutOrAbort)) return 'timeout';
  if (causes.some(isNetworkFailure)) return 'network';
  const status = providerErrorStatus(error);
  return status !== undefined && status >= 500 ? '5xx' : undefined;
}

/**
 * Calls generateSpeech via `buildParams` (a factory so each attempt gets its
 * own AbortSignal.timeout); on a retry-eligible failure logs ai.tts_retry and
 * tries once more. A non-retryable or second failure logs the terminal
 * ai.tts_failed and rethrows.
 */
async function generateSpeechWithRetry(
  buildParams: () => Parameters<typeof generateSpeech>[0],
  model: string,
  failureFields: Record<string, unknown>,
  startedAt: number,
): Promise<Awaited<ReturnType<typeof generateSpeech>>> {
  try {
    return await generateSpeech(buildParams());
  } catch (error) {
    const reason = classifyTtsRetry(error);
    if (!reason) {
      debugSpeechFailure('ai.tts_failed', failureFields, error, startedAt);
      throw error;
    }
    debugLog('ai.tts_retry', { model, attempt: 2, reason, elapsed_ms: Date.now() - startedAt });
  }
  try {
    return await generateSpeech(buildParams());
  } catch (error) {
    debugSpeechFailure('ai.tts_failed', failureFields, error, startedAt);
    throw error;
  }
}

/** Converts text to audio through the configured Gateway TTS model. */
export async function synthesizeSpeech(
  input: TextToSpeechInput,
): Promise<TimedTextToSpeechOutput> {
  if (!input.text.trim()) throw new Error('Text to synthesize must not be empty');
  return traceSpeechCall('tts', () => synthesizeSpeechCall(input), capSpeechInput(input.text).length);
}

async function synthesizeSpeechCall(input: TextToSpeechInput): Promise<TimedTextToSpeechOutput> {
  const { text: rawText, model, voice, format, speed } = input;
  const text = capSpeechInput(rawText);
  const ttsStartedAt = Date.now();
  if (text !== rawText) {
    debugLog('ai.tts_input_capped', {
      original_chars: rawText.length,
      capped_chars: text.length,
      limit: MAX_TTS_INPUT_CHARS,
    });
  }
  debugLog('ai.tts_request', {
    model: model ?? BOB_TTS_MODEL,
    voice: voice ?? BOB_TTS_VOICE,
    response_format: format ?? 'mp3',
    speed,
    text_chars: text.length,
    original_chars: rawText.length,
    // Recorded in full: reply length drives both TTS latency and the number
    // of downlink frames, so a truncated or wrong-language reply is only
    // diagnosable with the actual text.
    text,
    timeout_ms: TTS_TIMEOUT_MS,
  });
  const marks: TtsFetchMarks = {};
  const result = await ttsTimingStore.run(marks, () => generateSpeechWithRetry(
    () => ({
      // The instance, not the id, so the call goes through the gateway's timing fetch.
      model: gateway.speechModel(model ?? BOB_TTS_MODEL),
      text,
      voice: voice ?? BOB_TTS_VOICE,
      outputFormat: format ?? 'mp3',
      ...(speed ? { speed } : {}),
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    }),
    model ?? BOB_TTS_MODEL,
    { model: model ?? BOB_TTS_MODEL, voice: voice ?? BOB_TTS_VOICE, response_format: format ?? 'mp3', text_chars: text.length },
    ttsStartedAt,
  ));
  // Taken as the SDK hands the speech back: the gap from the last byte is its JSON parse and base64.
  const doneAt = performance.now();

  debugLog('ai.tts_response', {
    audio_bytes: result.audio.uint8Array.byteLength,
    media_type: result.audio.mediaType,
    format: result.audio.format,
    warnings: result.warnings.length,
    elapsed_ms: Date.now() - ttsStartedAt,
  });
  // Billable usage the AI SDK never reports: input characters are
  // recorded as span units. Usage only, never the text.
  traceSpeechUsage({ kind: 'tts', model: model ?? BOB_TTS_MODEL, inputUnits: text.length });

  const timing = ttsTimingFrom(marks, doneAt);
  return {
    audio: result.audio.base64,
    format: result.audio.format,
    contentType: result.audio.mediaType,
    ...(timing ? { timing } : {}),
  };
}

/** Converts base64 audio to text through the configured Gateway STT model. */
export async function transcribeAudio(
  input: SpeechToTextInput,
): Promise<SpeechToTextOutput> {
  return traceSpeechCall('stt', () => transcribeAudioCall(input));
}

type TranscribeResult = Awaited<ReturnType<typeof transcribe>>;
type SttAttempt = { model: string; controller: AbortController; done: Promise<{ model: string; result: TranscribeResult }> };

/**
 * Runs `run` on the primary model and, when it has not answered after STT_HEDGE_MS (or failed sooner),
 * on the backup too. The first success wins and the other is aborted. Both share one STT_TIMEOUT_MS
 * deadline; if both fail, the primary's error is thrown, as it would be without a backup.
 */
async function hedgedTranscribe(
  primary: string,
  backup: string | undefined,
  run: (model: string, signal: AbortSignal) => Promise<TranscribeResult>,
): Promise<{ model: string; result: TranscribeResult; hedged: boolean }> {
  const deadline = AbortSignal.timeout(STT_TIMEOUT_MS);
  const launch = (model: string): SttAttempt => {
    const controller = new AbortController();
    const done = run(model, AbortSignal.any([deadline, controller.signal])).then((result) => ({ model, result }));
    return { model, controller, done };
  };
  const first = launch(primary);
  if (!backup) return { ...(await first.done), hedged: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const early = await Promise.race([
    first.done.then((won) => won, () => undefined),
    new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), STT_HEDGE_MS); }),
  ]);
  clearTimeout(timer);
  if (early) return { ...early, hedged: false };
  const attempts = [first, launch(backup)];
  try {
    const won = await Promise.any(attempts.map((attempt) => attempt.done));
    for (const attempt of attempts) if (attempt.model !== won.model) attempt.controller.abort();
    return { ...won, hedged: true };
  } catch (error) {
    throw error instanceof AggregateError ? error.errors[0] : error;
  }
}

async function transcribeAudioCall(input: SpeechToTextInput): Promise<SpeechToTextOutput> {
  const { audio, format, model, language } = input;
  const sttStartedAt = Date.now();
  const primaryModel = model ?? BOB_STT_MODEL;
  const backupModel = STT_HEDGE_MS > 0 && BOB_STT_BACKUP_MODEL !== primaryModel ? BOB_STT_BACKUP_MODEL : undefined;
  debugLog('ai.stt_request', {
    model: primaryModel,
    backup_model: backupModel ?? null,
    hedge_ms: backupModel ? STT_HEDGE_MS : 0,
    format,
    // False means the provider is auto-detecting, which can reply in a language the speaker never used.
    language_sent: language !== undefined,
    language: language ?? null,
    audio_b64_chars: audio.length,
    timeout_ms: STT_TIMEOUT_MS,
  });
  const { model: effectiveModel, result, hedged } = await hedgedTranscribe(primaryModel, backupModel, async (attemptModel, abortSignal) => {
    try {
      return await transcribe({
        model: attemptModel,
        audio,
        providerOptions: {
          // Per model: the primary and the backup can belong to different vendors.
          [BOB_STT_OPTIONS_NAMESPACE || attemptModel.split('/')[0]!]: {
            ...(language ? { language } : {}),
          },
        },
        maxRetries: 0,
        abortSignal,
      });
    } catch (error) {
      // A loser aborted because the other request won is not a failure.
      const lostRace = abortSignal.aborted && (abortSignal.reason as Error | undefined)?.name !== 'TimeoutError';
      if (!lostRace) {
        debugSpeechFailure('ai.stt_failed', { model: attemptModel, format, audio_b64_chars: audio.length }, error, sttStartedAt);
      }
      throw error;
    }
  });
  debugLog('ai.stt_response', {
    // The transcript itself: the only way to see that the speaker was
    // understood in the wrong language before the agent ever replies.
    text: result.text,
    text_chars: result.text.length,
    seconds: result.durationInSeconds,
    language_detected: result.language,
    language_mismatch: language !== undefined && result.language !== undefined && language !== result.language,
    stt_model_won: effectiveModel,
    stt_hedged: hedged,
    elapsed_ms: Date.now() - sttStartedAt,
  });
  // Billable usage the AI SDK never reports: audio seconds are recorded as a
  // metric, for the winning request only (an aborted loser reports none).
  // Skipped when the provider reports no duration.
  if (result.durationInSeconds !== undefined) {
    recordObservationMetrics([{ name: 'speech.audio_ms', value: Math.round(result.durationInSeconds * 1000) }]);
    traceSpeechUsage({ kind: 'stt', model: effectiveModel, inputUnits: result.durationInSeconds });
  }

  return {
    text: result.text,
    // The winning model, which the turn journal reports as `model`.
    model: effectiveModel,
    ...(result.durationInSeconds !== undefined
      ? {
          usage: {
            seconds: result.durationInSeconds,
          },
        }
      : {}),
  };
}

export const textToSpeechTool = tool({
  description: 'Convert text into speech audio using a text-to-speech model.',
  inputSchema: textToSpeechInputSchema,
  outputSchema: textToSpeechOutputSchema,
  execute: async (input) => synthesizeSpeech(input),
});

export const speechToTextTool = tool({
  description: 'Transcribe base64-encoded audio into text using an STT model.',
  inputSchema: speechToTextInputSchema,
  outputSchema: speechToTextOutputSchema,
  execute: async (input) => transcribeAudio(input),
});

/**
 * Builds the currentDateTime tool. With no `defaultTimeZone` a call that names
 * no timezone uses the server's zone; a per-account agent passes the account's
 * zone so "what time is it" answers in the user's time.
 */
export function createCurrentDateTimeTool(defaultTimeZone?: string) {
  return tool({
    description: 'Get the current date and time for an IANA timezone.',
    inputSchema: currentDateTimeInputSchema,
    outputSchema: currentDateTimeOutputSchema,
    execute: ({ timezone }) => {
      const resolvedTimezone = timezone ?? defaultTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const now = new Date();

      try {
        const dateFormatter = new Intl.DateTimeFormat('en-US', {
          timeZone: resolvedTimezone,
          dateStyle: 'full',
        });
        const timeFormatter = new Intl.DateTimeFormat('en-US', {
          timeZone: resolvedTimezone,
          timeStyle: 'long',
        });

        return {
          iso: now.toISOString(),
          timezone: resolvedTimezone,
          date: dateFormatter.format(now),
          time: timeFormatter.format(now),
        };
      } catch (error) {
        throw new Error(
          `Invalid timezone "${resolvedTimezone}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  });
}

/** AI SDK tool returning the current date and time; a bare call uses the server zone. */
export const currentDateTimeTool = createCurrentDateTimeTool();

/** Tools offered to the agent. The speech tools are not: the voice pipeline runs STT/TTS itself. */
export const assistantTools = {
  currentDateTime: currentDateTimeTool,
};
