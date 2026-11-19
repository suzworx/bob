import { beforeEach, describe, expect, it, vi } from 'vitest';

const debugLogMock = vi.fn();
vi.mock('../src/debug.ts', () => ({ debugLog: debugLogMock }));
vi.mock('../src/telemetry.ts', () => ({
  traceSpan: vi.fn(async (_name: string, _attrs: unknown, fn: () => unknown) => fn()),
  traceSpeechUsage: vi.fn(),
}));
vi.mock('../src/observation-metrics.ts', () => ({ recordObservationMetrics: vi.fn() }));

const generateSpeechMock = vi.fn();
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateSpeech: generateSpeechMock };
});

const { synthesizeSpeech } = await import('../src/tools.ts');
const { BOB_TTS_MODEL } = await import('../src/config.ts');
const { GatewayInvalidRequestError, GatewayResponseError } = await import('@ai-sdk/gateway');

function timeoutError(): Error {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
}

// Reproduces what the real SDK (ai 7.0.127 + @ai-sdk/gateway 4.0.103) actually
// throws: GatewaySpeechModel.doGenerate wraps every failure through
// asGatewayError, so a client-side abort or a raw fetch failure never reaches
// us as a bare TimeoutError -- it is a GatewayResponseError, statusCode 500,
// with the real error buried in `.cause`.
function gatewayWrapped(cause: unknown, statusCode = 500): InstanceType<typeof GatewayResponseError> {
  return new GatewayResponseError({ statusCode, cause });
}

const audioResult = {
  audio: { base64: 'QUJD', uint8Array: new Uint8Array([1, 2, 3]), mediaType: 'audio/mpeg', format: 'mp3' },
  warnings: [],
  responses: [],
  providerMetadata: {},
};

const input = { text: 'hello there' };

describe('TTS retry (#898)', () => {
  beforeEach(() => {
    generateSpeechMock.mockReset();
    debugLogMock.mockClear();
  });

  it('retries once after a timeout and returns the retry result', async () => {
    generateSpeechMock.mockRejectedValueOnce(timeoutError()).mockResolvedValueOnce(audioResult);
    const output = await synthesizeSpeech(input);
    expect(output.audio).toBe('QUJD');
    expect(generateSpeechMock).toHaveBeenCalledTimes(2);
    expect(debugLogMock).toHaveBeenCalledWith(
      'ai.tts_retry',
      expect.objectContaining({ model: BOB_TTS_MODEL, attempt: 2, reason: 'timeout' }),
    );
  });

  it('fails fast on a 4xx without retrying', async () => {
    generateSpeechMock.mockRejectedValueOnce(
      new GatewayInvalidRequestError({ statusCode: 400, message: 'bad voice' }),
    );
    await expect(synthesizeSpeech(input)).rejects.toThrow('bad voice');
    expect(generateSpeechMock).toHaveBeenCalledTimes(1);
    expect(debugLogMock).not.toHaveBeenCalledWith('ai.tts_retry', expect.anything());
  });

  it('rejects when both attempts time out', async () => {
    generateSpeechMock.mockRejectedValue(timeoutError());
    await expect(synthesizeSpeech(input)).rejects.toThrow();
    expect(generateSpeechMock).toHaveBeenCalledTimes(2);
  });

  it('calls generateSpeech once on success', async () => {
    generateSpeechMock.mockResolvedValueOnce(audioResult);
    const output = await synthesizeSpeech(input);
    expect(output.format).toBe('mp3');
    expect(generateSpeechMock).toHaveBeenCalledTimes(1);
    expect(debugLogMock).not.toHaveBeenCalledWith('ai.tts_retry', expect.anything());
  });

  it('retries a real Gateway-wrapped abort (GatewayResponseError 500, cause TimeoutError)', async () => {
    generateSpeechMock.mockRejectedValueOnce(gatewayWrapped(timeoutError())).mockResolvedValueOnce(audioResult);
    const output = await synthesizeSpeech(input);
    expect(output.audio).toBe('QUJD');
    expect(generateSpeechMock).toHaveBeenCalledTimes(2);
    expect(debugLogMock).toHaveBeenCalledWith(
      'ai.tts_retry',
      expect.objectContaining({ model: BOB_TTS_MODEL, attempt: 2, reason: 'timeout' }),
    );
  });

  it('retries a real Gateway-wrapped network failure (GatewayResponseError 500, cause "fetch failed")', async () => {
    const fetchFailed = new TypeError('fetch failed', { cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) });
    generateSpeechMock.mockRejectedValueOnce(gatewayWrapped(fetchFailed)).mockResolvedValueOnce(audioResult);
    const output = await synthesizeSpeech(input);
    expect(output.audio).toBe('QUJD');
    expect(generateSpeechMock).toHaveBeenCalledTimes(2);
    expect(debugLogMock).toHaveBeenCalledWith(
      'ai.tts_retry',
      expect.objectContaining({ model: BOB_TTS_MODEL, attempt: 2, reason: 'network' }),
    );
  });

  it('retries a genuine upstream 5xx (GatewayResponseError 502)', async () => {
    generateSpeechMock.mockRejectedValueOnce(gatewayWrapped(new Error('bad gateway'), 502)).mockResolvedValueOnce(audioResult);
    const output = await synthesizeSpeech(input);
    expect(output.audio).toBe('QUJD');
    expect(generateSpeechMock).toHaveBeenCalledTimes(2);
    expect(debugLogMock).toHaveBeenCalledWith(
      'ai.tts_retry',
      expect.objectContaining({ model: BOB_TTS_MODEL, attempt: 2, reason: '5xx' }),
    );
  });

  it('fails fast on a real GatewayInvalidRequestError 400 without retrying', async () => {
    generateSpeechMock.mockRejectedValueOnce(new GatewayInvalidRequestError({ statusCode: 400, message: 'bad voice' }));
    await expect(synthesizeSpeech(input)).rejects.toThrow('bad voice');
    expect(generateSpeechMock).toHaveBeenCalledTimes(1);
    expect(debugLogMock).not.toHaveBeenCalledWith('ai.tts_retry', expect.anything());
  });
});
