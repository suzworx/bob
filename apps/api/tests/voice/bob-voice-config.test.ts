/** A refused BOB_TTS_VOICE_BOB is loud at boot: an error-level journal line naming only the voice in force. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ refused: false }));
vi.mock('@bob/ai', async (orig) => {
  const actual = await orig<typeof import('@bob/ai')>();
  return {
    ...actual,
    get BOB_TTS_VOICE_BOB_REFUSED(): boolean { return state.refused; },
    ttsVoiceFor: (name?: 'Bob') => (name === 'Bob' ? 'en-US-Sage' : actual.BOB_TTS_VOICE),
  };
});

import { setJournalSink } from '../../src/platform/logger.ts';
import { journalSpeechConfig } from '../../src/startup.ts';

function bootLines(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  setJournalSink((line) => lines.push(JSON.parse(line)));
  journalSpeechConfig();
  return lines;
}

afterEach(() => setJournalSink(null));

describe('boot journal for the Bob voice', () => {
  it('journals v2.tts_voice_bob_error at error level when the override was refused', () => {
    state.refused = true;
    const lines = bootLines();
    expect(lines.find((l) => l.event === 'v2.tts_voice_bob_error')).toMatchObject({ level: 'error', fallback_voice: 'en-US-Sage' });
    expect(lines.find((l) => l.event === 'v2.speech_config')).toMatchObject({ tts_voice_bob: 'en-US-Sage' });
  });

  it('stays quiet for a valid or unset override', () => {
    state.refused = false;
    expect(bootLines().map((l) => l.event)).toEqual(['v2.speech_config']);
  });
});
