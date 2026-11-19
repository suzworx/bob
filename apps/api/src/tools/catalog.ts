/** Stable IDs are the actual Core tool names; preferences never grant capability. */
const groups: Readonly<Record<string, readonly string[]>> = {
  Apps: ['propose_bob_app', 'revise_bob_app', 'list_bob_apps', 'read_bob_app', 'save_app_idea', 'read_marketing_config', 'propose_marketing_config'],
  Productivity: ['list_tasks', 'create_task', 'complete_task', 'update_task', 'list_agenda', 'create_event', 'list_space_members', 'create_reminder', 'list_reminders', 'cancel_reminder', 'create_note', 'append_note', 'read_note', 'search', 'read_inbox', 'notify_email'],
  Memory: ['remember', 'forget', 'list_actions', 'complete_action'],
  Timers: ['set_timer', 'set_alarm', 'list_timers', 'cancel_timer'],
  Google: ['google_list_accounts', 'google_calendar_list_calendars', 'google_calendar_list_events', 'google_calendar_create_event', 'google_calendar_update_event', 'google_gmail_search', 'google_gmail_read_thread', 'google_gmail_draft_reply', 'google_gmail_read_draft', 'google_gmail_compose_draft', 'google_gmail_update_draft', 'google_gmail_send_draft', 'google_gmail_trash_message', 'google_gmail_restore_message'],
  Routines: ['create_routine', 'list_routines', 'edit_routine', 'pause_routine', 'resume_routine', 'delete_routine', 'get_saved_insights', 'get_routine_timeline', 'list_timeline'],
  Bob: ['currentDateTime', 'express', 'set_volume', 'set_mode'],
  Marketing: ['add_marketing_review_note', 'marketing_context', 'research_sources', 'create_campaign', 'list_campaigns', 'read_campaign', 'select_campaign', 'save_plan_section', 'save_week_plan', 'save_draft', 'update_draft', 'list_drafts', 'read_draft', 'list_capabilities'],
  Games: ['list_games', 'start_game', 'pause_game', 'resume_game', 'stop_game', 'game_status', 'play_again', 'riddle_guess', 'riddle_hint', 'riddle_skip', 'simon_next', 'simon_caught'],
};
const labels: Readonly<Record<string, string>> = {
  currentDateTime: 'Check date and time',
  notify_email: 'Email a notification from Bob',
  google_list_accounts: 'Find connected Google accounts',
  google_calendar_list_calendars: 'List Google calendars',
  google_calendar_list_events: 'Read Google Calendar events',
  google_calendar_create_event: 'Create Google Calendar events',
  google_calendar_update_event: 'Edit Google Calendar events',
  google_gmail_search: 'Search Gmail',
  google_gmail_read_thread: 'Read Gmail conversations',
  google_gmail_draft_reply: 'Draft Gmail replies',
  google_gmail_read_draft: 'Read Gmail drafts',
  google_gmail_compose_draft: 'Compose Gmail drafts',
  google_gmail_update_draft: 'Edit Gmail drafts',
  google_gmail_send_draft: 'Send Gmail drafts',
  google_gmail_trash_message: 'Move Gmail messages to Trash',
  google_gmail_restore_message: 'Restore Gmail messages from Trash',
  get_routine_timeline: 'Read routine history',
  list_timeline: 'Read your timeline',
  get_saved_insights: 'Read saved insights',
};
export const TOOL_CATALOG = Object.entries(groups).flatMap(([group, ids]) => ids.map((id) => {
  const name = labels[id] ?? id.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
  return { id, toolName: id, group, name, description: `Let Bob ${name.charAt(0).toLowerCase()}${name.slice(1)} when you ask.`, integrationKind: group === 'Google' ? 'google' as const : null };
}));
export function isKnownTool(id: string): boolean { return TOOL_CATALOG.some((tool) => tool.id === id); }
