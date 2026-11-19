/**
 * GET /api/account/export: the caller's own data as a streamed JSON download
 * (issue #514). Runs requireActiveSession, so a revoked session's still-valid
 * token cannot pull an export, and a per-account token bucket caps it at one
 * export a minute (429 rate_limited).
 *
 * Private by construction, three layers deep:
 *  - every section is read under withUser, so RLS decides what is visible;
 *  - every section is further narrowed to rows the caller authored or owns,
 *    and space-scoped rows to spaces the caller is STILL an active member of,
 *    so another member's note in a shared space and a space the caller left
 *    are both absent;
 *  - every column is named, never `*`, and each row passes a strict Zod schema,
 *    so a token hash, refresh token, device secret, embedding or outbox row can
 *    never reach the file even if a later migration adds such a column.
 * Message text is exported from `text` parts only (no tool payloads, no
 * attachment bytes).
 *
 * All sections are read in ONE transaction (a consistent snapshot) and the
 * connection is released before streaming, so a slow download never holds a
 * pooled database connection. Writes honour backpressure. Journals one
 * counts-only event: v2.account_exported.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { moduleJournal } from '../platform/logger.ts';
import { StoreError, withUser, type Db } from '../platform/db/db.ts';
import { accountTablesPresent } from './store.ts';
import { createTokenBucket } from '../platform/http/rate-limit.ts';
import { RoutineScheduleSchema } from '../routines/schemas.ts';
import { InsightSourceSchema, RoutineRunSchema } from '../routines/execution-schemas.ts';
import { BobAppDefinitionSchema, RecordStateSchema } from '../bob-apps/schemas.ts';
import { BobAppRefreshConfigSchema } from '../bob-apps/refresh-schemas.ts';

const journal = moduleJournal('account');

/** One export per account per minute (token bucket: capacity 1, refill 60 s). */
const EXPORTS_PER_MINUTE = 1;

interface ExportRouterDeps {
  getDb: () => Promise<Db>;
  requireActiveSession: (request: Request, response: Response, next: NextFunction) => Promise<void>;
  limiter?: { take: (key: string) => boolean };
  now?: () => number;
}

const instant = z.coerce.date().transform((date) => date.toISOString());
const day = z.string().nullable();
const id = z.string();

const SpaceSchema = z.object({ id, name: z.string(), kind: z.string(), role: z.string(), joined_at: instant }).strict();
const GroupChatSchema = z.object({ id, space_id: id, title: z.string(), role: z.string() }).strict();
const GroupChatLinkSchema = z.object({ id, space_id: id, created_at: instant, expires_at: instant, revoked_at: instant.nullable() }).strict();
const ConversationSchema = z.object({ id, title: z.string(), created_at: instant, updated_at: instant }).strict();
const MessageSchema = z.object({
  conversation_id: id, role: z.string(), origin: z.string(), text: z.string(), created_at: instant,
}).strict();
const MemorySchema = z.object({
  id, kind: z.string(), content: z.string(), sensitive: z.boolean(), superseded: z.boolean(),
  created_at: instant, updated_at: instant,
}).strict();
const TaskSchema = z.object({
  id, space_id: id, parent_task_id: id.nullable(), title: z.string(), body: z.string().nullable(),
  status: z.string(), due_date: day, due_at: instant.nullable(), due_zone: z.string().nullable(),
  completed_at: instant.nullable(), trashed_at: instant.nullable(), created_at: instant, updated_at: instant,
}).strict();
const NoteSchema = z.object({
  id, space_id: id, title: z.string(), body: z.string(), pinned: z.boolean(),
  trashed_at: instant.nullable(), created_at: instant, updated_at: instant,
}).strict();
const EventSchema = z.object({
  id, space_id: id, calendar_id: id, title: z.string(), location: z.string().nullable(), body: z.string().nullable(),
  all_day: z.boolean(), start_date: day, end_date: day, start_at: instant.nullable(), end_at: instant.nullable(),
  zone: z.string(), rrule: z.unknown(), status: z.string(), created_at: instant, updated_at: instant,
}).strict();
const ReminderSchema = z.object({
  id, space_id: id, title: z.string(), due_date: day, due_at: instant.nullable(), due_zone: z.string().nullable(),
  rrule: z.unknown(), status: z.string(), created_at: instant, updated_at: instant,
}).strict();
const TimerSchema = z.object({
  id, kind: z.string(), label: z.string().nullable(), fires_at: instant, duration_ms: z.number().nullable(),
  status: z.string(), created_at: instant, fired_at: instant.nullable(),
}).strict();

