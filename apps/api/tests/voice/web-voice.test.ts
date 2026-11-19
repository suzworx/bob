import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  GatewayAuthenticationError,
  GatewayFailedDependencyError,
  GatewayInternalServerError,
  GatewayInvalidRequestError,
  GatewayModelNotFoundError,
} from '@ai-sdk/gateway';
import { NoTranscriptGeneratedError } from 'ai';

const tracing = vi.hoisted(() => ({ active: false, finished: 0 }));

vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const { createHash } = await import('node:crypto');
  const factories: Factory[] = [
    ((async (importOriginal) => ({
  audioFormatSchema: z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']),
  transcribeAudio: vi.fn(async () => ({ text: 'hello' })),
  synthesizeSpeech: vi.fn(async () => ({ audio: Buffer.from('mp3').toString('base64'), format: 'mp3', contentType: 'audio/mpeg' })),
  traceSpan: vi.fn(async (_name: string, _attrs: unknown, run: () => Promise<unknown>) => {
    tracing.active = true;
    try { return await run(); } finally { tracing.active = false; tracing.finished += 1; }
  }),
  capSpeechInput: vi.fn((text: string) => text.length > 3 ? `${text.slice(0, 3)}...` : text),
  // The real predicates (@bob/ai errors.ts), so Core's classifyFailure
  // sees Gateway errors exactly as production does.
  providerErrorStatus: (await importOriginal<typeof import('@bob/ai')>()).providerErrorStatus,
  isProviderError: (await importOriginal<typeof import('@bob/ai')>()).isProviderError,
}) ) as Factory),
  ];
  let current: object = { ...original, workflowTraceId: async (attrs: Parameters<typeof original.workflowTraceId>[0]): Promise<string> => createHash('sha256').update(JSON.stringify([attrs.workflowNamespace, attrs.workflowId ?? attrs.turnId])).digest('hex').slice(0, 32) };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

vi.mock('../../src/platform/logger.ts', async () => (await import('../helpers/journal-mock.ts')).loggerMock());

import { traceWebTurn } from '../../src/conversations/chat-stream.ts';
import { webSpeech, webVoice } from '../../src/voice/http.ts';
import { closeDb, setSharedDb } from '../../src/platform/db/db.ts';
import { asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import { journal } from '../../src/platform/logger.ts';
import { createPcm16Wav } from '../../src/voice/audio/wav.ts';
import { transcribeAudio, synthesizeSpeech, traceSpan } from '@bob/ai';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
function response() { return { statusCode: 200, headers: {} as Record<string, string>, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; }, type(value: string) { this.headers['content-type'] = value; return this; }, set(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; }, setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; }, end(body?: unknown) { this.body = body; } }; }

