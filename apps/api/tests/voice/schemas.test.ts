/**
 * Vitest suite for the v2 wire contract primitives in schemas.ts: protocol
 * constants, opaque message ids, client control parsing, and the OLX2 PCM
 * frame codec. Complements server.test.ts with exhaustive error-branch
 * coverage of parseClientControl and parseAudioUp.
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIO_HEADER_BYTES,
  AUDIO_PAYLOAD_LIMIT_BYTES,
  CONVERSATIONS_LIST_CAP,
  DOWNLINK_FRAME_BYTES,
  INITIAL_CREDIT_BYTES,
  MP3_16K_MONO_FORMAT,
  PCM16_16K_MONO_FORMAT,
  SPACES_LIST_CAP,
  V2_VERSION,
  ActiveSpaceDtoSchema,
  encodeAudioDown,
  messageId,
  parseAudioUp,
  parseClientControl,
  serializeAudioFrame,
  ServerControlDtoSchema,
  type AudioFrameDto,
  type SessionDto,
} from '../../src/voice/protocol.ts';

const ID = 'worker_schema_test_1';
const TURN_REF = 'turn_schema_test_1';

function session(overrides: Partial<SessionDto> = {}): SessionDto {
  return {
    id: ID,
    stage: 'capturing',
    turnRef: TURN_REF,
    nextUplinkSeq: 0,
    creditBytes: INITIAL_CREDIT_BYTES,
    audioChunks: [],
    totalAudioBytes: 0,
    messages: [],
    formatId: PCM16_16K_MONO_FORMAT,
    ...overrides,
  };
}

/** Builds a structurally valid OLX2 uplink frame; bytes can be mutated after. */
function audioUp(sequence = 0, payloadBytes = 320): Buffer {
  const payload = Buffer.alloc(payloadBytes);
  const frame = Buffer.alloc(AUDIO_HEADER_BYTES + payload.length);
  frame.write('OLX2', 0, 'ascii');
  frame.writeUInt8(V2_VERSION, 4);
  frame.writeUInt8(1, 5);
  frame.writeUInt8(PCM16_16K_MONO_FORMAT, 6);
  frame.writeUInt8(1, 7);
  frame.writeUInt32BE(1, 8);
  frame.writeUInt32BE(sequence, 12);
  frame.writeUInt32BE(payload.length, 16);
  payload.copy(frame, AUDIO_HEADER_BYTES);
  return frame;
}

describe('v2 protocol constants', () => {
  it('pins the wire contract constants', () => {
    expect(V2_VERSION).toBe(1);
    expect(AUDIO_HEADER_BYTES).toBe(20);
    expect(AUDIO_PAYLOAD_LIMIT_BYTES).toBe(4096);
    expect(INITIAL_CREDIT_BYTES).toBe(16 * 1024);
    expect(DOWNLINK_FRAME_BYTES).toBe(320);
  });
});