/** A driver that binds JSON text returns jsonb as a string; decode it first. */
const jsonb = <S extends z.ZodType>(schema: S): z.ZodType<z.infer<S>> =>
  z.preprocess((value) => (typeof value === 'string' ? JSON.parse(value) : value), schema) as z.ZodType<z.infer<S>>;
const ActionItemSchema = z.object({
  id, memory_id: id, due_at: instant.nullable(), status: z.string(), created_at: instant, updated_at: instant,
}).strict();
// Players are the caller's own data (a first name or nickname and a band).
const PlayerSchema = z.object({ name: z.string(), band: z.string(), team: z.string().optional() }).strict();
const GameSessionSchema = z.object({
  id, conversation_id: id, game: z.string(), status: z.string(), players: jsonb(z.array(PlayerSchema)),
  turn_index: z.number().int(), scores: jsonb(z.array(z.number())), state: jsonb(z.unknown()),
  started_at: instant, last_turn_at: instant, ended_at: instant.nullable(), end_reason: z.string().nullable(),
}).strict();
const GameSettingsSchema = z.object({
  enabled: z.boolean(), kids_mode: z.boolean(), max_band: z.string(), allowed_games: z.array(z.string()),
  daily_limit_minutes: z.number().int(), quiet_start: z.string().nullable(), quiet_end: z.string().nullable(),
  updated_at: instant,
}).strict();
const GameUsageSchema = z.object({ day: z.string(), seconds: z.number().int() }).strict();
const GoogleAccountSchema = z.object({
  id, email: z.string(), name: z.string().nullable(), custom_name: z.string().nullable(), selected: z.boolean(),
  created_at: instant, updated_at: instant,
}).strict();
const GoogleOperationSchema = z.object({
  operation_id: id, google_account_id: id,
  kind: z.enum(['calendar_create', 'calendar_update', 'gmail_draft']),
  state: z.enum(['pending', 'succeeded', 'unknown', 'failed']), result_id: id.nullable(),
  created_at: instant, updated_at: instant,
}).strict();
const GoogleCalendarSelectionSchema = z.object({
  google_account_id: id, calendar_id: id, title: z.string(), time_zone: z.string().nullable(), last_success_at: instant.nullable(),
}).strict();
const GoogleOperationSlotSchema = z.object({
  google_account_id: id, anchor_message_id: id, ordinal: z.number().int(),
  kind: z.enum(['calendar_create', 'calendar_update', 'gmail_draft']), operation_id: id,
}).strict();
const RoutineExportSchema = z.object({
  id: z.uuid(), google_account_id: z.uuid(), kind: z.literal('daily_gmail_digest'),
  local_time: RoutineScheduleSchema.shape.localTime, time_zone: RoutineScheduleSchema.shape.timeZone,
  scheduled_read_consent: z.literal(true), status: z.enum(['active', 'paused', 'archived']),
  name: z.string(), instructions: z.string(), gmail_query: z.string(), weekdays: z.array(z.number().int()), summary_style: z.enum(['concise', 'detailed']),
  revision: z.number().int().positive().max(2_147_483_647), next_run_at: instant.nullable(),
  created_at: instant, updated_at: instant,
}).strict();
const RoutineRunExportSchema = z.object({
  id: z.uuid(), routine_id: z.uuid(), revision: z.number().int(), scheduled_at: instant,
  coverage_start: instant, coverage_end: instant, partial: z.boolean(), state: RoutineRunSchema.shape.status,
  attempt: z.number().int(), failure_code: RoutineRunSchema.shape.failureCode, started_at: instant.nullable(), completed_at: instant.nullable(),
}).strict();
const InsightExportSchema = z.object({
  id: z.uuid(), google_account_id: z.uuid(), routine_id: z.uuid().nullable(), run_id: z.uuid().nullable(),
  category: z.enum(['future', 'reflections', 'past']), title: z.string(), summary: z.string(),
  period_start: instant, period_end: instant, generated_at: instant, sources: z.array(InsightSourceSchema), partial: z.boolean(), message_count: z.number().int(),
}).strict();