// The turn paths under test record a turn metric through getDb(), so the file
// shares one real test database with getDb(); without it, getDb() falls back.
let pg: TestDb;
beforeAll(async () => {
  pg = await createTestDb();
  setSharedDb(Promise.resolve(asDb(pg)));
});
afterAll(async () => {
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

describe('browser voice routes', () => {
  it('joins speech workflow roots to journal ids without capturing payloads', async () => {
    vi.mocked(traceSpan).mockClear(); vi.mocked(journal).mockClear();
    vi.mocked(transcribeAudio).mockImplementationOnce(async () => {
      expect(tracing.active).toBe(true);
      return { text: 'hello' } as never;
    });
    const voiceResult = response();
    const speechResult = response();
    const end = vi.spyOn(speechResult, 'end').mockImplementation(() => { expect(tracing.active).toBe(true); });
    await webVoice(appDeps)({ body: { audio: 'YQ==', format: 'webm' } } as never, voiceResult as never);
    await webSpeech(appDeps)({ body: { text: 'private reply' } } as never, speechResult as never);
    expect(voiceResult.body).toEqual({ text: 'hello' });
    expect(end).toHaveBeenCalledTimes(1);
    expect(tracing.active).toBe(false);
    expect(tracing.finished).toBe(2);
    expect(vi.mocked(traceSpan).mock.calls.map(([name]) => name)).toEqual(['web-voice-transcription', 'web-speech-synthesis']);
    const speechEvents = vi.mocked(journal).mock.calls.filter(([name]) => name === 'v2.turn_stage_stt_completed' || name === 'v2.turn_stage_tts_completed');
    for (const [index, [, attrs]] of vi.mocked(traceSpan).mock.calls.entries()) {
      expect(attrs.turnId).toBe(speechEvents[index]?.[1]?.turn_id);
      expect(attrs.metadata).toEqual({ interface: 'web', turn_id: attrs.turnId });
      expect(JSON.stringify(attrs)).not.toMatch(/private reply|YQ==/);
    }
  });
  it('joins transcription and synthesis by an authenticated voice workflow', async () => {
    vi.mocked(traceSpan).mockClear();
    const workflowId = '11111111-1111-4111-8111-111111111111';
    const account = { userId: 'voice-account' };
    const stt = response(); const tts = response();
    await webVoice(appDeps)({ account, body: { audio: 'YQ==', format: 'webm', workflowId } } as never, stt as never);
    await webSpeech(appDeps)({ account, body: { text: 'reply', workflowId } } as never, tts as never);
    const attrs = vi.mocked(traceSpan).mock.calls.map(([, value]) => value);
    expect(attrs).toHaveLength(2);
    for (const value of attrs) expect(value).toMatchObject({ workflowId, workflowNamespace: 'web-voice/voice-account' });
    const chatTrace = await traceWebTurn('conversation', account.userId, 'message-id', (traceId) => traceId, workflowId);
    expect(stt.headers['x-bob-trace-id']).toMatch(/^[a-f0-9]{32}$/);
    expect(stt.headers['x-bob-trace-id']).toBe(tts.headers['x-bob-trace-id']);
    expect(chatTrace).toBe(stt.headers['x-bob-trace-id']);
    const otherAccount = await traceWebTurn('conversation', 'other-account', 'message-id', (traceId) => traceId, workflowId);
    expect(otherAccount).not.toBe(chatTrace);
  });
  it('transcribes valid base64 without using the device codec', async () => { const result = response(); await webVoice(appDeps)({ body: { audio: Buffer.from('audio').toString('base64'), format: 'webm' } } as never, result as never); expect(result.body).toEqual({ text: 'hello' }); });
  it('rejects malformed or oversized audio before decoding', async () => { const invalid = response(); await webVoice(appDeps)({ body: { audio: 'not-base64', format: 'webm' } } as never, invalid as never); expect(invalid.statusCode).toBe(400); const large = response(); await webVoice(appDeps)({ body: { audio: 'A'.repeat(3_000_000), format: 'webm' } } as never, large as never); expect(large.statusCode).toBe(413); });
  it('returns speech bytes and truncation metadata', async () => { const result = response(); await webSpeech(appDeps)({ body: { text: 'long reply' } } as never, result as never); expect(result.headers['content-type']).toBe('audio/mpeg'); expect(result.headers['x-bob-speech-truncated']).toBe('true'); });
  it('rejects unsupported formats and empty transcription', async () => { const unsupported = response(); await webVoice(appDeps)({ body: { audio: 'YQ==', format: 'xyz' } } as never, unsupported as never); expect(unsupported.statusCode).toBe(400); vi.mocked(transcribeAudio).mockResolvedValueOnce({ text: '' } as never); const empty = response(); await webVoice(appDeps)({ body: { audio: 'YQ==', format: 'webm' } } as never, empty as never); expect(empty.statusCode).toBe(422); });
  it('maps provider failures to stable upstream errors', async () => { vi.mocked(transcribeAudio).mockRejectedValueOnce(new Error('provider')); const result = response(); await webVoice(appDeps)({ body: { audio: 'YQ==', format: 'webm' } } as never, result as never); expect(result.statusCode).toBe(502); vi.mocked(synthesizeSpeech).mockRejectedValueOnce(new Error('provider')); const speech = response(); await webSpeech(appDeps)({ body: { text: 'hello' } } as never, speech as never); expect(speech.statusCode).toBe(502); });
  // #1041 follow-up: a spent AI budget answers the web voice routes the way it
  // answers web chat (503 out_of_credit), so the page can say so plainly.
  it('a provider 402 answers 503 out_of_credit on both voice routes, like web chat', async () => {
    const spent = (): GatewayInternalServerError => new GatewayInternalServerError({ message: 'API key budget exceeded', statusCode: 402 });
    const outOfCredit = { error: { code: 'out_of_credit', message: 'The AI service is out of credit.' } };
    vi.mocked(transcribeAudio).mockRejectedValueOnce(spent());
    const voice = response();
    await webVoice(appDeps)({ body: { audio: 'YQ==', format: 'webm' } } as never, voice as never);
    expect({ status: voice.statusCode, body: voice.body }).toEqual({ status: 503, body: outOfCredit });
    vi.mocked(synthesizeSpeech).mockRejectedValueOnce(spent());
    const speech = response();
    await webSpeech(appDeps)({ body: { text: 'hello' } } as never, speech as never);
    expect({ status: speech.statusCode, body: speech.body }).toEqual({ status: 503, body: outOfCredit });
  });
  it('speaks only the capped text, so an oversized body never reaches speakable (#1423)', async () => {
    await webSpeech(appDeps)({ body: { text: 'hello there' } } as never, response() as never);
    expect(vi.mocked(synthesizeSpeech).mock.lastCall?.[0]).toMatchObject({ text: 'hel...' });
  });
  it('never sends a web address to speech when the browser reads a reply aloud (#1423)', async () => {
    await webSpeech(appDeps)({ body: { text: 'Add fill-ups at https://your-app-host/apps/05341dbd-2f6a-4c1e-9a77-3f1e8b2c4d10.' } } as never, response() as never);
    expect(JSON.stringify(vi.mocked(synthesizeSpeech).mock.lastCall)).not.toContain('your-app-host');
  });
  it('rejects empty speech text', async () => { const result = response(); await webSpeech(appDeps)({ body: { text: '' } } as never, result as never); expect(result.statusCode).toBe(400); });

  // #898/#912: the AI SDK throws NoTranscriptGeneratedError for an empty
  // transcript instead of returning one; it must land on the same
  // no_speech_detected answer, not the generic upstream 502.
  it('maps NoTranscriptGeneratedError to no_speech_detected, unlike a generic error', async () => {
    vi.mocked(transcribeAudio).mockRejectedValueOnce(new NoTranscriptGeneratedError({ responses: [] }));
    const noTranscript = response();
    await webVoice(appDeps)({ body: { audio: 'YQ==', format: 'webm' } } as never, noTranscript as never);
    expect(noTranscript.statusCode).toBe(422);
    expect((noTranscript.body as { error: { code: string } }).error.code).toBe('no_speech_detected');

    vi.mocked(transcribeAudio).mockRejectedValueOnce(new Error('boom'));
    const generic = response();
    await webVoice(appDeps)({ body: { audio: 'YQ==', format: 'webm' } } as never, generic as never);
    expect(generic.statusCode).toBe(502);
    expect((generic.body as { error: { code: string } }).error.code).toBe('upstream_error');
  });

  // Every voice failure used to be swallowed by a bare `catch {}`: a 502 left no
  // trace at all, so the only evidence a turn had failed was the reader saying so.
  it('journals every failure path, with the upstream status and no payload', async () => {
    vi.mocked(journal).mockClear();
    vi.mocked(transcribeAudio).mockRejectedValueOnce(new GatewayAuthenticationError({ statusCode: 400 }));
    await webVoice(appDeps)({ body: { audio: 'YQ==', format: 'webm' } } as never, response() as never);
    // A 400 now ends as no_speech_detected (CP-SRV-SHORT); the stt failure is still journaled first.
    const [event, meta] = vi.mocked(journal).mock.calls.find((call) => call[0] === 'v2.turn_stage_stt_failed') as [string, Record<string, unknown>];
    expect(event).toBe('v2.turn_stage_stt_failed');
    expect(meta.interface).toBe('web');
    expect(meta.stage).toBe('stt');
    expect(meta.upstream_status).toBe(400);
    expect(meta.error_name).toBe('GatewayAuthenticationError');
    // Principle II: the provider's response body is payload and must not appear.
    expect(JSON.stringify(meta)).not.toContain('secret transcript');

    vi.mocked(journal).mockClear();
    vi.mocked(synthesizeSpeech).mockRejectedValueOnce(new Error('boom'));
    await webSpeech(appDeps)({ body: { text: 'hello' } } as never, response() as never);
    const last = vi.mocked(journal).mock.calls.at(-1)!;
    expect(last[0]).toBe('v2.turn_stage_tts_failed');
    expect((last[1] as Record<string, unknown>).interface).toBe('web');
    expect((last[1] as Record<string, unknown>).stage).toBe('tts');
  });

  it('journals rejections, not just upstream failures', async () => {
    for (const [body, reason] of [
      [{ audio: 'not-base64', format: 'webm' }, 'invalid_audio'],
      [{ audio: 'A'.repeat(3_000_000), format: 'webm' }, 'audio_too_large'],
      [{ audio: 'YQ==', format: 'xyz' }, 'unsupported_format'],
    ] as Array<[Record<string, unknown>, string]>) {
      vi.mocked(journal).mockClear();
      await webVoice(appDeps)({ body } as never, response() as never);
      const [event, meta] = vi.mocked(journal).mock.calls.at(-1) as [string, Record<string, unknown>];
      expect(event).toBe('v2.turn_stage_input_failed');
      expect(meta.interface).toBe('web');
      expect(meta.stage).toBe('input');
      expect(meta.kind).toBe('invalid_input');
      expect(meta.reason).toBe(reason);
    }
  });

  it('keeps every rejection and failure status + code through Core classification (T021)', async () => {
    const matrix: Array<[Record<string, unknown>, number, string]> = [
      [{ audio: 'not-base64', format: 'webm' }, 400, 'invalid_audio'],
      [{ audio: 'A'.repeat(3_000_000), format: 'webm' }, 413, 'audio_too_large'],
      [{ audio: 'YQ==', format: 'xyz' }, 400, 'unsupported_format'],
    ];
    for (const [body, status, code] of matrix) {
      const result = response();
      await webVoice(appDeps)({ body } as never, result as never);
      expect(result.statusCode).toBe(status);
      expect((result.body as { error: { code: string } }).error.code).toBe(code);
    }
    vi.mocked(transcribeAudio).mockRejectedValueOnce(new GatewayAuthenticationError({ statusCode: 503 }));
    const upstream = response();
    await webVoice(appDeps)({ body: { audio: 'YQ==', format: 'webm' } } as never, upstream as never);
    expect(upstream.statusCode).toBe(502);
    expect((upstream.body as { error: { code: string } }).error.code).toBe('upstream_error');
    vi.mocked(transcribeAudio).mockResolvedValueOnce({ text: '' } as never);
    const empty = response();
    await webVoice(appDeps)({ body: { audio: 'YQ==', format: 'webm' } } as never, empty as never);
    expect(empty.statusCode).toBe(422);
    expect((empty.body as { error: { code: string } }).error.code).toBe('no_speech_detected');
  });
});

describe('browser voice: too-short or provider-rejected audio (CP-SRV-SHORT)', () => {
  /** A base64 PCM16 WAV of `ms` milliseconds at `rateHz` mono. */
  function wavBase64(ms: number, rateHz = 16_000): string {
    const pcm = Buffer.alloc(Math.round((rateHz * ms) / 1000) * 2, 1);
    return createPcm16Wav(pcm, { sampleRateHz: rateHz, channels: 1 }).toString('base64');
  }

  function code(result: ReturnType<typeof response>): string {
    return (result.body as { error: { code: string } }).error.code;
  }

  it('a WAV under 300 ms is no_speech_detected without calling STT', async () => {
    vi.mocked(transcribeAudio).mockClear();
    vi.mocked(journal).mockClear();
    const result = response();
    await webVoice(appDeps)({ body: { audio: wavBase64(10), format: 'wav' } } as never, result as never);
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(result.statusCode).toBe(422);
    expect(code(result)).toBe('no_speech_detected');
    const [event, meta] = vi.mocked(journal).mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(event).toBe('v2.turn_stage_input_failed');
    expect(meta.reason).toBe('too_short');
    expect(meta.audio_ms).toBe(10);
  });

  it('measures WAV duration at its own sample rate', async () => {
    vi.mocked(transcribeAudio).mockClear();
    const short = response();
    await webVoice(appDeps)({ body: { audio: wavBase64(299, 48_000), format: 'wav' } } as never, short as never);
    expect(short.statusCode).toBe(422);
    const long = response();
    await webVoice(appDeps)({ body: { audio: wavBase64(300, 48_000), format: 'wav' } } as never, long as never);
    expect(long.body).toEqual({ text: 'hello' });
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it('compressed formats have no length gate: a tiny webm still reaches STT', async () => {
    vi.mocked(transcribeAudio).mockClear();
    const result = response();
    await webVoice(appDeps)({ body: { audio: 'YQ==', format: 'webm' } } as never, result as never);
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(result.body).toEqual({ text: 'hello' });
  });

  it.each([400, 413, 415, 422])('an STT provider %i is no_speech_detected, not upstream_error', async (statusCode) => {
    vi.mocked(transcribeAudio).mockRejectedValueOnce(new GatewayInternalServerError({ statusCode }));
    const result = response();
    await webVoice(appDeps)({ body: { audio: wavBase64(1000), format: 'wav' } } as never, result as never);
    expect(result.statusCode).toBe(422);
    expect(code(result)).toBe('no_speech_detected');
  });

  it('a typed GatewayInvalidRequestError 400 is no_speech_detected', async () => {
    vi.mocked(journal).mockClear();
    vi.mocked(transcribeAudio).mockRejectedValueOnce(new GatewayInvalidRequestError({ statusCode: 400 }));
    const result = response();
    await webVoice(appDeps)({ body: { audio: 'YQ==', format: 'webm' } } as never, result as never);
    expect(result.statusCode).toBe(422);
    const [event, meta] = vi.mocked(journal).mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(event).toBe('v2.turn_stage_input_failed');
    expect(meta.reason).toBe('stt_rejected');
    expect(meta.upstream_status).toBe(400);
  });

  it.each([
    ['401', new GatewayAuthenticationError({ statusCode: 401 })],
    ['403', new GatewayInternalServerError({ statusCode: 403 })],
    ['404 model not found', new GatewayModelNotFoundError({ statusCode: 404, modelId: 'nope' })],
    ['408', new GatewayInternalServerError({ statusCode: 408 })],
    ['424 failed dependency', new GatewayFailedDependencyError({ statusCode: 424 })],
    ['429', new GatewayInternalServerError({ statusCode: 429 })],
    ['500', new GatewayInternalServerError({ statusCode: 500 })],
  ])('an STT provider %s keeps the 502 upstream_error', async (_label, error) => {
    vi.mocked(transcribeAudio).mockRejectedValueOnce(error);
    const result = response();
    await webVoice(appDeps)({ body: { audio: 'YQ==', format: 'webm' } } as never, result as never);
    expect(result.statusCode).toBe(502);
    expect(code(result)).toBe('upstream_error');
  });
});
