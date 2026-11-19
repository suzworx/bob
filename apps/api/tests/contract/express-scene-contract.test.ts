// Wire contract for the server -> device `express` and `scene` messages
// (firmware brief BOB-SCENES-FW): exact emotions, bounds, key order.
import { describe, expect, it } from 'vitest';
import { EXPRESS_EMOTIONS } from '@bob/ai';
import { expressDto, sceneDto, ServerControlDtoSchema, SCENE_NAMES } from '../../src/voice/protocol.ts';

const EMOTIONS = [
  'idle', 'listening', 'thinking', 'speaking', 'sleeping', 'waking_up', 'hello', 'updating', 'offline', 'error',
  'success', 'failed', 'happy', 'joyful', 'laughing', 'love', 'grateful', 'proud', 'playful', 'excited',
  'celebrating', 'relieved', 'calm', 'cool', 'curious', 'surprised', 'amazed', 'confused', 'skeptical', 'focused',
  'idea', 'sad', 'crying', 'worried', 'scared', 'grumpy', 'annoyed', 'embarrassed', 'shy', 'bored', 'sleepy',
  'dizzy', 'sick', 'apologetic', 'alarm', 'music', 'reminder',
];

describe('express', () => {
  it('lists exactly the 47 emotions', () => {
    expect([...EXPRESS_EMOTIONS]).toEqual(EMOTIONS);
  });

  it('builds the DTO in contract order and the schema accepts it', () => {
    const dto = expressDto('love', 6);
    expect(Object.keys(dto)).toEqual(['v', 'type', 'id', 'payload']);
    expect(dto.payload).toEqual({ emotion: 'love', seconds: 6 });
    expect(ServerControlDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('rejects an unknown emotion and out-of-range seconds', () => {
    const parse = (payload: object): boolean => ServerControlDtoSchema.safeParse({ ...expressDto('love', 6), payload }).success;
    expect(parse({ emotion: 'grr', seconds: 6 })).toBe(false);
    expect(parse({ emotion: 'love', seconds: 0 })).toBe(false);
    expect(parse({ emotion: 'love', seconds: 16 })).toBe(false);
    expect(parse({ emotion: 'love', seconds: 15 })).toBe(true);
  });
});

describe('scene', () => {
  it('lists the sixteen scenes', () => {
    expect([...SCENE_NAMES]).toEqual([
      'timer_set', 'timer_done', 'alarm', 'weather_sun', 'weather_cloud', 'weather_rain', 'weather_snow', 'music',
      'task_added', 'note_added', 'reminder', 'calendar', 'search', 'message_sent', 'success', 'failed',
    ]);
  });

  it('keeps payload keys in contract order and omits absent label/value', () => {
    expect(Object.keys(sceneDto({ scene: 'timer_set', seconds: 8, label: 'pasta', value: 600 }).payload)).toEqual(['scene', 'seconds', 'label', 'value']);
    expect(sceneDto({ scene: 'success', seconds: 4 }).payload).toEqual({ scene: 'success', seconds: 4 });
  });

  it('enforces seconds 1..20, label <= 24 and an integer value', () => {
    const parse = (payload: object): boolean => ServerControlDtoSchema.safeParse({ ...sceneDto({ scene: 'success', seconds: 4 }), payload }).success;
    expect(parse({ scene: 'success', seconds: 20 })).toBe(true);
    expect(parse({ scene: 'success', seconds: 21 })).toBe(false);
    expect(parse({ scene: 'success', seconds: 0 })).toBe(false);
    expect(parse({ scene: 'success', seconds: 4, label: 'x'.repeat(25) })).toBe(false);
    expect(parse({ scene: 'success', seconds: 4, value: 1.5 })).toBe(false);
    expect(parse({ scene: 'bogus', seconds: 4 })).toBe(false);
  });
});