type Message = z.infer<typeof MessageSchema>;
const ToolPreferenceExportSchema = z.object({ scope: z.string(), scope_id: z.string(), tool_id: z.string(), enabled: z.boolean(), updated_at: instant }).strict();
const BobAppAccountExportSchema = z.strictObject({
  id: z.uuid(), lifecycle: z.enum(['draft', 'active', 'archived']), revision: z.number().int().positive(),
  definition: BobAppDefinitionSchema, state: RecordStateSchema,
  pending_definition: BobAppDefinitionSchema.nullable(), undo_definition: BobAppDefinitionSchema.nullable(),
  created_at: instant, updated_at: instant,
});
const BobAppScheduleExportSchema = z.strictObject({ app_id: z.uuid(), enabled: z.boolean(), config: BobAppRefreshConfigSchema.nullable(), next_run_at: instant.nullable(), last_updated_at: instant.nullable() });
const BobAppRunExportSchema = z.strictObject({ id: z.uuid(), app_id: z.uuid(), scheduled_at: instant, completed_at: instant.nullable(), status: z.enum(['pending', 'completed', 'failed', 'skipped']), failure_code: z.enum(['stale', 'permission_unavailable', 'source_unavailable']).nullable() });
type ExportedConversation = z.infer<typeof ConversationSchema> & { messages: Array<Omit<Message, 'conversation_id'>> };

type AccountExport = {
  spaces: Array<z.infer<typeof SpaceSchema>>;
  group_chats: Array<z.infer<typeof GroupChatSchema>>;
  group_chat_links: Array<z.infer<typeof GroupChatLinkSchema>>;
  conversations: ExportedConversation[];
  memories: Array<z.infer<typeof MemorySchema>>;
  tasks: Array<z.infer<typeof TaskSchema>>;
  notes: Array<z.infer<typeof NoteSchema>>;
  events: Array<z.infer<typeof EventSchema>>;
  reminders: Array<z.infer<typeof ReminderSchema>>;
  timers: Array<z.infer<typeof TimerSchema>>;
  action_items: Array<z.infer<typeof ActionItemSchema>>;
  game_sessions: Array<z.infer<typeof GameSessionSchema>>;
  game_settings: Array<z.infer<typeof GameSettingsSchema>>;
  game_usage: Array<z.infer<typeof GameUsageSchema>>;
  google_accounts: Array<z.infer<typeof GoogleAccountSchema>>;
  google_operations: Array<z.infer<typeof GoogleOperationSchema>>;
  google_calendar_selections: Array<z.infer<typeof GoogleCalendarSelectionSchema>>;
  google_operation_slots: Array<z.infer<typeof GoogleOperationSlotSchema>>;
  routines: Array<z.infer<typeof RoutineExportSchema>>;
  routine_runs: Array<z.infer<typeof RoutineRunExportSchema>>;
  insights: Array<z.infer<typeof InsightExportSchema>>;
  routine_results: Array<z.infer<typeof InsightExportSchema>>;
  tool_preferences: Array<z.infer<typeof ToolPreferenceExportSchema>>;
  bob_apps: Array<z.infer<typeof BobAppAccountExportSchema>>;
  bob_app_schedules: Array<z.infer<typeof BobAppScheduleExportSchema>>;
  bob_app_runs: Array<z.infer<typeof BobAppRunExportSchema>>;
};

