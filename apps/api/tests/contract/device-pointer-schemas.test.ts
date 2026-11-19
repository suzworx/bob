// #900: the active-conversation and active-space PUT request schemas take an
// optional device_id (a device's own pointer instead of the account pointer),
// and a device row in GET /api/devices can carry its own pointer. Schema-only:
// no handler/store wiring here (other units).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ActiveConversationRequestSchema,
  ActiveSpaceRequestSchema,
  DevicesResponseSchema,
} from '../../src/devices/schemas.ts';

const DEVICE_ID = randomUUID();

describe('ActiveConversationRequestSchema (#900)', () => {
  it('parses an old body with no device_id', () => {
    expect(ActiveConversationRequestSchema.safeParse({ conversation_id: 'cnv_1', space_id: null }).success)
      .toBe(true);
  });

  it('parses a body with a device_id', () => {
    const result = ActiveConversationRequestSchema.safeParse({
      conversation_id: 'cnv_1', space_id: null, device_id: DEVICE_ID,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.device_id).toBe(DEVICE_ID);
  });

  it('rejects an invalid device_id', () => {
    expect(ActiveConversationRequestSchema.safeParse({
      conversation_id: 'cnv_1', space_id: null, device_id: 'not-a-uuid',
    }).success).toBe(false);
  });
});

describe('ActiveSpaceRequestSchema (#900)', () => {
  it('parses an old body with no device_id', () => {
    expect(ActiveSpaceRequestSchema.safeParse({ space_id: null }).success).toBe(true);
  });

  it('parses a body with a device_id', () => {
    const result = ActiveSpaceRequestSchema.safeParse({ space_id: randomUUID(), device_id: DEVICE_ID });
    expect(result.success).toBe(true);
    expect(result.success && result.data.device_id).toBe(DEVICE_ID);
  });

  it('rejects an invalid device_id', () => {
    expect(ActiveSpaceRequestSchema.safeParse({ space_id: null, device_id: 'not-a-uuid' }).success).toBe(false);
  });
});

/** A valid GET /api/devices body with one device row; `extra` merges onto that row. */
function devicesResponse(extra: Record<string, unknown> = {}): unknown {
  return {
    devices: [{
      id: randomUUID(),
      name: 'Desk',
      model: 'M5Stack Cardputer',
      paired_at: 1,
      last_seen_at: null,
      connected: false,
      settings: { volume: 5, muted: false, mode: 'wake', dnd: false, ring_seconds: 30, ring_sound: 'chime', wake_word: 'bob' },
      pending: false,
      settings_supported: false,
      ring_settings_supported: false,
      wake_word_supported: false,
      live: { connected: false, battery_pct: null, charging: null, fw_version: null },
      ...extra,
    }],
    active_conversation: null,
    active_space: null,
  };
}

describe('device row active_conversation_id/active_space_id (#900)', () => {
  it('parses a row with neither new field (old shape)', () => {
    expect(DevicesResponseSchema.safeParse(devicesResponse()).success).toBe(true);
  });

  it('parses a row with both new fields set', () => {
    const result = DevicesResponseSchema.safeParse(
      devicesResponse({ active_conversation_id: 'cnv_groceries', active_space_id: randomUUID() }),
    );
    expect(result.success).toBe(true);
  });

  it('parses a row with both new fields explicitly null', () => {
    expect(
      DevicesResponseSchema.safeParse(
        devicesResponse({ active_conversation_id: null, active_space_id: null }),
      ).success,
    ).toBe(true);
  });

  it('rejects a row whose active_space_id is not a uuid', () => {
    expect(
      DevicesResponseSchema.safeParse(devicesResponse({ active_space_id: 'not-a-uuid' })).success,
    ).toBe(false);
  });

  it("rejects a row whose active_conversation_id is not OpaqueId (too short)", () => {
    expect(
      DevicesResponseSchema.safeParse(devicesResponse({ active_conversation_id: 'cnv_1' })).success,
    ).toBe(false);
  });
});
