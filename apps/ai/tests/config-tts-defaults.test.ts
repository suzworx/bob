/**
 * #898: production's live TTS bake-off (135 calls) found
 * microsoft/mai-voice-2.1-flash had 0 errors and a ~0.75s first-sentence p50,
 * voice en-US-Harper is the only one it accepts, and 8000ms matches its
 * measured latency; openai/tts-1 hung 30s+ on 5.6% of calls. These tests pin
 * the code defaults to match what production already runs, and confirm an
 * explicit env value still wins.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

async function freshConfig(): Promise<typeof import('../src/config.ts')> {
  vi.resetModules();
  return import('../src/config.ts');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('TTS config defaults (#898)', () => {
  it('defaults to the bake-off winner when unset', async () => {
    vi.stubEnv('BOB_TTS_MODEL', undefined);
    vi.stubEnv('BOB_TTS_VOICE', undefined);
    vi.stubEnv('BOB_TTS_TIMEOUT_MS', undefined);
    const config = await freshConfig();
    expect(config.BOB_TTS_MODEL).toBe('microsoft/mai-voice-2.1-flash');
    expect(config.BOB_TTS_VOICE).toBe('en-US-Harper');
    expect(config.TTS_TIMEOUT_MS).toBe(8000);
  });

  it('keeps an explicit env value', async () => {
    vi.stubEnv('BOB_TTS_MODEL', 'openai/tts-1');
    vi.stubEnv('BOB_TTS_VOICE', 'alloy');
    vi.stubEnv('BOB_TTS_TIMEOUT_MS', '12000');
    const config = await freshConfig();
    expect(config.BOB_TTS_MODEL).toBe('openai/tts-1');
    expect(config.BOB_TTS_VOICE).toBe('alloy');
    expect(config.TTS_TIMEOUT_MS).toBe(12000);
  });

  it('gives a device that names Bob en-US-Sage (owner choice, 2026-10-14) and no name the default voice', async () => {
    vi.stubEnv('BOB_TTS_VOICE', undefined);
    vi.stubEnv('BOB_TTS_VOICE_BOB', undefined);
    const config = await freshConfig();
    expect([config.ttsVoiceFor('Bob'), config.ttsVoiceFor()]).toEqual(['en-US-Sage', 'en-US-Harper']);
    expect(config.BOB_TTS_VOICE_BOB_REFUSED).toBe(false);
    vi.stubEnv('BOB_TTS_VOICE_BOB', 'en-US-Ethan');
    const ethan = await freshConfig();
    expect([ethan.ttsVoiceFor('Bob'), ethan.BOB_TTS_VOICE_BOB_REFUSED]).toEqual(['en-US-Ethan', false]);
  });

  it('refuses a misspelled Bob voice and keeps en-US-Sage instead of sending it to the provider', async () => {
    vi.stubEnv('BOB_TTS_VOICE_BOB', 'en-US-Sag');
    const config = await freshConfig();
    expect([config.ttsVoiceFor('Bob'), config.BOB_TTS_VOICE_BOB_REFUSED]).toEqual(['en-US-Sage', true]);
  });
});
