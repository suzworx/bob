// The tool -> scene table: chosen by tool name and result, never by phrase.
import { describe, expect, it } from 'vitest';
import { SCENE_NAMES, SCENE_BY_TOOL, sceneForToolResult } from '../../src/voice/scene-table.ts';

const ok = { ok: true, message: 'done' };

describe('sceneForToolResult', () => {
  it('maps set_timer to timer_set with the duration in seconds as value', () => {
    expect(sceneForToolResult('set_timer', { duration: 'PT10M', label: 'pasta' }, ok)).toEqual({
      scene: 'timer_set', seconds: 8, label: 'pasta', value: 600,
    });
    expect(sceneForToolResult('set_timer', { duration: 90 }, ok)).toMatchObject({ scene: 'timer_set', value: 90 });
  });

  it('clips the label to 24 chars and omits it when absent', () => {
    const long = 'x'.repeat(40);
    expect(sceneForToolResult('set_timer', { duration: 60, label: long }, ok)?.label).toHaveLength(24);
    expect(sceneForToolResult('set_timer', { duration: 60 }, ok)).not.toHaveProperty('label');
  });

  it('never splits an emoji when clipping the label', () => {
    const label = `${'x'.repeat(23)}\u{1F600}tail`;
    expect(sceneForToolResult('set_timer', { duration: 60, label }, ok)?.label).toBe('x'.repeat(23));
  });

  it('maps the other tools by name', () => {
    const names = (tool: string): string | undefined => sceneForToolResult(tool, {}, ok)?.scene;
    expect(names('set_alarm')).toBe('alarm');
    expect(names('create_task')).toBe('task_added');
    expect(names('create_note')).toBe('note_added');
    expect(names('append_note')).toBe('note_added');
    expect(names('create_reminder')).toBe('reminder');
    expect(names('create_event')).toBe('calendar');
    expect(names('search')).toBe('search');
  });

  it('maps express(music) to music and other feelings to no scene', () => {
    expect(sceneForToolResult('express', { emotion: 'music' }, ok)?.scene).toBe('music');
    expect(sceneForToolResult('express', { emotion: 'love' }, ok)).toBeNull();
  });

  it('picks the weather scene from the result', () => {
    const weather = (condition: string): string | undefined =>
      sceneForToolResult('get_weather', {}, { ok: true, condition })?.scene;
    expect(weather('sunny')).toBe('weather_sun');
    expect(weather('light rain')).toBe('weather_rain');
    expect(weather('snow showers')).toBe('weather_snow');
    expect(weather('overcast')).toBe('weather_cloud');
  });

  it('returns null for a failed result, an unknown tool and read-only tools', () => {
    expect(sceneForToolResult('set_timer', { duration: 60 }, { ok: false, reason: 'no' })).toBeNull();
    expect(sceneForToolResult('list_timers', {}, ok)).toBeNull();
    expect(sceneForToolResult('nope', {}, ok)).toBeNull();
  });

  it('keeps every table entry a known scene name', () => {
    for (const scene of Object.values(SCENE_BY_TOOL)) expect(SCENE_NAMES).toContain(scene);
  });
});
