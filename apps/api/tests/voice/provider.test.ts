/**
 * Provider classification and chat-configuration tests against the REAL
 * @bob/ai module (no vi.mock): Gateway error markers classify as upstream,
 * transport and budget failures still do, this codebase's own TypeError does
 * not, and the chat model resolves through the configured settings with the
 * system-test stub resolving no model at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayAuthenticationError, GatewayModelNotFoundError, GatewayRateLimitError } from '@ai-sdk/gateway';
import { capSpeechInput, isProviderError, providerErrorStatus } from '@bob/ai';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    transcribe: vi.fn(async () => ({
      text: 'transcript',
      segments: [],
      language: 'en',
      durationInSeconds: 1,
      warnings: [],
      responses: [],
      providerMetadata: {},
    })),
    generateSpeech: vi.fn(async () => ({
      audio: {
        base64: Buffer.from('audio').toString('base64'),
        uint8Array: new Uint8Array([1, 2, 3]),
        mediaType: 'audio/mpeg',
        format: 'mp3',
      },
      warnings: [],
    })),
  };
});

const ENV_KEYS = ['BOB_SYSTEM_TEST', 'BOB_DEBUG', 'BOB_DEBUG_PAYLOAD', 'BOB_CHAT_MODEL', 'AI_GATEWAY_API_KEY', 'BOB_STT_MODEL', 'BOB_STT_TIMEOUT_MS', 'BOB_STT_OPTIONS_NAMESPACE', 'BOB_TTS_MODEL', 'BOB_TTS_VOICE', 'BOB_MAX_TTS_CHARS', 'BOB_SYSTEM_TEST_TTS_SECONDS'] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('provider error classification', () => {
  it('classifies Gateway authentication errors as upstream', () => {
    expect(isProviderError(new GatewayAuthenticationError({ statusCode: 401 }))).toBe(true);
  });

  it('classifies Gateway rate-limit errors as upstream', () => {
    expect(isProviderError(new GatewayRateLimitError({ statusCode: 429 }))).toBe(true);
  });

  it('classifies Gateway model-not-found errors as upstream', () => {
    expect(isProviderError(new GatewayModelNotFoundError({ modelId: 'openai/nope', statusCode: 404 }))).toBe(true);
  });

  it('does not classify this codebase TypeError as upstream', () => {
    expect(isProviderError(new TypeError('Cannot read properties of undefined'))).toBe(false);
  });

  it('still classifies transport and budget failures as upstream', () => {
    expect(isProviderError(new Error('fetch failed'))).toBe(true);
    const abort = new DOMException('The operation was aborted', 'AbortError');
    expect(isProviderError(abort)).toBe(true);
  });

  it('reads the upstream status from the typed Gateway field', () => {
    expect(providerErrorStatus(new GatewayAuthenticationError({ statusCode: 401 }))).toBe(401);
    expect(providerErrorStatus(new GatewayRateLimitError({ statusCode: 429 }))).toBe(429);
    expect(providerErrorStatus(new Error('boom'))).toBeUndefined();
  });
});

describe('chat model resolution and stub mode', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = snapshotEnv();
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.BOB_SYSTEM_TEST;
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    vi.resetModules();
  });

  it('returns the stub reply and resolves no model under BOB_SYSTEM_TEST=1', async () => {
    process.env.BOB_SYSTEM_TEST = '1';
    vi.resetModules();
    const ai = await import('@bob/ai');
    const { runAgent } = await import('../../src/voice/turn/agent.ts');
    expect(ai.BOB_SYSTEM_TEST_MODE).toBe(true);
    const generate = vi.spyOn(ai.bobAgent, 'generate');
    const result = await runAgent([{ role: 'user', content: 'what time is it?' }]);
    expect(result.text).toBe('System test response: what time is it?');
    expect(result.toolCalls).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });

  it('records the configured chat model in ai.agent_configured', async () => {
    process.env.BOB_DEBUG = '1';
    process.env.BOB_CHAT_MODEL = 'openai/gpt-4o';
    vi.resetModules();
    const ai = await import('@bob/ai');
    const lines: string[] = [];
    ai.setDebugSink((line) => lines.push(line));
    try {
      ai.logAgentConfig();
      const entry = lines.map((line) => JSON.parse(line)).find((e) => e.event === 'ai.agent_configured');
      expect(entry?.model).toBe('openai/gpt-4o');
    } finally {
      ai.setDebugSink(null);
    }
  });

  it('starts without a credential instead of crashing, and the failure is classified upstream', async () => {
    vi.resetModules();
    const ai = await import('@bob/ai');
    expect(ai.chatModel).toBeDefined();
    const error = new GatewayAuthenticationError({ statusCode: 401 });
    expect(isProviderError(error)).toBe(true);
  });
});

describe('transcription through the Gateway', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    savedEnv = snapshotEnv();
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.BOB_STT_MODEL;
    delete process.env.BOB_STT_OPTIONS_NAMESPACE;
    delete process.env.BOB_SYSTEM_TEST;
    vi.mocked((await import('ai')).transcribe).mockClear();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    vi.resetModules();
  });

  it('carries a pinned language to the transcription call inside providerOptions', async () => {
    vi.resetModules();
    const ai = await import('@bob/ai');
    const { transcribe } = await import('ai');
    const result = await ai.transcribeAudio({ audio: 'aGVsbG8=', format: 'wav', language: 'en' });
    expect(result.text).toBeDefined();
    const args = vi.mocked(transcribe).mock.calls[0]![0] as {
      model?: unknown;
      providerOptions?: Record<string, Record<string, unknown>>;
      maxRetries?: number;
      abortSignal?: unknown;
    };
    expect(args.model).toBe('fish-audio/transcribe-1');
    expect(args.providerOptions?.['fish-audio']).toEqual({ language: 'en' });
    expect(args.maxRetries).toBe(0);
    expect(args.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("sends no language key at any level when the language is 'auto'", async () => {
    vi.resetModules();
    const ai = await import('@bob/ai');
    const { transcribe } = await import('ai');
    await ai.transcribeAudio({ audio: 'aGVsbG8=', format: 'wav' });
    const args = vi.mocked(transcribe).mock.calls[0]![0] as {
      providerOptions?: Record<string, Record<string, unknown>>;
    };
    expect(args.providerOptions?.['fish-audio']).not.toHaveProperty('language');
  });

  it('honours the configured options namespace override', async () => {
    process.env.BOB_STT_OPTIONS_NAMESPACE = 'gateway';
    vi.resetModules();
    const ai = await import('@bob/ai');
    const { transcribe } = await import('ai');
    await ai.transcribeAudio({ audio: 'aGVsbG8=', format: 'wav', language: 'ja' });
    const args = vi.mocked(transcribe).mock.calls[0]![0] as {
      providerOptions?: Record<string, Record<string, unknown>>;
    };
    expect(args.providerOptions?.['gateway']).toEqual({ language: 'ja' });
  });

  it('pins retries to zero and carries the configured timeout on the abort signal', async () => {
    process.env.BOB_STT_TIMEOUT_MS = '100';
    vi.resetModules();
    const ai = await import('@bob/ai');
    const { transcribe } = await import('ai');
    await ai.transcribeAudio({ audio: 'aGVsbG8=', format: 'wav' });
    const args = vi.mocked(transcribe).mock.calls[0]![0] as {
      maxRetries?: number;
      abortSignal?: AbortSignal;
    };
    expect(args.maxRetries).toBe(0);
    expect(args.abortSignal).toBeInstanceOf(AbortSignal);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(args.abortSignal?.aborted).toBe(true);
  });

});

describe('synthesis through the Gateway', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    savedEnv = snapshotEnv();
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.BOB_TTS_MODEL;
    delete process.env.BOB_TTS_VOICE;
    delete process.env.BOB_SYSTEM_TEST;
    delete process.env.BOB_SYSTEM_TEST_TTS_SECONDS;
    vi.mocked((await import('ai')).generateSpeech).mockClear();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    vi.resetModules();
  });

  it('truncates capped input at a sentence boundary', () => {
    const text = 'First sentence is short. Second sentence here. Third sentence extends well past the limit of the cap that guards the synthesis call.';
    const capped = capSpeechInput(text, 60);
    expect(capped.length).toBeLessThanOrEqual(60);
    expect(capped.endsWith('.')).toBe(true);
    expect(text.startsWith(capped)).toBe(true);
  });

  it('fires ai.tts_input_capped with original_chars, capped_chars and limit', async () => {
    process.env.BOB_DEBUG = '1';
    process.env.BOB_MAX_TTS_CHARS = '40';
    vi.resetModules();
    const ai = await import('@bob/ai');
    const lines: string[] = [];
    ai.setDebugSink((line) => lines.push(line));
    try {
      await ai.synthesizeSpeech({ text: 'A short sentence. Then a much longer second sentence that must be capped by the guard.' });
      const entry = lines.map((line) => JSON.parse(line)).find((e) => e.event === 'ai.tts_input_capped');
      expect(entry?.original_chars).toBe(86);
      expect(entry?.capped_chars).toBeLessThanOrEqual(40);
      expect(entry?.limit).toBe(40);
    } finally {
      ai.setDebugSink(null);
    }
  });

  it('pins retries to zero and sends the configured model, voice and format', async () => {
    vi.resetModules();
    const ai = await import('@bob/ai');
    const { generateSpeech } = await import('ai');
    await ai.synthesizeSpeech({ text: 'hello' });
    const args = vi.mocked(generateSpeech).mock.calls[0]![0] as {
      model?: unknown;
      voice?: unknown;
      outputFormat?: unknown;
      maxRetries?: number;
      abortSignal?: unknown;
    };
    expect((args.model as { modelId: string }).modelId).toBe(ai.BOB_TTS_MODEL);
    expect(args.voice).toBe(ai.BOB_TTS_VOICE);
    expect(args.outputFormat).toBe('mp3');
    expect(args.maxRetries).toBe(0);
    expect(args.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('never sends empty text to the provider', async () => {
    vi.resetModules();
    const ai = await import('@bob/ai');
    const { generateSpeech } = await import('ai');
    await expect(ai.synthesizeSpeech({ text: '   ' })).rejects.toThrow(/empty/i);
    expect(generateSpeech).not.toHaveBeenCalled();
  });

  it('returns the detected media type rather than the requested format', async () => {
    vi.resetModules();
    const ai = await import('@bob/ai');
    const result = await ai.synthesizeSpeech({ text: 'hello', format: 'wav' });
    expect(result.format).toBe('mp3');
    expect(result.contentType).toBe('audio/mpeg');
  });

});