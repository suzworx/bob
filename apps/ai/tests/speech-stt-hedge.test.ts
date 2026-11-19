/**
 * #1331: speech-to-text sends the same audio to a backup model when the
 * primary has not answered after BOB_STT_HEDGE_MS (or failed sooner), takes
 * the first success and aborts the loser. One shared BOB_STT_TIMEOUT_MS
 * deadline (default 8 s) covers both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const debugLogMock = vi.fn();
vi.mock('../src/debug.ts', () => ({ debugLog: debugLogMock }));
const traceSpeechUsageMock = vi.fn();
vi.mock('../src/telemetry.ts', () => ({
  traceSpan: vi.fn(async (_name: string, _attrs: unknown, fn: () => unknown) => fn()),
  traceSpeechUsage: traceSpeechUsageMock,
}));
vi.mock('../src/observation-metrics.ts', () => ({ recordObservationMetrics: vi.fn() }));

const transcribeMock = vi.fn();
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, transcribe: transcribeMock };
});

const PRIMARY = 'fish-audio/transcribe-1';
const BACKUP = 'openai/gpt-4o-mini-transcribe';

type Call = { model: string; providerOptions: Record<string, unknown>; abortSignal: AbortSignal };

/** A provider call that answers (or fails) after `ms`, and rejects like the SDK when aborted. */
function reply(ms: number, text: string | Error): (call: Call) => Promise<unknown> {
  return ({ abortSignal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (text instanceof Error) reject(text);
      else resolve({ text, segments: [], language: 'en', durationInSeconds: 1, warnings: [], responses: [], providerMetadata: {} });
    }, ms);
    abortSignal.addEventListener('abort', () => { clearTimeout(timer); reject(abortSignal.reason); });
  });
}

/** Routes each transcribe call to the behaviour scripted for its model. */
function script(byModel: Record<string, (call: Call) => Promise<unknown>>): void {
  transcribeMock.mockImplementation((call: Call) => byModel[call.model]!(call));
}

function calls(): Call[] {
  return transcribeMock.mock.calls.map(([call]) => call as Call);
}

