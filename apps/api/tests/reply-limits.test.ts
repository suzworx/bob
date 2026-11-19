/**
 * Vitest suite for the two reply-shaping fixes:
 *   B -- an uncapped reply could exceed the TTS request timeout and fail the
 *        turn with no audio at all (a 1697-character reply did).
 *   C -- no language was pinned for STT, so the provider auto-detected and
 *        replies came back in a language the speaker never used.
 */
import { describe, expect, it } from 'vitest';
import { capSpeechInput, BOB_AGENT_INSTRUCTIONS } from '@bob/ai';

describe('capSpeechInput', () => {
  it('leaves a reply that already fits completely untouched', () => {
    const text = 'The Roman empire began in 27 BC.';
    expect(capSpeechInput(text, 700)).toBe(text);
  });

  it('caps an overlong reply instead of letting TTS time out', () => {
    const text = 'x'.repeat(5000);
    // A hard bound, ellipsis included -- not limit + 3.
    expect(capSpeechInput(text, 700).length).toBeLessThanOrEqual(700);
  });

  it('ends on a sentence boundary rather than mid-word', () => {
    const text = `${'a'.repeat(500)}. ${'b'.repeat(500)}. tail`;
    const capped = capSpeechInput(text, 700);
    expect(capped.endsWith('.')).toBe(true);
    expect(capped).not.toContain('...');
  });

  it('falls back to an ellipsis when no boundary is late enough', () => {
    // One long unbroken sentence: honouring an early boundary would collapse
    // the reply to almost nothing, so it is trimmed and marked instead.
    const text = `short. ${'c'.repeat(2000)}`;
    const capped = capSpeechInput(text, 700);
    expect(capped.endsWith('...')).toBe(true);
    expect(capped.length).toBeGreaterThan(600);
  });

  it('handles a limit longer than the text without padding it', () => {
    expect(capSpeechInput('hi', 700)).toBe('hi');
  });
});

describe('agent instructions', () => {
  it('pins the reply language so a misheard transcript cannot flip it', () => {
    expect(BOB_AGENT_INSTRUCTIONS).toMatch(/English/);
    expect(BOB_AGENT_INSTRUCTIONS).toMatch(/do not switch languages/i);
  });

  it('defaults to short replies while allowing requested or necessary detail', () => {
    expect(BOB_AGENT_INSTRUCTIONS).toMatch(/Keep routine replies under 40 words/i);
    expect(BOB_AGENT_INSTRUCTIONS).toMatch(/Expand only for requested detail or facts essential to avoid an incorrect or unsafe answer/i);
  });
});
