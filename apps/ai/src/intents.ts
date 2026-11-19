/** Coarse intent of a turn, derived from the tools it called. Pure: no tool code is imported, names only. */
export type TurnIntent =
  | 'timer_reminder'
  | 'calendar'
  | 'task_note'
  | 'memory'
  | 'game'
  | 'device_control'
  | 'search_info'
  | 'space_collab'
  | 'chat'
  | 'other';

const names = (intent: TurnIntent, tools: readonly string[]): Array<[string, TurnIntent]> =>
  tools.map((tool) => [tool, intent]);

export const TOOL_INTENT: Readonly<Record<string, TurnIntent>> = Object.freeze(
  Object.fromEntries([
    ...names('timer_reminder', ['set_timer', 'set_alarm', 'list_timers', 'cancel_timer', 'create_reminder', 'list_reminders', 'cancel_reminder']),
    ...names('calendar', ['list_agenda', 'create_event']),
    ...names('task_note', ['list_tasks', 'create_task', 'complete_task', 'update_task', 'create_note', 'append_note', 'read_note']),
    ...names('memory', ['remember', 'forget', 'list_actions', 'complete_action']),
    ...names('game', ['list_games', 'start_game', 'pause_game', 'resume_game', 'stop_game', 'game_status', 'play_again', 'riddle_guess', 'riddle_hint', 'riddle_skip', 'simon_next', 'simon_caught']),
    ...names('device_control', ['set_volume', 'set_mode', 'express']),
    ...names('search_info', ['search', 'currentDateTime']),
    ...names('space_collab', ['read_inbox', 'list_space_members']),
  ]),
);

/** No tools called is a plain chat turn; otherwise the first mapped tool decides, and unmapped-only is 'other'. */
export function deriveIntent(toolNames: readonly string[]): TurnIntent {
  if (toolNames.length === 0) return 'chat';
  for (const name of toolNames) {
    const intent = Object.hasOwn(TOOL_INTENT, name) ? TOOL_INTENT[name] : undefined;
    if (intent) return intent;
  }
  return 'other';
}