/** The JSON document assembled by streamExport after row validation. */
export const AccountExportResponseSchema = z.object({
  format: z.literal('bob.account-export'),
  version: z.literal(1),
  exported_at: z.string(),
  spaces: z.array(SpaceSchema),
  group_chats: z.array(GroupChatSchema),
  group_chat_links: z.array(GroupChatLinkSchema),
  conversations: z.array(ConversationSchema.extend({ messages: z.array(MessageSchema.omit({ conversation_id: true })) })),
  memories: z.array(MemorySchema),
  tasks: z.array(TaskSchema),
  notes: z.array(NoteSchema),
  events: z.array(EventSchema),
  reminders: z.array(ReminderSchema),
  timers: z.array(TimerSchema),
  action_items: z.array(ActionItemSchema),
  game_sessions: z.array(GameSessionSchema),
  game_settings: z.array(GameSettingsSchema),
  game_usage: z.array(GameUsageSchema),
  google_accounts: z.array(GoogleAccountSchema),
  google_operations: z.array(GoogleOperationSchema),
  google_calendar_selections: z.array(GoogleCalendarSelectionSchema),
  google_operation_slots: z.array(GoogleOperationSlotSchema),
  routines: z.array(RoutineExportSchema),
  routine_runs: z.array(RoutineRunExportSchema),
  insights: z.array(InsightExportSchema),
  routine_results: z.array(InsightExportSchema),
  tool_preferences: z.array(ToolPreferenceExportSchema),
  bob_apps: z.array(BobAppAccountExportSchema),
  bob_app_schedules: z.array(BobAppScheduleExportSchema),
  bob_app_runs: z.array(BobAppRunExportSchema),
}).strict();

/** Space-scoped rows are limited to spaces the caller is still an active member of. */
const ACTIVE_SPACES = `space_id IN (SELECT space_id FROM bob.space_memberships
  WHERE user_id = $1 AND revoked_at IS NULL)`;

/** General's conversations: no space yet, or a private one (conversations/space-scope.ts).
 *  Messages follow, since only these conversations collect them below. */
const PRIVATE_CONVERSATIONS = "(space_id IS NULL OR space_id IN (SELECT id FROM bob.spaces WHERE kind = 'private'))";

