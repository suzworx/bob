/**
 * Vitest suite for the additive device-pairing DTOs (008-supabase-auth-pairing
 * T015) per contracts/cardputer-pairing-protocol.md: pairing_required,
 * pair_request, pair_code, paired, pair_expired, pair_denied,
 * active_conversation, and the additive optional welcome fields. Makes pass
 * contract tests P-03 (user_code alphabet/length) and P-30 (both-null refine),
 * plus a parse/serialize round trip for every new DTO and worst-case byte
 * sizes under CONTROL_LIMIT_BYTES.
 */
import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import {
  CONTROL_LIMIT_BYTES,
  ActiveConversationDtoSchema,
  PairedDtoSchema,
  PairCodeDtoSchema,
  PairDeniedDtoSchema,
  PairExpiredDtoSchema,
  PairRequestDtoSchema,
  PairingRequiredDtoSchema,
  ServerControlDtoSchema,
  messageId,
  parseClientControl,
} from '../../src/voice/protocol.ts';

const ID = 't015_pairing_schema';
const UUID = '6f9f2b2e-7c1a-4d3e-9a5b-0c1d2e3f4a5b';
const OPAQUE_ID = 'conv_9f2b2e7c1a4d3e9a5b0c1d2e3f4a5b6c7d';
const CLAIM = '4f1c2b3a9e8d7c6b5a4f3e2d1c0b9a8f';
const SESSION_ID = 'session_pairing_test_01';
// Built at runtime on purpose: a literal `olxd_` + 43 base64url chars in a
// source file would trip the repo secret scan (scripts/validate.mjs).
const DEVICE_TOKEN = `olxd_${'A'.repeat(43)}`;

function roundTrip<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.parse(value);
  return JSON.parse(JSON.stringify(parsed)) as T;
}

function repeated(character: string, length: number): string {
  return character.repeat(length);
}

describe('pairing DTO round trips', () => {
  it('pairing_required round-trips with every reason', () => {
    for (const reason of ['none', 'unknown', 'revoked'] as const) {
      const dto = { v: 1, type: 'pairing_required', id: ID, payload: { reason } };
      expect(roundTrip(PairingRequiredDtoSchema, dto)).toEqual(dto);
    }
  });

  it('pair_request round-trips with and without resume', () => {
    const base = { v: 1, type: 'pair_request', id: ID, payload: { model: 'M5Stack Cardputer', fw_version: '0.3.0', claim: CLAIM } };
    expect(roundTrip(PairRequestDtoSchema, base)).toEqual(base);
    const resumed = { ...base, payload: { ...base.payload, resume: UUID } };
    expect(roundTrip(PairRequestDtoSchema, resumed)).toEqual(resumed);
  });

  it('parseClientControl accepts a valid pair_request', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, type: 'pair_request', id: ID, payload: { model: 'M5Stack Cardputer', fw_version: '0.3.0', claim: CLAIM } }));
    expect(parseClientControl(raw)).toMatchObject({ ok: true, value: { type: 'pair_request', id: ID } });
  });

  it('pair_code round-trips', () => {
    const dto = {
      v: 1, type: 'pair_code', id: ID,
      payload: { pairing_id: UUID, user_code: 'KQXC-TZPB', verification_uri: 'https://app.heybob.xyz/pair', expires_in: 600 },
    };
    expect(roundTrip(PairCodeDtoSchema, dto)).toEqual(dto);
  });

  it('paired round-trips with a valid device token', () => {
    const dto = { v: 1, type: 'paired', id: ID, payload: { device_id: UUID, device_token: DEVICE_TOKEN, name: 'Cardputer' } };
    expect(roundTrip(PairedDtoSchema, dto)).toEqual(dto);
  });

  it('pair_expired and pair_denied round-trip', () => {
    const expired = { v: 1, type: 'pair_expired', id: ID, payload: { pairing_id: UUID } };
    expect(roundTrip(PairExpiredDtoSchema, expired)).toEqual(expired);
    const denied = { v: 1, type: 'pair_denied', id: ID, payload: { pairing_id: UUID } };
    expect(roundTrip(PairDeniedDtoSchema, denied)).toEqual(denied);
  });

  it('active_conversation round-trips in both forms', () => {
    const set = { v: 1, type: 'active_conversation', id: ID, payload: { id: OPAQUE_ID, title: 'Cardputer reply truncation' } };
    expect(roundTrip(ActiveConversationDtoSchema, set)).toEqual(set);
    const cleared = { v: 1, type: 'active_conversation', id: ID, payload: { id: null, title: null } };
    expect(roundTrip(ActiveConversationDtoSchema, cleared)).toEqual(cleared);
  });

  it('welcome round-trips with both additive fields', () => {
    const dto = {
      v: 1, type: 'welcome', id: ID,
      payload: {
        protocol: 'bob.v2', format_id: 1, max_audio_bytes: 4096, credit_bytes: 16384, session_id: SESSION_ID,
        device: { id: UUID, name: 'Cardputer' },
        active_conversation: { id: OPAQUE_ID, title: 'Cardputer reply truncation' },
      },
    };
    expect(roundTrip(ServerControlDtoSchema, dto)).toEqual(dto);
  });

  it('a legacy welcome without the new fields still parses', () => {
    const dto = {
      v: 1, type: 'welcome', id: ID,
      payload: { protocol: 'bob.v2', format_id: 1, max_audio_bytes: 4096, credit_bytes: 16384, session_id: SESSION_ID },
    };
    expect(roundTrip(ServerControlDtoSchema, dto)).toEqual(dto);
  });
});

