// #898: createFirstTextDetector in isolation -- the chunk-boundary logic that
// backs web chat's first_token_ms, unit-tested directly rather than only
// through a full turn (chat-turn-metrics.test.ts covers that integration).
import { describe, expect, it } from 'vitest';
import { createFirstTextDetector } from '../../src/conversations/chat-http.ts';

const MARKER = '"type":"text-delta"';

describe('createFirstTextDetector (#898)', () => {
  it('sees the marker when it arrives whole in one chunk', () => {
    const detect = createFirstTextDetector();
    expect(detect('{"type":"start"}')).toBe(false);
    expect(detect(`{${MARKER},"id":"t","delta":"hi"}`)).toBe(true);
    // Stays true once seen, even for a later chunk with no marker.
    expect(detect('{"type":"text-end","id":"t"}')).toBe(true);
  });

  it('catches the marker split across two chunks, at every split offset', () => {
    for (let at = 1; at < MARKER.length; at += 1) {
      const detect = createFirstTextDetector();
      expect(detect(MARKER.slice(0, at))).toBe(false);
      expect(detect(MARKER.slice(at))).toBe(true);
    }
  });

  it('never reports true when no chunk ever carries the marker', () => {
    const detect = createFirstTextDetector();
    const chunks = ['{"type":"start"}', '{"type":"tool-input-start"}', '{"type":"tool-output-available"}', '{"type":"finish"}'];
    for (const chunk of chunks) expect(detect(chunk)).toBe(false);
  });

  it('a split surviving a large preceding chunk is still caught, bounded by the kept tail', () => {
    for (let at = 1; at < MARKER.length; at += 1) {
      const detect = createFirstTextDetector();
      expect(detect(`${'x'.repeat(10_000)}${MARKER.slice(0, at)}`)).toBe(false);
      expect(detect(MARKER.slice(at))).toBe(true);
    }
  });
});