async function loadTools(env: Record<string, string | undefined> = {}): Promise<typeof import('../src/tools.ts')> {
  vi.stubEnv('BOB_STT_MODEL', undefined);
  vi.stubEnv('BOB_STT_BACKUP_MODEL', undefined);
  vi.stubEnv('BOB_STT_HEDGE_MS', undefined);
  vi.stubEnv('BOB_STT_TIMEOUT_MS', undefined);
  vi.stubEnv('BOB_STT_OPTIONS_NAMESPACE', undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();
  return import('../src/tools.ts');
}

const input = { audio: 'aGVsbG8=', format: 'wav' as const, language: 'en' };

function responseFields(): Record<string, unknown> {
  return debugLogMock.mock.calls.find(([event]) => event === 'ai.stt_response')![1] as Record<string, unknown>;
}

describe('STT hedged backup (#1331)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    transcribeMock.mockReset();
    debugLogMock.mockClear();
    traceSpeechUsageMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('defaults the timeout to 8 s, the hedge to 2.5 s and the backup to gpt-4o-mini-transcribe', async () => {
    await loadTools();
    const config = await import('../src/config.ts');
    expect([config.STT_TIMEOUT_MS, config.STT_HEDGE_MS, config.BOB_STT_BACKUP_MODEL]).toEqual([8000, 2500, BACKUP]);
  });

  it('keeps explicit env values, including a hedge of 0', async () => {
    await loadTools({ BOB_STT_TIMEOUT_MS: '12000', BOB_STT_HEDGE_MS: '0', BOB_STT_BACKUP_MODEL: 'x/y' });
    const config = await import('../src/config.ts');
    expect([config.STT_TIMEOUT_MS, config.STT_HEDGE_MS, config.BOB_STT_BACKUP_MODEL]).toEqual([12000, 0, 'x/y']);
  });

  it('a fast primary answers alone and the backup is never called', async () => {
    const { transcribeAudio } = await loadTools();
    script({ [PRIMARY]: reply(500, 'primary text'), [BACKUP]: reply(100, 'backup text') });
    const pending = transcribeAudio(input);
    await vi.advanceTimersByTimeAsync(5000);
    const output = await pending;
    expect(output).toMatchObject({ text: 'primary text', model: PRIMARY });
    expect(calls().map((call) => call.model)).toEqual([PRIMARY]);
    expect(responseFields()).toMatchObject({ stt_model_won: PRIMARY, stt_hedged: false });
  });

  it('a slow primary is hedged after 2.5 s; the backup wins and the primary is aborted', async () => {
    const { transcribeAudio } = await loadTools();
    script({ [PRIMARY]: reply(6000, 'primary text'), [BACKUP]: reply(800, 'backup text') });
    const pending = transcribeAudio(input);
    await vi.advanceTimersByTimeAsync(2499);
    expect(calls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls().map((call) => call.model)).toEqual([PRIMARY, BACKUP]);
    await vi.advanceTimersByTimeAsync(800);
    const output = await pending;
    expect(output).toMatchObject({ text: 'backup text', model: BACKUP });
    const [primaryCall, backupCall] = calls();
    expect(primaryCall!.abortSignal.aborted).toBe(true);
    expect(backupCall!.abortSignal.aborted).toBe(false);
    // The options namespace follows each call's own model.
    expect(primaryCall!.providerOptions).toEqual({ 'fish-audio': { language: 'en' } });
    expect(backupCall!.providerOptions).toEqual({ openai: { language: 'en' } });
    expect(responseFields()).toMatchObject({ stt_model_won: BACKUP, stt_hedged: true });
    // Usage is recorded once, for the winner.
    expect(traceSpeechUsageMock).toHaveBeenCalledTimes(1);
    expect(traceSpeechUsageMock).toHaveBeenCalledWith(expect.objectContaining({ model: BACKUP }));
    // The aborted loser is not logged as a failure.
    expect(debugLogMock).not.toHaveBeenCalledWith('ai.stt_failed', expect.anything());
  });

  it('a primary that fails before the hedge delay fires the backup at once', async () => {
    const { transcribeAudio } = await loadTools();
    script({ [PRIMARY]: reply(300, new Error('primary down')), [BACKUP]: reply(700, 'backup text') });
    const pending = transcribeAudio(input);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls().map((call) => call.model)).toEqual([PRIMARY, BACKUP]);
    await vi.advanceTimersByTimeAsync(700);
    await expect(pending).resolves.toMatchObject({ text: 'backup text', model: BACKUP });
    expect(debugLogMock).toHaveBeenCalledWith('ai.stt_failed', expect.objectContaining({ model: PRIMARY }));
  });

  it("throws the primary's error when both requests fail", async () => {
    const { transcribeAudio } = await loadTools();
    script({ [PRIMARY]: reply(3000, new Error('primary down')), [BACKUP]: reply(200, new Error('backup down')) });
    const pending = transcribeAudio(input);
    const settled = expect(pending).rejects.toThrow('primary down');
    await vi.advanceTimersByTimeAsync(3000);
    await settled;
    expect(calls()).toHaveLength(2);
  });

  it('both requests share one deadline', async () => {
    // AbortSignal.timeout runs on Node's own clock, which fake timers do not move.
    vi.useRealTimers();
    const { transcribeAudio } = await loadTools({ BOB_STT_TIMEOUT_MS: '200', BOB_STT_HEDGE_MS: '50' });
    script({ [PRIMARY]: reply(60_000, 'late'), [BACKUP]: reply(60_000, 'late') });
    await expect(transcribeAudio(input)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(calls().every((call) => call.abortSignal.aborted)).toBe(true);
  });

  it('BOB_STT_HEDGE_MS=0 turns the backup off', async () => {
    const { transcribeAudio } = await loadTools({ BOB_STT_HEDGE_MS: '0' });
    script({ [PRIMARY]: reply(4000, 'primary text'), [BACKUP]: reply(100, 'backup text') });
    const pending = transcribeAudio(input);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(pending).resolves.toMatchObject({ text: 'primary text', model: PRIMARY });
    expect(calls()).toHaveLength(1);
  });

  it('does not hedge when the backup is the primary model', async () => {
    const { transcribeAudio } = await loadTools({ BOB_STT_BACKUP_MODEL: PRIMARY });
    script({ [PRIMARY]: reply(4000, 'primary text') });
    const pending = transcribeAudio(input);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(pending).resolves.toMatchObject({ model: PRIMARY, text: 'primary text' });
    expect(calls()).toHaveLength(1);
  });
});