describe('pair_request validation', () => {
  it('rejects a claim that is not 32 lowercase hex chars', () => {
    const base = { v: 1, type: 'pair_request', id: ID, payload: { model: 'M5Stack Cardputer', fw_version: '0.3.0', claim: CLAIM } };
    const badClaims = ['4f1c2b3a9e8d7c6b5a4f3e2d1c0b9a8', '4F1C2B3A9E8D7C6B5A4F3E2D1C0B9A8F', 'zzzz2b3a9e8d7c6b5a4f3e2d1c0b9a8f', 'not-a-claim'];
    for (const claim of badClaims) {
      const parsed = PairRequestDtoSchema.safeParse({ ...base, payload: { ...base.payload, claim } });
      expect(parsed.success).toBe(false);
      expect(parseClientControl(Buffer.from(JSON.stringify({ ...base, payload: { ...base.payload, claim } }))))
        .toEqual({ ok: false, code: 'BAD_MESSAGE' });
    }
  });

  it('rejects a resume that is not a uuid', () => {
    const parsed = PairRequestDtoSchema.safeParse({
      v: 1, type: 'pair_request', id: ID,
      payload: { model: 'M5Stack Cardputer', fw_version: '0.3.0', claim: CLAIM, resume: 'not-a-uuid' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('P-03 user_code alphabet and length', () => {
  it('accepts a code from the alphabet', () => {
    const parsed = PairCodeDtoSchema.safeParse({
      v: 1, type: 'pair_code', id: ID,
      payload: { pairing_id: UUID, user_code: 'KQXC-TZPB', verification_uri: 'https://app.heybob.xyz/pair', expires_in: 600 },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects any char outside BCDFGHJKLMNPQRSTVWXZ', () => {
    const invalid = ['A7QX-4TZP', 'E7QX-4TZP', 'I7QX-4TZP', 'O7QX-4TZP', 'U7QX-4TZP', '07QX-4TZP', 'k7QX-4TZP'];
    for (const userCode of invalid) {
      const parsed = PairCodeDtoSchema.safeParse({
        v: 1, type: 'pair_code', id: ID,
        payload: { pairing_id: UUID, user_code: userCode, verification_uri: 'u', expires_in: 600 },
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('rejects a wrong length or a missing hyphen', () => {
    const invalid = ['K7QX-4TZ', 'KQXC-TZPBP', 'K7Q-4TZP', 'K7QX4TZP', 'KQXC-TZPB-1'];
    for (const userCode of invalid) {
      const parsed = PairCodeDtoSchema.safeParse({
        v: 1, type: 'pair_code', id: ID,
        payload: { pairing_id: UUID, user_code: userCode, verification_uri: 'u', expires_in: 600 },
      });
      expect(parsed.success).toBe(false);
    }
  });
});

describe('P-30 active_conversation both-null refine', () => {
  it('accepts the null form', () => {
    const parsed = ActiveConversationDtoSchema.safeParse({ v: 1, type: 'active_conversation', id: ID, payload: { id: null, title: null } });
    expect(parsed.success).toBe(true);
  });

  it('rejects a one-null-only payload', () => {
    const idOnly = ActiveConversationDtoSchema.safeParse({ v: 1, type: 'active_conversation', id: ID, payload: { id: null, title: 'x' } });
    const titleOnly = ActiveConversationDtoSchema.safeParse({ v: 1, type: 'active_conversation', id: ID, payload: { id: OPAQUE_ID, title: null } });
    expect(idOnly.success).toBe(false);
    expect(titleOnly.success).toBe(false);
  });

  it('enforces the same refine on the welcome active_conversation field', () => {
    const base = { v: 1, type: 'welcome', id: ID, payload: { protocol: 'bob.v2', format_id: 1, max_audio_bytes: 4096, credit_bytes: 16384, session_id: SESSION_ID } };
    const wholeNull = ServerControlDtoSchema.safeParse({ ...base, payload: { ...base.payload, active_conversation: null } });
    expect(wholeNull.success).toBe(true);
    const oneNull = ServerControlDtoSchema.safeParse({ ...base, payload: { ...base.payload, active_conversation: { id: null, title: 'x' } } });
    expect(oneNull.success).toBe(false);
  });
});

describe('worst-case byte sizes', () => {
  it('keeps every new message under CONTROL_LIMIT_BYTES at the field bounds', () => {
    const messages = [
      PairingRequiredDtoSchema.parse({ v: 1, type: 'pairing_required', id: messageId('pairreq'), payload: { reason: 'revoked' } }),
      PairRequestDtoSchema.parse({
        v: 1, type: 'pair_request', id: messageId('preq'),
        payload: { model: repeated('m', 64), fw_version: repeated('f', 32), claim: CLAIM, resume: UUID },
      }),
      PairCodeDtoSchema.parse({
        v: 1, type: 'pair_code', id: messageId('pcode'),
        payload: { pairing_id: UUID, user_code: 'KQXC-TZPB', verification_uri: repeated('u', 200), expires_in: 600 },
      }),
      PairedDtoSchema.parse({
        v: 1, type: 'paired', id: messageId('paired'),
        payload: { device_id: UUID, device_token: DEVICE_TOKEN, name: repeated('n', 40) },
      }),
      PairExpiredDtoSchema.parse({ v: 1, type: 'pair_expired', id: messageId('pexp'), payload: { pairing_id: UUID } }),
      PairDeniedDtoSchema.parse({ v: 1, type: 'pair_denied', id: messageId('pdnd'), payload: { pairing_id: UUID } }),
      ActiveConversationDtoSchema.parse({
        v: 1, type: 'active_conversation', id: messageId('actv'),
        payload: { id: OPAQUE_ID, title: repeated('t', 64) },
      }),
    ];
    for (const message of messages) {
      expect(Buffer.byteLength(JSON.stringify(message), 'utf8')).toBeLessThan(CONTROL_LIMIT_BYTES);
    }
  });

  it('keeps a welcome with both additive fields under the 512-byte firmware buffer', () => {
    const welcome = ServerControlDtoSchema.parse({
      v: 1, type: 'welcome', id: messageId('welcome'),
      payload: {
        protocol: 'bob.v2', format_id: 1, max_audio_bytes: 4096, credit_bytes: 16384, session_id: SESSION_ID,
        device: { id: UUID, name: repeated('n', 40) },
        active_conversation: { id: OPAQUE_ID, title: repeated('t', 64) },
      },
    });
    const size = Buffer.byteLength(JSON.stringify(welcome), 'utf8');
    expect(size).toBeLessThan(CONTROL_LIMIT_BYTES);
    expect(size).toBeLessThan(512);
  });
});

describe('new error codes', () => {
  it('accepts UNPAIRED and PAIRING_RATE_LIMITED', () => {
    for (const code of ['UNPAIRED', 'PAIRING_RATE_LIMITED']) {
      const parsed = ServerControlDtoSchema.safeParse({ v: 1, type: 'error', id: ID, payload: { code } });
      expect(parsed.success).toBe(true);
    }
  });
});