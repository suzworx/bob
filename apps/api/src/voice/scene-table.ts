/**
 * The one tool -> scene table: when a turn's tool call succeeds, the device
 * shows the scene for that tool (never chosen by phrase). The label and value
 * come from the call's input and result and are never journaled.
 */
import { parseTimerDuration } from '@bob/ai';
import { clipLabel } from './protocol-base.ts';
import { SCENE_LABEL_MAX, type SceneName, type ScenePayload } from './protocol.ts';

export { SCENE_NAMES } from './protocol.ts';

/** Tools whose scene depends on nothing but the tool itself. */
export const SCENE_BY_TOOL: Readonly<Record<string, SceneName>> = {
  set_timer: 'timer_set',
  set_alarm: 'alarm',
  create_task: 'task_added',
  create_note: 'note_added',
  append_note: 'note_added',
  create_reminder: 'reminder',
  create_event: 'calendar',
  search: 'search',
  express: 'music',
  get_weather: 'weather_cloud',
};

const SCENE_SECONDS: Partial<Record<SceneName, number>> = { timer_set: 8, music: 10, weather_sun: 8, weather_cloud: 8, weather_rain: 8, weather_snow: 8 };
const DEFAULT_SCENE_SECONDS = 5;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function weatherScene(output: Record<string, unknown>): SceneName {
  const condition = typeof output.condition === 'string' ? output.condition.toLowerCase() : '';
  if (/snow|sleet|flurr/.test(condition)) return 'weather_snow';
  if (/rain|drizzle|shower|storm/.test(condition)) return 'weather_rain';
  if (/sun|clear|fair/.test(condition)) return 'weather_sun';
  return 'weather_cloud';
}

/** The scene for one finished tool call, or null when it earns none (a failed
 *  result, a read-only tool, or a feeling other than music). */
export function sceneForToolResult(toolName: string, input: unknown, output: unknown): ScenePayload | null {
  const out = record(output);
  if (out.ok === false) return null;
  const args = record(input);
  let scene = SCENE_BY_TOOL[toolName];
  if (scene === undefined) return null;
  if (toolName === 'express' && args.emotion !== 'music') return null;
  if (toolName === 'get_weather') scene = weatherScene(out);
  const payload: ScenePayload = { scene, seconds: SCENE_SECONDS[scene] ?? DEFAULT_SCENE_SECONDS };
  if (toolName === 'set_timer') {
    if (typeof args.label === 'string' && args.label !== '') payload.label = clipLabel(args.label, SCENE_LABEL_MAX);
    const ms = typeof args.duration === 'string' || typeof args.duration === 'number' ? parseTimerDuration(args.duration) : null;
    if (ms !== null) payload.value = Math.round(ms / 1000);
  }
  return payload;
}