const SQL = {
  spaces: `SELECT s.id::text AS id, s.name, s.kind, m.role, m.joined_at FROM bob.spaces s
    JOIN bob.space_memberships m ON m.space_id = s.id AND m.user_id = $1 AND m.revoked_at IS NULL
    ORDER BY m.joined_at, s.id`,
  groupChats: `SELECT c.id, s.id::text AS space_id, c.title, m.role
    FROM bob.spaces s JOIN bob.conversations c ON c.id = s.conversation_id
    JOIN bob.space_memberships m ON m.space_id = s.id AND m.user_id = $1 AND m.revoked_at IS NULL
    WHERE s.archived_at IS NULL ORDER BY c.created_at, c.id`,
  groupChatLinks: `SELECT id::text AS id, space_id::text AS space_id, created_at, expires_at, revoked_at
    FROM bob.group_chat_links WHERE created_by = $1 AND ${ACTIVE_SPACES} ORDER BY created_at, id`,
  // Private conversations only: a copied space thread (#756) is the space's, not the creator's.
  conversations: `SELECT id, title, created_at, updated_at FROM bob.conversations
    WHERE user_id = $1 AND ${PRIVATE_CONVERSATIONS} ORDER BY created_at, id`,
  // A driver that binds the JSON text stores parts as a jsonb string; decode it
  // as store/conversations.ts does, and read text only from a real array.
  messages: `SELECT m.conversation_id, m.role, m.origin, m.created_at,
      COALESCE((SELECT string_agg(e.part->>'text', '' ORDER BY e.ord)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.parts) = 'array' THEN d.parts ELSE '[]'::jsonb END)
          WITH ORDINALITY AS e(part, ord)
        WHERE e.part->>'type' = 'text'), '') AS text
    FROM bob.messages m JOIN bob.message_versions v ON v.message_id = m.id AND v.is_selected
    CROSS JOIN LATERAL (SELECT CASE jsonb_typeof(v.parts) WHEN 'string' THEN (v.parts #>> '{}')::jsonb
      ELSE v.parts END AS parts) d
    WHERE m.user_id = $1 ORDER BY m.conversation_id, m.position`,
  memories: `SELECT id, kind, content, sensitive, superseded_by IS NOT NULL AS superseded, created_at, updated_at
    FROM bob.memories WHERE user_id = $1 ORDER BY created_at, id`,
  tasks: `SELECT id::text AS id, space_id::text AS space_id, parent_task_id::text AS parent_task_id, title, body,
      status, due_date::text AS due_date, due_at, due_zone, completed_at, trashed_at, created_at, updated_at
    FROM bob.tasks WHERE created_by = $1 AND ${ACTIVE_SPACES} ORDER BY created_at, id`,
  notes: `SELECT id::text AS id, space_id::text AS space_id, title, body, pinned, trashed_at, created_at, updated_at
    FROM bob.notes WHERE created_by = $1 AND ${ACTIVE_SPACES} ORDER BY created_at, id`,
  events: `SELECT id::text AS id, space_id::text AS space_id, calendar_id::text AS calendar_id, title, location, body,
      all_day, start_date::text AS start_date, end_date::text AS end_date, start_at, end_at, zone, rrule, status,
      created_at, updated_at
    FROM bob.calendar_events WHERE organizer_user_id = $1 AND ${ACTIVE_SPACES} ORDER BY created_at, id`,
  reminders: `SELECT id::text AS id, space_id::text AS space_id, title, due_date::text AS due_date, due_at, due_zone,
      rrule, status, created_at, updated_at
    FROM bob.reminders WHERE created_by = $1 AND kind = 'reminder' AND ${ACTIVE_SPACES} ORDER BY created_at, id`,
  timers: `SELECT id::text AS id, kind, title AS label, due_at AS fires_at, duration_ms::integer AS duration_ms,
      status, created_at, fired_at
    FROM bob.reminders WHERE created_by = $1 AND kind <> 'reminder' ORDER BY created_at, id`,
  actionItems: `SELECT id, memory_id, due_at, status, created_at, updated_at
    FROM bob.action_items WHERE user_id = $1 ORDER BY created_at, id`,
  // No seed, version or device: engine internals, not the caller's data.
  gameSessions: `SELECT id::text AS id, conversation_id, game, status, players, turn_index, scores, state,
      started_at, last_turn_at, ended_at, end_reason
    FROM bob.game_sessions WHERE user_id = $1 ORDER BY started_at, id`,
  // user_state is shared with the pointers; saved settings have games_updated_at set.
  gameSettings: `SELECT games_enabled AS enabled, games_kids_mode AS kids_mode, games_max_band AS max_band,
      games_allowed_games AS allowed_games, games_daily_limit_minutes AS daily_limit_minutes,
      games_quiet_start AS quiet_start, games_quiet_end AS quiet_end, games_updated_at AS updated_at
    FROM bob.user_state WHERE user_id = $1 AND games_updated_at IS NOT NULL`,
  gameUsage: `SELECT day::text AS day, seconds FROM bob.game_usage WHERE user_id = $1 ORDER BY day`,
  // Export user-facing connection metadata and outcomes, never broker selectors,
  // credentials, intent hashes or internal reconciliation markers.
  googleAccounts: `SELECT id, email, name, custom_name, selected, created_at, updated_at
    FROM bob.google_accounts WHERE user_id = $1 ORDER BY created_at, id`,
  googleOperations: `SELECT operation_id, google_account_id, kind, state, result_id, created_at, updated_at
    FROM bob.google_operations WHERE user_id = $1 ORDER BY created_at, google_account_id, operation_id`,
  googleCalendarSelections: `SELECT google_account_id, calendar_id, title, time_zone, last_success_at
    FROM bob.google_calendar_selections WHERE user_id = $1 ORDER BY google_account_id, calendar_id`,
  // Opaque turn mapping links to the exported outcome; never export intent/target hashes.
  googleOperationSlots: `SELECT google_account_id, anchor_message_id, ordinal, kind, operation_id
    FROM bob.google_operation_slots WHERE user_id = $1 ORDER BY anchor_message_id, ordinal`,
  routines: `SELECT id, google_account_id, kind, local_time, time_zone, scheduled_read_consent,
      status, revision, next_run_at, created_at, updated_at, name, instructions, gmail_query, weekdays, summary_style
    FROM bob.routines WHERE user_id = $1 ORDER BY created_at, id`,
  routineRuns: `SELECT id,routine_id,revision,scheduled_at,coverage_start,coverage_end,partial,state,attempt,failure_code,started_at,completed_at
    FROM bob.routine_runs WHERE user_id=$1 ORDER BY scheduled_at,id`,
  insights: `SELECT id,google_account_id,routine_id,run_id,category,title,summary,period_start,period_end,generated_at,sources,partial,message_count
    FROM bob.insights WHERE user_id=$1 ORDER BY generated_at,id`,
} as const;

