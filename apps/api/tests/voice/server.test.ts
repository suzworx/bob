/**
 * Vitest suite for the v2 wire contract: typed DTO parsing, OLX2 frame
 * codecs, and sequence/credit validation. Runs through the root
 * vitest.config.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIO_HEADER_BYTES,
  INITIAL_CREDIT_BYTES,
  PCM16_16K_MONO_FORMAT,
  V2_VERSION,
  encodeAudioDown,
  parseAudioUp,
  parseClientControl,
  serializeAudioFrame,
  type SessionDto,
} from '../../src/voice/protocol.ts';

const session: SessionDto = {
  id: 'session_v2_test_001',
  stage: 'capturing',
  turnRef: 'turn_v2_test_001',
  nextUplinkSeq: 0,
  creditBytes: INITIAL_CREDIT_BYTES,
  audioChunks: [],
  totalAudioBytes: 0,
  messages: [],
  formatId: PCM16_16K_MONO_FORMAT,
};

/** Builds a valid OLX2 uplink frame with the given sequence and payload size. */
function audioUp(sequence = 0, payloadBytes = 320): Buffer {
  const payload = Buffer.alloc(payloadBytes);
  const frame = Buffer.alloc(AUDIO_HEADER_BYTES + payload.length);
  frame.write('OLX2', 0, 'ascii');
  frame.writeUInt8(V2_VERSION, 4);
  frame.writeUInt8(1, 5);
  frame.writeUInt8(1, 6);
  frame.writeUInt8(1, 7);
  frame.writeUInt32BE(1, 8);
  frame.writeUInt32BE(sequence, 12);
  frame.writeUInt32BE(payload.length, 16);
  payload.copy(frame, AUDIO_HEADER_BYTES);
  return frame;
}

describe('v2 typed DTO contract', () => {
  it('accepts the exact typed hello DTO, strips undeclared payload fields and rejects a bad format_id', () => {
    expect(parseClientControl(Buffer.from(JSON.stringify({
      v: 1, type: 'hello', id: 'hello_v2_test_001', payload: { format_id: 1 },
    })))).toMatchObject({ ok: true, value: { type: 'hello' } });

    // HELLO-COMPAT: a newer firmware field is stripped, never fatal to the hello.
    expect(parseClientControl(Buffer.from(JSON.stringify({
      v: 1, type: 'hello', id: 'hello_v2_test_001', payload: { format_id: 1, extra: 'from newer firmware' },
    })))).toEqual({ ok: true, value: { v: 1, type: 'hello', id: 'hello_v2_test_001', payload: { format_id: 1 } } });

    expect(parseClientControl(Buffer.from(JSON.stringify({
      v: 1, type: 'hello', id: 'hello_v2_test_001', payload: { format_id: 9, extra: 'from newer firmware' },
    })))).toEqual({ ok: false, code: 'BAD_MESSAGE' });
  });

  it('validates typed PCM metadata and reports sequence errors without exposing payload', () => {
    const parsed = parseAudioUp(audioUp(), session);
    expect(parsed).toMatchObject({ ok: true, value: { header: { kind: 'audio_up', sequence: 0, payloadBytes: 320 } } });
    expect(parseAudioUp(audioUp(1), session)).toEqual({ ok: false, code: 'SEQUENCE_GAP' });

    const malformed = audioUp();
    malformed.writeUInt32BE(321, 16);
    expect(parseAudioUp(malformed, session)).toEqual({ ok: false, code: 'BAD_AUDIO' });
  });

  it('serializes a fully typed downlink header', () => {
    const frame = serializeAudioFrame(encodeAudioDown(7, 3));
    expect(frame.subarray(0, 4).toString('ascii')).toBe('OLX2');
    expect(frame.readUInt8(4)).toBe(1);
    expect(frame.readUInt8(5)).toBe(2);
    expect(frame.readUInt32BE(8)).toBe(7);
    expect(frame.readUInt32BE(12)).toBe(3);
    expect(frame.readUInt32BE(16)).toBe(320);
  });
});