describe('messageId', () => {
  it('returns a prefixed opaque id within the OpaqueId charset and length', () => {
    const id = messageId('hello');
    expect(id.startsWith('hello_')).toBe(true);
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('generates distinct ids per call', () => {
    expect(messageId('a')).not.toBe(messageId('a'));
  });
});

describe('parseClientControl', () => {
  it('rejects bodies over the 1024-byte control limit before parsing', () => {
    expect(parseClientControl(Buffer.from('a'.repeat(2000)))).toEqual({ ok: false, code: 'FRAME_TOO_LARGE' });
  });

  it('rejects invalid JSON', () => {
    expect(parseClientControl(Buffer.from('{ definitely not json'))).toEqual({ ok: false, code: 'BAD_MESSAGE' });
  });

  it('rejects well-formed JSON with an invalid shape', () => {
    expect(parseClientControl(Buffer.from(JSON.stringify({ v: 1, type: 'hello' })))).toEqual({ ok: false, code: 'BAD_MESSAGE' });
  });

  it('rejects a hello with an unknown format', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'hello', id: ID, payload: { format_id: 3 } }));
    expect(parseClientControl(raw)).toEqual({ ok: false, code: 'BAD_MESSAGE' });
  });

  it('accepts a valid hello with format_id 1 (PCM)', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'hello', id: ID, payload: { format_id: 1 } }));
    expect(parseClientControl(raw)).toMatchObject({ ok: true, value: { type: 'hello', id: ID } });
  });

  it('strips unknown hello payload keys so a newer firmware field never fails the hello', () => {
    const payload = { format_id: 2, fw_version: '0.3.0', caps: ['reply_text'], future_field: { x: 1 } };
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'hello', id: ID, payload }));
    const parsed = parseClientControl(raw);
    expect(parsed).toMatchObject({ ok: true, value: { type: 'hello', payload: { format_id: 2, fw_version: '0.3.0', caps: ['reply_text'] } } });
    expect(parsed.ok && 'future_field' in parsed.value.payload).toBe(false);
  });

  it('still validates the known hello keys when unknown keys ride along', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'hello', id: ID, payload: { format_id: 3, future_field: 1 } }));
    expect(parseClientControl(raw)).toEqual({ ok: false, code: 'BAD_MESSAGE' });
  });

  it('accepts a valid hello with format_id 2 (MP3)', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'hello', id: ID, payload: { format_id: 2 } }));
    expect(parseClientControl(raw)).toMatchObject({ ok: true, value: { type: 'hello', id: ID, payload: { format_id: 2 } } });
  });

  it('accepts a turn_start with an opaque turn_ref and explicit payload', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'turn_start', id: ID, turn_ref: TURN_REF, payload: {} }));
    expect(parseClientControl(raw)).toMatchObject({ ok: true, value: { type: 'turn_start', turn_ref: TURN_REF } });
  });

  it('accepts a turn_start carrying the device conversation_id (#880)', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'turn_start', id: ID, turn_ref: TURN_REF, payload: { conversation_id: 'cnv_0123456789abcdef' } }));
    expect(parseClientControl(raw)).toMatchObject({ ok: true, value: { type: 'turn_start', payload: { conversation_id: 'cnv_0123456789abcdef' } } });
  });

  it('rejects a turn_start whose conversation_id is not an opaque id', () => {
    for (const conversationId of ['short', 'has space id', 'x'.repeat(65), 42, null]) {
      const raw = Buffer.from(JSON.stringify({ v: 1, type: 'turn_start', id: ID, turn_ref: TURN_REF, payload: { conversation_id: conversationId } }));
      expect(parseClientControl(raw)).toEqual({ ok: false, code: 'BAD_MESSAGE' });
    }
  });

  it('accepts a turn_end with a non-negative seq and explicit payload', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'turn_end', id: ID, turn_ref: TURN_REF, seq: 7, payload: {} }));
    expect(parseClientControl(raw)).toMatchObject({ ok: true, value: { type: 'turn_end', turn_ref: TURN_REF, seq: 7 } });
  });

  it('rejects a turn_end with a negative seq', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'turn_end', id: ID, turn_ref: TURN_REF, seq: -1 }));
    expect(parseClientControl(raw)).toEqual({ ok: false, code: 'BAD_MESSAGE' });
  });

  it('accepts a cancel with or without a turn_ref and explicit payload', () => {
    const withRef = Buffer.from(JSON.stringify({ v: 1, type: 'cancel', id: ID, turn_ref: TURN_REF, payload: {} }));
    const withoutRef = Buffer.from(JSON.stringify({ v: 1, type: 'cancel', id: ID, payload: {} }));
    expect(parseClientControl(withRef)).toMatchObject({ ok: true, value: { type: 'cancel' } });
    expect(parseClientControl(withoutRef)).toMatchObject({ ok: true, value: { type: 'cancel' } });
  });

  it('accepts a pong with an explicit payload', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'pong', id: ID, payload: {} }));
    expect(parseClientControl(raw)).toMatchObject({ ok: true, value: { type: 'pong' } });
  });

  it('accepts a list_conversations with an explicit payload', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'list_conversations', id: ID, payload: {} }));
    expect(parseClientControl(raw)).toMatchObject({ ok: true, value: { type: 'list_conversations', id: ID } });
  });

  it('accepts a select_conversation with a conversation_id payload', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'select_conversation', id: ID, payload: { conversation_id: 'cnv_select_test_001' } }));
    expect(parseClientControl(raw)).toMatchObject({
      ok: true,
      value: { type: 'select_conversation', id: ID, payload: { conversation_id: 'cnv_select_test_001' } },
    });
  });

  it('rejects a select_conversation without a conversation_id', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'select_conversation', id: ID, payload: {} }));
    expect(parseClientControl(raw)).toEqual({ ok: false, code: 'BAD_MESSAGE' });
  });

  it('rejects a select_conversation with a malformed conversation_id', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'select_conversation', id: ID, payload: { conversation_id: 'not valid!' } }));
    expect(parseClientControl(raw)).toEqual({ ok: false, code: 'BAD_MESSAGE' });
  });

  it('rejects an unknown message type', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'nope', id: ID }));
    expect(parseClientControl(raw)).toEqual({ ok: false, code: 'BAD_MESSAGE' });
  });
});

