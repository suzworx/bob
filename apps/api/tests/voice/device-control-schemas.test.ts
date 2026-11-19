// Epic #311 wire contract: every new DTO, its bounds, and the key order the
// order-sensitive firmware parser relies on.
import { describe, expect, it } from 'vitest';
import {
  ServerControlDtoSchema,
  announceDto,
  deviceControlDto,
  parseClientControl,
  replyTextDto,
} from '../../src/voice/protocol.ts';

const raw = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
const state = { volume: 5, muted: false, mode: 'ptt', dnd: false, battery_pct: 80, charging: null, fw_version: '2.4.0' };
const envelope = (type: string, payload: unknown) => ({ v: 1, type, id: 'msg_12345678', payload });

describe('device_state (device -> server)', () => {
  it('accepts the documented payload', () => {
    expect(parseClientControl(raw(envelope('device_state', state))).ok).toBe(true);
  });

  it.each([
    ['volume above 10', { ...state, volume: 11 }],
    ['negative volume', { ...state, volume: -1 }],
    ['fractional volume', { ...state, volume: 2.5 }],
    ['unknown mode', { ...state, mode: 'always' }],
    ['battery above 100', { ...state, battery_pct: 101 }],
    ['empty fw_version', { ...state, fw_version: '' }],
    ['fw_version over 16', { ...state, fw_version: 'x'.repeat(17) }],
    ['missing dnd', { volume: 5, muted: false, mode: 'ptt', battery_pct: null, charging: null, fw_version: '1' }],
    ['an extra key', { ...state, brightness: 3 }],
  ])('rejects %s', (_label, payload) => {
    expect(parseClientControl(raw(envelope('device_state', payload)))).toEqual({ ok: false, code: 'BAD_MESSAGE' });
  });

  it('accepts null battery and charging', () => {
    expect(parseClientControl(raw(envelope('device_state', { ...state, battery_pct: null, charging: true }))).ok).toBe(true);
  });

  it('accepts the optional health fields (newer firmware)', () => {
    expect(
      parseClientControl(raw(envelope('device_state', { ...state, rssi_dbm: -62, heap_free: 48120, heap_largest: 32768, log_dropped: 3 }))).ok,
    ).toBe(true);
  });

  it.each([
    ['rssi above 0', { ...state, rssi_dbm: 5 }],
    ['rssi below -100', { ...state, rssi_dbm: -101 }],
    ['negative heap_free', { ...state, heap_free: -1 }],
    ['negative log_dropped', { ...state, log_dropped: -2 }],
  ])('rejects %s', (_label, payload) => {
    expect(parseClientControl(raw(envelope('device_state', payload)))).toEqual({ ok: false, code: 'BAD_MESSAGE' });
  });
});

// #389: ring firmware always reports both ring keys; older firmware sends neither.
describe('device_state ring settings (#389)', () => {
  const ringState = {
    volume: 5, muted: false, mode: 'ptt', dnd: false, ring_seconds: 30, ring_sound: 'classic',
    battery_pct: 80, charging: null, fw_version: '2.5.0',
  };

  it.each([10, 30, 120])('accepts ring_seconds %i with every ring_sound', (seconds) => {
    for (const sound of ['classic', 'chime', 'pulse']) {
      expect(parseClientControl(raw(envelope('device_state', { ...ringState, ring_seconds: seconds, ring_sound: sound }))).ok).toBe(true);
    }
  });

  it('still accepts a report without either ring key (older firmware)', () => {
    expect(parseClientControl(raw(envelope('device_state', state))).ok).toBe(true);
  });

  it.each([
    ['ring_seconds below 10', { ...ringState, ring_seconds: 9 }],
    ['ring_seconds above 120', { ...ringState, ring_seconds: 121 }],
    ['fractional ring_seconds', { ...ringState, ring_seconds: 30.5 }],
    ['an unknown ring_sound', { ...ringState, ring_sound: 'siren' }],
    ['ring_seconds without ring_sound', { ...state, ring_seconds: 30 }],
    ['ring_sound without ring_seconds', { ...state, ring_sound: 'chime' }],
  ])('rejects %s', (_label, payload) => {
    expect(parseClientControl(raw(envelope('device_state', payload)))).toEqual({ ok: false, code: 'BAD_MESSAGE' });
  });
});

describe('device_state wake word (cap wake_word)', () => {
  it.each(['bob'])('accepts wake_word %s and keeps it', (word) => {
    const parsed = parseClientControl(raw(envelope('device_state', { ...state, wake_word: word })));
    expect(parsed.ok && parsed.value.type === 'device_state' && parsed.value.payload.wake_word).toBe(word);
  });

  it('reads a wake word other than bob as absent instead of refusing the report', () => {
    const parsed = parseClientControl(raw(envelope('device_state', { ...state, wake_word: 'alexa' })));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.type === 'device_state' && parsed.value.payload.wake_word).toBeUndefined();
  });
});

describe('announce_ack (device -> server)', () => {
  it.each(['played', 'dismissed', 'snoozed', 'missed'])('accepts action %s', (action) => {
    expect(parseClientControl(raw(envelope('announce_ack', { announce_id: 'an_12345678', action }))).ok).toBe(true);
  });

  it('rejects an unknown action, a short id and an id over 60 chars', () => {
    for (const payload of [
      { announce_id: 'an_12345678', action: 'ignored' },
      { announce_id: 'short', action: 'played' },
      { announce_id: 'a'.repeat(61), action: 'played' },
    ]) {
      expect(parseClientControl(raw(envelope('announce_ack', payload))).ok).toBe(false);
    }
  });
});

