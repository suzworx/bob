// end_of_turn (#1365, epic #1361): the server's streaming-STT end-of-turn
// control message. Additive: only a device whose hello caps list
// 'end_of_turn' is sent it, so current firmware never sees it.
import { describe, expect, it } from 'vitest';
import {
  ClientControlDtoSchema,
  EndOfTurnDtoSchema,
  endOfTurnDto,
  ServerControlDtoSchema,
} from '../../src/voice/protocol.ts';

describe('end_of_turn (server -> device)', () => {
  it('the builder output parses with the schema, envelope on the turn_ref', () => {
    const dto = endOfTurnDto('turn_abc123');
    expect(EndOfTurnDtoSchema.safeParse(dto).success).toBe(true);
    expect(dto).toMatchObject({ v: 1, type: 'end_of_turn', turn_ref: 'turn_abc123', payload: {} });
    expect(dto.id).toMatch(/^eotn_[a-f0-9]{20}$/);
  });

  it('is accepted by the server-message union', () => {
    expect(ServerControlDtoSchema.safeParse(endOfTurnDto('turn_abc123')).success).toBe(true);
  });

  it('rejects extra payload keys (strict)', () => {
    const dto = { ...endOfTurnDto('turn_abc123'), payload: { reason: 'stt' } };
    expect(EndOfTurnDtoSchema.safeParse(dto).success).toBe(false);
  });

  it('keeps the end_of_turn cap in a hello', () => {
    const parsed = ClientControlDtoSchema.parse({
      v: 1, type: 'hello', id: 'hello_12345678', payload: { format_id: 2, caps: ['device_control', 'end_of_turn'] },
    });
    expect(parsed.type === 'hello' && parsed.payload.caps).toEqual(['device_control', 'end_of_turn']);
  });
});