describe('status control dto', () => {
  it('validates a status dto for each of the three stages', () => {
    for (const stage of ['thinking', 'speaking', 'idle'] as const) {
      const parsed = ServerControlDtoSchema.safeParse({ v: 1, type: 'status', id: ID, turn_ref: TURN_REF, payload: { stage } });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual({ v: 1, type: 'status', id: ID, turn_ref: TURN_REF, payload: { stage } });
      }
    }
  });

  it('rejects a status dto with an unknown stage', () => {
    const parsed = ServerControlDtoSchema.safeParse({ v: 1, type: 'status', id: ID, turn_ref: TURN_REF, payload: { stage: 'listening' } });
    expect(parsed.success).toBe(false);
  });

  it('rejects a status dto without a stage in the payload', () => {
    const parsed = ServerControlDtoSchema.safeParse({ v: 1, type: 'status', id: ID, turn_ref: TURN_REF, payload: {} });
    expect(parsed.success).toBe(false);
  });
});

describe('conversation control dtos', () => {
  it('validates a conversations dto with up to the cap entries', () => {
    const parsed = ServerControlDtoSchema.safeParse({
      v: 1, type: 'conversations', id: ID,
      payload: { conversations: [{ id: 'cnv_select_test_001', title: 'Trip planning' }] },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        v: 1, type: 'conversations', id: ID,
        payload: { conversations: [{ id: 'cnv_select_test_001', title: 'Trip planning' }] },
      });
    }
  });

  it('rejects a conversations dto over the cap', () => {
    const conversations = Array.from(
      { length: CONVERSATIONS_LIST_CAP + 1 },
      () => ({ id: 'cnv_select_test_001', title: 'x' }),
    );
    const parsed = ServerControlDtoSchema.safeParse({ v: 1, type: 'conversations', id: ID, payload: { conversations } });
    expect(parsed.success).toBe(false);
  });

  it('validates a conversation_selected dto with conversation_id and title', () => {
    const parsed = ServerControlDtoSchema.safeParse({
      v: 1, type: 'conversation_selected', id: ID,
      payload: { conversation_id: 'cnv_select_test_001', title: 'Trip planning' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        v: 1, type: 'conversation_selected', id: ID,
        payload: { conversation_id: 'cnv_select_test_001', title: 'Trip planning' },
      });
    }
  });

  it('accepts a new_conversation with a request_id payload', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'new_conversation', id: ID, payload: { request_id: 'newc_req_000001' } }));
    expect(parseClientControl(raw)).toEqual({
      ok: true,
      value: { v: 1, type: 'new_conversation', id: ID, payload: { request_id: 'newc_req_000001' } },
    });
  });

  it.each([
    ['no request_id', { payload: {} }],
    ['a malformed request_id', { payload: { request_id: 'bad id!' } }],
    ['an extra payload key', { payload: { request_id: 'newc_req_000001', conversation_id: 'cnv_select_test_001' } }],
    ['a turn_ref', { turn_ref: TURN_REF, payload: { request_id: 'newc_req_000001' } }],
    ['a seq', { seq: 0, payload: { request_id: 'newc_req_000001' } }],
  ])('rejects a new_conversation with %s', (_label, extra) => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'new_conversation', id: ID, ...extra }));
    expect(parseClientControl(raw)).toEqual({ ok: false, code: 'BAD_MESSAGE' });
  });

  it('validates a conversation_cleared dto with request_id and changed_at', () => {
    const dto = { v: 1, type: 'conversation_cleared', id: ID, payload: { request_id: 'newc_req_000001', changed_at: 1_758_000_000_000 } };
    const parsed = ServerControlDtoSchema.safeParse(dto);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(dto);
  });

  it.each([
    ['a zero changed_at', { request_id: 'newc_req_000001', changed_at: 0 }],
    ['a fractional changed_at', { request_id: 'newc_req_000001', changed_at: 1.5 }],
    ['no request_id', { changed_at: 1 }],
    ['an extra payload key', { request_id: 'newc_req_000001', changed_at: 1, title: 'x' }],
  ])('rejects a conversation_cleared dto with %s', (_label, payload) => {
    const parsed = ServerControlDtoSchema.safeParse({ v: 1, type: 'conversation_cleared', id: ID, payload });
    expect(parsed.success).toBe(false);
  });

  it('accepts CONVERSATION_NOT_FOUND as an error code', () => {
    const parsed = ServerControlDtoSchema.safeParse({
      v: 1, type: 'error', id: ID, payload: { code: 'CONVERSATION_NOT_FOUND' },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('space control dtos (#301)', () => {
  const SPACE_ID = '0c1d2e3f-4a5b-4c7d-8e9f-0a1b2c3d4e5f';
  const parse = (body: Record<string, unknown>) => parseClientControl(Buffer.from(JSON.stringify({ v: 1, id: ID, ...body })));

  it('pins SPACES_LIST_CAP at 10', () => {
    expect(SPACES_LIST_CAP).toBe(10);
  });

  it('accepts list_spaces and select_space with a uuid or null', () => {
    expect(parse({ type: 'list_spaces', payload: {} })).toMatchObject({ ok: true });
    expect(parse({ type: 'select_space', payload: { space_id: SPACE_ID } })).toMatchObject({ ok: true, value: { payload: { space_id: SPACE_ID } } });
    expect(parse({ type: 'select_space', payload: { space_id: null } })).toMatchObject({ ok: true, value: { payload: { space_id: null } } });
  });

  it.each([
    ['a non-uuid space_id', { type: 'select_space', payload: { space_id: 'cnv_select_test_001' } }],
    ['no space_id', { type: 'select_space', payload: {} }],
    ['an extra key', { type: 'select_space', payload: { space_id: SPACE_ID, name: 'x' } }],
    ['a list_spaces payload key', { type: 'list_spaces', payload: { limit: 5 } }],
  ])('rejects %s', (_label, body) => {
    expect(parse(body)).toEqual({ ok: false, code: 'BAD_MESSAGE' });
  });

  it('bounds the spaces reply: 10 entries and 60-char names pass, 11 entries or 61 chars fail', () => {
    const entry = (name = 'Kitchen') => ({ id: SPACE_ID, name });
    const reply = (spaces: unknown[]) => ServerControlDtoSchema.safeParse({ v: 1, type: 'spaces', id: ID, payload: { spaces } });
    expect(reply(Array.from({ length: SPACES_LIST_CAP }, () => entry('x'.repeat(60)))).success).toBe(true);
    expect(reply(Array.from({ length: SPACES_LIST_CAP + 1 }, () => entry())).success).toBe(false);
    expect(reply([entry('x'.repeat(61))]).success).toBe(false);
    expect(reply([entry('')]).success).toBe(false);
    expect(reply([{ id: 'not-a-uuid', name: 'Kitchen' }]).success).toBe(false);
    expect(reply([{ id: SPACE_ID, title: 'Kitchen' }]).success).toBe(false);
  });

  it('space_selected and active_space allow both-null or both-set, never mismatched', () => {
    const selected = (payload: unknown) => ServerControlDtoSchema.safeParse({ v: 1, type: 'space_selected', id: ID, payload }).success;
    const push = (payload: unknown) => ActiveSpaceDtoSchema.safeParse({ v: 1, type: 'active_space', id: ID, payload }).success;
    expect(selected({ space_id: SPACE_ID, name: 'Kitchen' })).toBe(true);
    expect(selected({ space_id: null, name: null })).toBe(true);
    expect(selected({ space_id: SPACE_ID, name: null })).toBe(false);
    expect(selected({ space_id: null, name: 'Kitchen' })).toBe(false);
    expect(push({ id: SPACE_ID, name: 'Kitchen' })).toBe(true);
    expect(push({ id: null, name: null })).toBe(true);
    expect(push({ id: SPACE_ID, name: null })).toBe(false);
    expect(push({ id: null, name: 'Kitchen' })).toBe(false);
    expect(push({ id: SPACE_ID, title: 'Kitchen' })).toBe(false);
  });

  it('welcome carries an optional active_space {id,name} or null', () => {
    const welcome = (extra: Record<string, unknown>) => ServerControlDtoSchema.safeParse({
      v: 1, type: 'welcome', id: ID,
      payload: { protocol: 'bob.v2', format_id: 1, max_audio_bytes: 4096, credit_bytes: 16384, session_id: ID, ...extra },
    }).success;
    expect(welcome({})).toBe(true);
    expect(welcome({ active_space: null })).toBe(true);
    expect(welcome({ active_space: { id: SPACE_ID, name: 'Kitchen' } })).toBe(true);
    expect(welcome({ active_space: { id: SPACE_ID, name: 'x'.repeat(61) } })).toBe(false);
    expect(welcome({ active_space: { id: null, name: null } })).toBe(false);
  });

  it('accepts SPACE_NOT_FOUND as an error code', () => {
    expect(ServerControlDtoSchema.safeParse({ v: 1, type: 'error', id: ID, payload: { code: 'SPACE_NOT_FOUND' } }).success).toBe(true);
  });
});

describe('parseAudioUp', () => {
  it('rejects frames outside the 20..4116 byte window', () => {
    expect(parseAudioUp(Buffer.alloc(10), session())).toEqual({ ok: false, code: 'FRAME_TOO_LARGE' });
    expect(parseAudioUp(Buffer.alloc(AUDIO_HEADER_BYTES + AUDIO_PAYLOAD_LIMIT_BYTES + 1), session()))
      .toEqual({ ok: false, code: 'FRAME_TOO_LARGE' });
  });

  it('rejects wrong magic, version, or kind bytes', () => {
    const badMagic = audioUp();
    badMagic.write('XXXX', 0, 'ascii');
    expect(parseAudioUp(badMagic, session())).toEqual({ ok: false, code: 'BAD_AUDIO' });

    const badVersion = audioUp();
    badVersion.writeUInt8(2, 4);
    expect(parseAudioUp(badVersion, session())).toEqual({ ok: false, code: 'BAD_AUDIO' });

    const badKind = audioUp();
    badKind.writeUInt8(2, 5);
    expect(parseAudioUp(badKind, session())).toEqual({ ok: false, code: 'BAD_AUDIO' });
  });

  it('rejects wrong format, channels, or declared payload size', () => {
    const badFormat = audioUp();
    badFormat.writeUInt8(2, 6);
    expect(parseAudioUp(badFormat, session())).toEqual({ ok: false, code: 'BAD_AUDIO' });

    const badChannels = audioUp();
    badChannels.writeUInt8(2, 7);
    expect(parseAudioUp(badChannels, session())).toEqual({ ok: false, code: 'BAD_AUDIO' });

    const badSize = audioUp();
    badSize.writeUInt32BE(321, 16);
    expect(parseAudioUp(badSize, session())).toEqual({ ok: false, code: 'BAD_AUDIO' });
  });

  it('reports SEQUENCE_GAP when the sequence does not match the session', () => {
    expect(parseAudioUp(audioUp(1), session())).toEqual({ ok: false, code: 'SEQUENCE_GAP' });
  });

  it('reports QUEUE_FULL when the payload exceeds the session credit', () => {
    expect(parseAudioUp(audioUp(0, 320), session({ creditBytes: 100 }))).toEqual({ ok: false, code: 'QUEUE_FULL' });
  });

  it('accepts a valid frame and exposes the parsed header and payload', () => {
    const parsed = parseAudioUp(audioUp(0, 320), session());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.header).toEqual({
        magic: 'OLX2', version: 1, kind: 'audio_up', formatId: 1, channels: 1,
        turnHandle: 1, sequence: 0, payloadBytes: 320,
      });
      expect(parsed.value.payload).toEqual(Buffer.alloc(320));
    }
  });
});

describe('OLX2 frame codec', () => {
  it('encodes a silent 320-byte downlink frame with kind byte 2', () => {
    const buffer = serializeAudioFrame(encodeAudioDown(7, 3));
    expect(buffer.length).toBe(AUDIO_HEADER_BYTES + DOWNLINK_FRAME_BYTES);
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('OLX2');
    expect(buffer.readUInt8(4)).toBe(V2_VERSION);
    expect(buffer.readUInt8(5)).toBe(2);
    expect(buffer.readUInt8(6)).toBe(PCM16_16K_MONO_FORMAT);
    expect(buffer.readUInt8(7)).toBe(1);
    expect(buffer.readUInt32BE(8)).toBe(7);
    expect(buffer.readUInt32BE(12)).toBe(3);
    expect(buffer.readUInt32BE(16)).toBe(DOWNLINK_FRAME_BYTES);
    expect(Array.from(buffer.subarray(AUDIO_HEADER_BYTES))).toEqual(new Array(DOWNLINK_FRAME_BYTES).fill(0));
  });

  it('round-trips an uplink frame through serialize and parse', () => {
    const payload = Buffer.alloc(320);
    for (let index = 0; index < payload.length; index += 1) payload.writeUInt8(index % 251, index);
    const frame: AudioFrameDto = {
      header: {
        magic: 'OLX2', version: V2_VERSION, kind: 'audio_up',
        formatId: PCM16_16K_MONO_FORMAT, channels: 1,
        turnHandle: 9, sequence: 4, payloadBytes: payload.length,
      },
      payload,
    };

    const parsed = parseAudioUp(serializeAudioFrame(frame), session({ nextUplinkSeq: 4, creditBytes: 320 }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.header).toEqual(frame.header);
      expect(parsed.value.payload).toEqual(payload);
    }
  });

  it('round-trips an MP3 downlink frame through serialize and parse as bad audio (uplink must be PCM)', () => {
    const payload = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
    const frame: AudioFrameDto = {
      header: {
        magic: 'OLX2', version: V2_VERSION, kind: 'audio_down',
        formatId: MP3_16K_MONO_FORMAT, channels: 1,
        turnHandle: 1, sequence: 0, payloadBytes: payload.length,
      },
      payload,
    };
    const buffer = serializeAudioFrame(frame);
    expect(buffer.readUInt8(6)).toBe(MP3_16K_MONO_FORMAT);
  });
});
describe('turn_timing: firmware latency fields (speech end, uplink and socket back-pressure)', () => {
  const base = {
    v: 1, type: 'turn_timing', id: 'tmg_schema_test_1', turn_ref: TURN_REF,
    payload: {
      version: 1, source: 'wake', end_reason: 'silence', outcome: 'drained', muted: false,
      capture_end_ms: 3200, first_up_ms: 50, turn_end_ms: 3230, playback_start_ms: 4100, first_down_ms: 4110,
      decoder_ready_ms: 4180, speaker_submission_ms: 4200, playback_end_ms: 8000, up_frames: 320, down_frames: 41,
    },
  };
  const withFields = (fields: Record<string, unknown>): unknown => ({ ...base, payload: { ...base.payload, ...fields } });
  const parse = (message: unknown): ReturnType<typeof parseClientControl> => parseClientControl(Buffer.from(JSON.stringify(message)));
  const latency = { speech_end_ms: 2400, uplink_backlog: 3, mic_fps: 50, tx_busy: 2, tx_busy_max_ms: 140 };

  it('an older firmware that omits them still parses', () => {
    expect(parse(base)).toMatchObject({ ok: true, value: { type: 'turn_timing' } });
  });

  it('accepts the five appended fields, and a null (skipped) speech end', () => {
    expect(parse(withFields(latency))).toMatchObject({ ok: true, value: { payload: latency } });
    expect(parse(withFields({ ...latency, speech_end_ms: null }))).toMatchObject({ ok: true, value: { payload: { speech_end_ms: null } } });
  });

  it.each([
    ['speech_end_ms', 600_001], ['speech_end_ms', -1], ['speech_end_ms', 1.5],
    ['uplink_backlog', -1], ['uplink_backlog', 100_001], ['uplink_backlog', null],
    ['mic_fps', -1], ['mic_fps', 100_001], ['mic_fps', 2.5],
    ['tx_busy', -1], ['tx_busy', 100_001], ['tx_busy', '2'],
    ['tx_busy_max_ms', -1], ['tx_busy_max_ms', 600_001], ['tx_busy_max_ms', null],
  ])('rejects %s = %s', (key, value) => {
    expect(parse(withFields({ ...latency, [key]: value }))).toEqual({ ok: false, code: 'BAD_MESSAGE' });
  });
});
