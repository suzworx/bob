import { describe, expect, it } from 'vitest';
import { prefixedId, uuidOf, type UrlIdKind } from './ids';

/**
 * Parity with apps/api/src/platform/ids.ts. The web app may not import apps/api
 * (scripts/check-boundaries.mjs), so this table is the shared fixture: every
 * expected value is what the api's canonicalId(kind, input) and uuidOf(kind, input)
 * return for the same input (generated with tsx against apps/api/src/platform/ids.ts
 * on 2026-10-06). Change the api mapping and this table together.
 */
const API_PARITY: ReadonlyArray<[UrlIdKind, string, string | null, string | null]> = [
  ['space', '6f86817c-ea95-481d-8456-8e608d5db780', 'spc_6f86817cea95481d84568e608d5db780', '6f86817c-ea95-481d-8456-8e608d5db780'],
  ['space', '6F86817CEA95481D84568E608D5DB780', 'spc_6f86817cea95481d84568e608d5db780', '6f86817c-ea95-481d-8456-8e608d5db780'],
  ['space', 'spc_6f86817cea95481d84568e608d5db780', 'spc_6f86817cea95481d84568e608d5db780', '6f86817c-ea95-481d-8456-8e608d5db780'],
  ['space', 'conv_5baa4dd3311c4abb8adc10eecd0ea06c', null, null],
  ['conversation', '5baa4dd3-311c-4abb-adc1-0eecd0ea06ca', 'conv_5baa4dd3311c4abbadc10eecd0ea06ca', '5baa4dd3-311c-4abb-adc1-0eecd0ea06ca'],
  ['conversation', 'cnv_5baa4dd3-311c-4abb-adc1-0eecd0ea06ca', 'conv_5baa4dd3311c4abbadc10eecd0ea06ca', '5baa4dd3-311c-4abb-adc1-0eecd0ea06ca'],
  ['conversation', 'thr_5baa4dd3-311c-4abb-adc1-0eecd0ea06ca', 'conv_5baa4dd3311c4abbadc10eecd0ea06ca', '5baa4dd3-311c-4abb-adc1-0eecd0ea06ca'],
  ['conversation', 'conv_5baa4dd3311c4abbadc10eecd0ea06ca', 'conv_5baa4dd3311c4abbadc10eecd0ea06ca', '5baa4dd3-311c-4abb-adc1-0eecd0ea06ca'],
  ['conversation', 'spc_6f86817cea95481d84568e608d5db780', null, null],
  ['device', '0b1e7c2a-9f3d-4e5a-8b6c-7d8e9f0a1b2c', 'dev_0b1e7c2a9f3d4e5a8b6c7d8e9f0a1b2c', '0b1e7c2a-9f3d-4e5a-8b6c-7d8e9f0a1b2c'],
  ['device', 'dev_0b1e7c2a9f3d4e5a8b6c7d8e9f0a1b2c', 'dev_0b1e7c2a9f3d4e5a8b6c7d8e9f0a1b2c', '0b1e7c2a-9f3d-4e5a-8b6c-7d8e9f0a1b2c'],
];

describe('ids: parity with apps/api/src/platform/ids.ts', () => {
  it.each(API_PARITY)('%s %s -> %s', (kind, input, canonical, uuid) => {
    expect(prefixedId(kind, input)).toBe(canonical);
    expect(uuidOf(kind, input)).toBe(uuid);
  });

  // The one deliberate difference: the api hashes an id with no uuid behind it
  // (md5, one-way); a URL must lead back to the stored id, so the web has none.
  it('has no prefixed form for an id with no uuid behind it', () => {
    expect(prefixedId('conversation', 'abcdefgh1234')).toBeNull();
    expect(uuidOf('conversation', 'abcdefgh1234')).toBeNull();
  });
});