describe('device_control (server -> device)', () => {
  it('orders the payload volume, muted, mode, dnd whatever the input order', () => {
    const dto = deviceControlDto({ dnd: true, mode: 'wake', muted: false, volume: 7 });
    expect(JSON.stringify(dto)).toMatch(/^\{"v":1,"type":"device_control","id":"dctl_[a-f0-9]{20}","payload":\{"volume":7,"muted":false,"mode":"wake","dnd":true\}\}$/);
    expect(ServerControlDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('omits absent fields and refuses an empty patch', () => {
    expect(deviceControlDto({ volume: 3 }).payload).toEqual({ volume: 3 });
    expect(ServerControlDtoSchema.safeParse(deviceControlDto({})).success).toBe(false);
  });

  it('refuses volume outside 0..10 and an unknown mode', () => {
    expect(ServerControlDtoSchema.safeParse(deviceControlDto({ volume: 11 })).success).toBe(false);
    expect(ServerControlDtoSchema.safeParse({ ...deviceControlDto({ volume: 1 }), payload: { mode: 'loud' } }).success).toBe(false);
  });

  it('appends ring_seconds, ring_sound after dnd whatever the input order (#389)', () => {
    const dto = deviceControlDto({ ring_sound: 'pulse', ring_seconds: 45, dnd: false, volume: 2 });
    expect(JSON.stringify(dto.payload)).toBe('{"volume":2,"dnd":false,"ring_seconds":45,"ring_sound":"pulse"}');
    expect(ServerControlDtoSchema.safeParse(dto).success).toBe(true);
    expect(deviceControlDto({ ring_seconds: 60 }).payload).toEqual({ ring_seconds: 60 });
  });

  it('appends wake_word last, after the ring keys, whatever the input order', () => {
    const dto = deviceControlDto({ wake_word: 'bob', ring_sound: 'pulse', ring_seconds: 45, volume: 2 });
    expect(JSON.stringify(dto.payload)).toBe('{"volume":2,"ring_seconds":45,"ring_sound":"pulse","wake_word":"bob"}');
    expect(ServerControlDtoSchema.safeParse(dto).success).toBe(true);
    expect(deviceControlDto({ wake_word: 'bob' }).payload).toEqual({ wake_word: 'bob' });
  });

  it('refuses a wake_word outside bob/bob', () => {
    expect(ServerControlDtoSchema.safeParse({ ...deviceControlDto({ volume: 1 }), payload: { wake_word: 'alexa' } }).success).toBe(false);
  });

  it('refuses ring_seconds outside 10..120 and an unknown ring_sound (#389)', () => {
    expect(ServerControlDtoSchema.safeParse(deviceControlDto({ ring_seconds: 9 })).success).toBe(false);
    expect(ServerControlDtoSchema.safeParse(deviceControlDto({ ring_seconds: 121 })).success).toBe(false);
    expect(ServerControlDtoSchema.safeParse({ ...deviceControlDto({ volume: 1 }), payload: { ring_sound: 'siren' } }).success).toBe(false);
  });
});

describe('reply_text (server -> device)', () => {
  it('carries turn_ref on the envelope and heard, reply in order', () => {
    const dto = replyTextDto('turn_abc123', 'what time is it', 'It is noon.');
    expect(JSON.stringify(dto)).toMatch(/^\{"v":1,"type":"reply_text","id":"rtxt_[a-f0-9]{20}","turn_ref":"turn_abc123","payload":\{"heard":"what time is it","reply":"It is noon."\}\}$/);
    expect(ServerControlDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('clips heard to 200 and reply to 700 chars, and the schema refuses longer', () => {
    const dto = replyTextDto('turn_abc123', 'h'.repeat(250), 'r'.repeat(900));
    expect(dto.payload.heard).toHaveLength(200);
    expect(dto.payload.reply).toHaveLength(700);
    expect(ServerControlDtoSchema.safeParse({ ...dto, payload: { heard: '', reply: 'r'.repeat(701) } }).success).toBe(false);
    expect(ServerControlDtoSchema.safeParse({ ...dto, payload: { heard: '', reply: '' } }).success).toBe(true);
  });
});

describe('announce (server -> device)', () => {
  const payload = { announce_id: 'tm_0123456789', kind: 'timer' as const, title: 'Pasta', body: '', ring: true, expires_at: 1_790_000_000_000 };

  it('orders announce_id, kind, title, body, ring, expires_at', () => {
    const dto = announceDto({ expires_at: payload.expires_at, ring: true, body: '', title: 'Pasta', kind: 'timer', announce_id: payload.announce_id });
    expect(JSON.stringify(dto)).toMatch(/^\{"v":1,"type":"announce","id":"annc_[a-f0-9]{20}","payload":\{"announce_id":"tm_0123456789","kind":"timer","title":"Pasta","body":"","ring":true,"expires_at":1790000000000\}\}$/);
    expect(ServerControlDtoSchema.safeParse(dto).success).toBe(true);
  });

  it.each([
    ['empty title', { title: '' }],
    ['title over 28', { title: 't'.repeat(29) }],
    ['body over 200', { body: 'b'.repeat(201) }],
    ['unknown kind', { kind: 'weather' }],
    ['non-integer expiry', { expires_at: 1.5 }],
  ])('refuses %s', (_label, change) => {
    expect(ServerControlDtoSchema.safeParse({ ...announceDto(payload), payload: { ...payload, ...change } }).success).toBe(false);
  });

  it('accepts every kind', () => {
    for (const kind of ['timer', 'alarm', 'reminder', 'notice'] as const) {
      expect(ServerControlDtoSchema.safeParse(announceDto({ ...payload, kind })).success).toBe(true);
    }
  });
});