async function rows<S extends z.ZodType>(tx: Db, sql: string, userId: string, schema: S): Promise<Array<z.infer<S>>> {
  const raw = await tx.query<unknown>(sql, [userId]);
  return raw.map((row) => schema.parse(row));
}

/** Reads every export section in one withUser transaction (one snapshot). */
export async function readAccountExport(db: Db, userId: string): Promise<AccountExport> {
  const present = await accountTablesPresent(db);
  return withUser(db, userId, async (tx) => {
    const conversations = await rows(tx, SQL.conversations, userId, ConversationSchema);
    const byConversation = new Map<string, ExportedConversation>(
      conversations.map((c) => [c.id, { ...c, messages: [] }]),
    );
    for (const { conversation_id: conversationId, ...message } of await rows(tx, SQL.messages, userId, MessageSchema)) {
      byConversation.get(conversationId)?.messages.push(message);
    }
    return {
      spaces: await rows(tx, SQL.spaces, userId, SpaceSchema),
      group_chats: await rows(tx, SQL.groupChats, userId, GroupChatSchema),
      group_chat_links: await rows(tx, SQL.groupChatLinks, userId, GroupChatLinkSchema),
      conversations: [...byConversation.values()],
      memories: present.memories ? await rows(tx, SQL.memories, userId, MemorySchema) : [],
      tasks: await rows(tx, SQL.tasks, userId, TaskSchema),
      notes: await rows(tx, SQL.notes, userId, NoteSchema),
      events: await rows(tx, SQL.events, userId, EventSchema),
      reminders: await rows(tx, SQL.reminders, userId, ReminderSchema),
      timers: await rows(tx, SQL.timers, userId, TimerSchema),
      action_items: present.memories ? await rows(tx, SQL.actionItems, userId, ActionItemSchema) : [],
      game_sessions: await rows(tx, SQL.gameSessions, userId, GameSessionSchema),
      game_settings: await rows(tx, SQL.gameSettings, userId, GameSettingsSchema),
      game_usage: await rows(tx, SQL.gameUsage, userId, GameUsageSchema),
      google_accounts: await rows(tx, SQL.googleAccounts, userId, GoogleAccountSchema),
      google_operations: await rows(tx, SQL.googleOperations, userId, GoogleOperationSchema),
      google_calendar_selections: await rows(tx, SQL.googleCalendarSelections, userId, GoogleCalendarSelectionSchema),
      google_operation_slots: await rows(tx, SQL.googleOperationSlots, userId, GoogleOperationSlotSchema),
      routines: await rows(tx, SQL.routines, userId, RoutineExportSchema),
      routine_runs: await rows(tx, SQL.routineRuns, userId, RoutineRunExportSchema),
      insights: await rows(tx, SQL.insights, userId, InsightExportSchema),
      routine_results: await rows(tx, SQL.insights.replace('bob.insights', 'bob.routine_results'), userId, InsightExportSchema),
      tool_preferences: await rows(tx, 'SELECT scope,scope_id,tool_id,enabled,updated_at FROM bob.tool_preferences WHERE owner_user_id=$1 OR scope IN (\'space\',\'conversation\') ORDER BY scope,scope_id,tool_id', userId, ToolPreferenceExportSchema),
      bob_apps: await rows(tx, 'SELECT id,lifecycle,revision,definition,state,pending_definition,undo_definition,created_at,updated_at FROM bob.bob_apps WHERE user_id=$1 ORDER BY created_at,id', userId, BobAppAccountExportSchema),
      bob_app_schedules: await rows(tx, 'SELECT app_id,enabled,config,next_run_at,last_refresh_at AS last_updated_at FROM bob.bob_app_refresh_settings WHERE user_id=$1 ORDER BY app_id', userId, BobAppScheduleExportSchema),
      bob_app_runs: await rows(tx, 'SELECT id,app_id,scheduled_at,completed_at,status,failure_code FROM bob.bob_app_runs WHERE user_id=$1 ORDER BY scheduled_at,id', userId, BobAppRunExportSchema),
    };
  });
}

/** Writes one chunk, waiting for drain; rejects if the client went away. */
function write(response: Response, chunk: string): Promise<void> {
  if (response.destroyed) return Promise.reject(new Error('export client closed'));
  if (response.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const settle = (error?: Error): void => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      if (error) reject(error); else resolve();
    };
    const onDrain = (): void => settle();
    const onClose = (): void => settle(new Error('export client closed'));
    response.once('drain', onDrain);
    response.once('close', onClose);
  });
}

/** Streams the document section by section, one row per write. */
async function streamExport(response: Response, data: AccountExport, exportedAt: string): Promise<void> {
  await write(response, `{"format":"bob.account-export","version":1,"exported_at":${JSON.stringify(exportedAt)}`);
  for (const [section, items] of Object.entries(data) as Array<[string, unknown[]]>) {
    await write(response, `,${JSON.stringify(section)}:[`);
    for (const [index, item] of items.entries()) {
      await write(response, `${index === 0 ? '' : ','}${JSON.stringify(item)}`);
    }
    await write(response, ']');
  }
  await write(response, '}\n');
}

export function createExportRouter({
  getDb,
  requireActiveSession,
  limiter = createTokenBucket(EXPORTS_PER_MINUTE),
  now = Date.now,
}: ExportRouterDeps): Router {
  const router = Router();

  router.get('/export', requireActiveSession, async (request: Request, response: Response): Promise<void> => {
    const userId = request.account?.userId;
    if (!userId) {
      response.status(401).json({ error: { code: 'invalid_token' } });
      return;
    }
    if (!limiter.take(userId)) {
      journal('v2.rate_limited', { route: '/api/account/export' });
      response.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests.' } });
      return;
    }
    const started = now();
    let data: AccountExport;
    try {
      data = await readAccountExport(await getDb(), userId);
    } catch (error) {
      journal('v2.account_export_failed', { stage: 'read', error_name: error instanceof Error ? error.name : 'unknown' });
      if (error instanceof StoreError || error instanceof z.ZodError) {
        response.status(500).json({ error: { code: 'store_error' } });
        return;
      }
      throw error;
    }
    const exportedAt = new Date(started).toISOString();
    response.status(200);
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('content-disposition', `attachment; filename="bob-export-${exportedAt.slice(0, 10)}.json"`);
    response.setHeader('cache-control', 'no-store');
    try {
      await streamExport(response, data, exportedAt);
      response.end();
    } catch {
      // Headers are gone; a truncated body is the only honest signal left.
      journal('v2.account_export_failed', { stage: 'write', error_name: 'client_closed' });
      response.destroy();
      return;
    }
    journal('v2.account_exported', {
      spaces: data.spaces.length,
      conversations: data.conversations.length,
      messages: data.conversations.reduce((total, c) => total + c.messages.length, 0),
      memories: data.memories.length,
      tasks: data.tasks.length,
      notes: data.notes.length,
      events: data.events.length,
      reminders: data.reminders.length,
      timers: data.timers.length,
      action_items: data.action_items.length,
      game_sessions: data.game_sessions.length,
      game_settings: data.game_settings.length,
      game_usage: data.game_usage.length,
      duration_ms: now() - started,
    });
  });

  return router;
}
