import { z } from 'zod';
import { asServer, withUser, type Db } from '../platform/db/db.ts';
import { createNoteOnce } from '../notes/store.ts';
import { InsightCategorySchema, InsightSchema, RoutineRunSchema, RoutineTimelineQuerySchema } from './execution-schemas.ts';
import { getGoogleAccount } from '../integrations/google-store.ts';

type Insight = z.infer<typeof InsightSchema>;
export interface RoutineRunContext {
  id: string; owner: string; routineId: string; googleAccountId: string; revision: number; token: string;
  coverageStart: number; coverageEnd: number; partial: boolean; emailResult: boolean;
  instructions?: string; gmailQuery?: string; summaryStyle?: 'concise' | 'detailed';
}
type ClaimRow = { owner: string; routine_id: string; google_account_id: string; revision: number; attempt_token: string;
  coverage_start: Date | string; coverage_end: Date | string; partial: boolean };
const Digest = z.object({ summary: z.string().min(1).max(6000), messageCount: z.number().int().min(0).max(200), partial: z.boolean(),
  sources: z.array(z.object({ threadId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), messageId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), label: z.string().max(300) })).max(200) });
const INSIGHT_COLUMNS = `id,routine_id as "routineId",google_account_id as "googleAccountId",category,title,summary,
 (extract(epoch from period_start)*1000)::float8 as "periodStart",(extract(epoch from period_end)*1000)::float8 as "periodEnd",
 (extract(epoch from generated_at)*1000)::float8 as "generatedAt",sources,partial,message_count as "messageCount"`;

async function readInsight(db: Db, owner: string, id: string): Promise<Insight | null> {
  return withUser(db, owner, async (tx) => {
    const row = (await tx.query(`select ${INSIGHT_COLUMNS} from bob.insights where id=$1`, [id]))[0];
    return row ? InsightSchema.parse(row) : null;
  });
}

export async function listInsights(db: Db, owner: string, category: z.infer<typeof InsightCategorySchema>): Promise<Insight[]> {
  InsightCategorySchema.parse(category);
  return withUser(db, owner, async (tx) => (await tx.query(`select ${INSIGHT_COLUMNS} from bob.insights where category=$1 and run_id is null order by generated_at desc,id desc limit 100`, [category])).map((row) => InsightSchema.parse(row)));
}

const RUN_COLUMNS = `r.id,r.routine_id as "routineId",d.name as "routineName",r.state as status,r.failure_code as "failureCode",legacy.id as "insightId",
 (extract(epoch from r.scheduled_at)*1000)::float8 as "scheduledAt",(extract(epoch from r.started_at)*1000)::float8 as "startedAt",
 (extract(epoch from r.completed_at)*1000)::float8 as "completedAt",r.email_outcome as "emailOutcome",
 (extract(epoch from r.coverage_start)*1000)::float8 as "coverageStart",(extract(epoch from r.coverage_end)*1000)::float8 as "coverageEnd",
 case when i.id is null then null else jsonb_build_object('id',i.id,'title',i.title,'summary',i.summary,'sources',i.sources,
 'periodStart',(extract(epoch from i.period_start)*1000)::float8,'periodEnd',(extract(epoch from i.period_end)*1000)::float8,
 'generatedAt',(extract(epoch from i.generated_at)*1000)::float8,'partial',i.partial,'messageCount',i.message_count) end as result`;
const RUN_FROM = 'from bob.routine_runs r join bob.routines d on d.id=r.routine_id left join bob.routine_results i on i.run_id=r.id left join bob.insights legacy on legacy.run_id=r.id';
export async function listRoutineRuns(db: Db, owner: string, routineId: string): Promise<z.infer<typeof RoutineRunSchema>[]> {
 z.uuid().parse(routineId);
 return withUser(db, owner, async tx => (await tx.query(`select ${RUN_COLUMNS} ${RUN_FROM} where r.routine_id=$1 order by r.scheduled_at desc,r.id desc limit 100`, [routineId])).map(row => RoutineRunSchema.parse(row)));
}
export async function getRoutineRun(db: Db, owner: string, routineId: string, runId: string): Promise<z.infer<typeof RoutineRunSchema> | null> {
 z.uuid().parse(routineId); z.uuid().parse(runId);
 return withUser(db, owner, async tx => {
  const row = (await tx.query(`select ${RUN_COLUMNS} ${RUN_FROM} where r.routine_id=$1 and r.id=$2`, [routineId,runId]))[0];
  return row ? RoutineRunSchema.parse(row) : null;
 });
}
export async function listRoutineTimeline(db: Db, owner: string, value: z.input<typeof RoutineTimelineQuerySchema> = {}): Promise<{ runs: z.infer<typeof RoutineRunSchema>[]; nextCursor: { before: number; beforeId: string } | null }> {
 const input = RoutineTimelineQuerySchema.parse(value);
 return withUser(db, owner, async tx => {
  const rows = await tx.query(`select ${RUN_COLUMNS} ${RUN_FROM} where ($1::timestamptz is null or (r.scheduled_at,r.id)<($1::timestamptz,$2::uuid)) order by r.scheduled_at desc,r.id desc limit $3`,
   [input.before === undefined ? null : new Date(input.before), input.beforeId ?? null, input.limit + 1]);
  const runs = rows.slice(0,input.limit).map(row => RoutineRunSchema.parse(row)); const last = runs.at(-1);
  return { runs, nextCursor: rows.length > input.limit && last ? { before: last.scheduledAt, beforeId: last.id } : null };
 });
}

export async function startRoutineRun(db: Db, id: string, now: number): Promise<RoutineRunContext | null> {
  z.uuid().parse(id);
  const row = (await asServer(db, (tx) => tx.query<ClaimRow>('select * from bob_private.routine_claim($1,$2)', [id, new Date(now)])))[0];
  if (!row) return null;
  const config = await withUser(db, row.owner, async tx => (await tx.query<{ instructions: string; gmail_query: string; summary_style: 'concise' | 'detailed'; email_result: boolean }>('select instructions,gmail_query,summary_style,email_result from bob.routines where id=$1 and revision=$2', [row.routine_id,row.revision]))[0]);
  if (!config) return null;
  return row ? { instructions: config.instructions, gmailQuery: config.gmail_query, summaryStyle: config.summary_style, emailResult: config.email_result, id, owner: row.owner, routineId: row.routine_id, googleAccountId: row.google_account_id, revision: row.revision,
    token: row.attempt_token, coverageStart: new Date(row.coverage_start).getTime(), coverageEnd: new Date(row.coverage_end).getTime(), partial: row.partial } : null;
}

export async function checkRoutineRun(db: Db, run: RoutineRunContext): Promise<void> {
  const rows = await withUser(db, run.owner, (tx) => tx.query(`select x.id from bob.routine_runs x join bob.routines r on r.id=x.routine_id
    where x.id=$1 and x.attempt_token=$2 and x.state='running' and r.status='active' and r.revision=x.revision`, [run.id, run.token]));
  if (rows.length !== 1) throw new Error('routine_run_stale');
}

export async function publishRoutineResult(db: Db, run: RoutineRunContext, value: z.infer<typeof Digest>, now: number): Promise<Insight | null> {
  const result = Digest.parse(value);
  const account = await getGoogleAccount(db, run.owner, run.googleAccountId);
  if (!account) return null;
  const sources = result.sources.map((source) => ({ kind: 'gmail' as const, id: source.messageId, label: source.label,
    url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(account.email)}#all/${source.threadId}` }));
  const rows = await asServer(db, (tx) => tx.query<{ id: string | null }>('select bob_private.routine_complete($1,$2,$3,$4::jsonb,$5,$6,$7) as id',
    [run.id, run.token, result.summary, sources, result.messageCount, result.partial, new Date(now)]));
  const id = rows[0]?.id;
  if (!id) return null;
  return withUser(db, run.owner, async tx => {
    const row = (await tx.query(`select ${INSIGHT_COLUMNS} from bob.routine_results where id=$1`, [id]))[0];
    return row ? InsightSchema.parse(row) : null;
  });
}

const RoutineEmailContextSchema = z.object({
  owner: z.uuid(), space_id: z.uuid(), note_id: z.uuid(),
  title: z.string().min(1).max(200), body: z.string().max(20_000),
}).strict();

/**
 * Loads the completed result through the restricted server helper, then
 * creates its private note once under the owner's normal RLS context. The run
 * UUID is both the result's stable identity and the note's idempotency key.
 * Null when there is nothing to send, including a note the owner trashed.
 */
export async function getRoutineEmailDeliveryContext(db: Db, runId: string): Promise<{
  owner: string; spaceId: string; noteId: string;
} | null> {
  z.uuid().parse(runId);
  const rows = await asServer(db, (tx) => tx.query(
    'select * from bob_private.get_routine_email_delivery_context($1)',
    [runId],
  ));
  const row = rows[0];
  if (!row) return null;
  const context = RoutineEmailContextSchema.parse(row);
  const note = await createNoteOnce(db, context.owner, context.space_id, context.note_id, {
    title: context.title, body: context.body, aiAssisted: true,
  });
  return note ? { owner: context.owner, spaceId: context.space_id, noteId: note.id } : null;
}

export async function recordRoutineEmailOutcome(db: Db, runId: string, outcome: 'queued' | 'muted'): Promise<void> {
  z.uuid().parse(runId);
  await asServer(db, (tx) => tx.query(
    'select bob_private.routine_email_outcome($1,$2)',
    [runId, outcome],
  ));
}

export async function failRoutineRun(db: Db, run: RoutineRunContext, code: 'consent_unavailable' | 'provider_unavailable' | 'summary_unavailable' | 'cancelled' | 'stale', pause: boolean, now: number): Promise<void> {
  await asServer(db, (tx) => tx.query('select bob_private.routine_fail($1,$2,$3,$4,$5)', [run.id, run.token, code, pause, new Date(now)]));
}

export async function persistInsightDraft(db: Db, owner: string, value: Omit<Insight, 'id' | 'routineId'>): Promise<Insight> {
  const draft = InsightSchema.omit({ id: true, routineId: true }).parse(value);
  if (draft.category === 'past') throw new Error('insight_requires_run');
  const rows = await asServer(db, (tx) => tx.query<{ id: string }>('select bob_private.insight_refresh($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) as id',
    [owner, draft.googleAccountId, draft.category, draft.title, draft.summary, new Date(draft.periodStart), new Date(draft.periodEnd), new Date(draft.generatedAt), draft.sources, draft.partial]));
  const id = rows[0]?.id;
  if (!id) throw new Error('insight_account_unavailable');
  const saved = await readInsight(db, owner, id);
  if (!saved) throw new Error('insight_account_unavailable');
  return saved;
}

/** Explicit evidence input for reflections; execution results remain owned by routines. */
export async function listRoutineResults(db: Db, owner: string, googleAccountId: string): Promise<Insight[]> {
 z.uuid().parse(googleAccountId);
 return withUser(db,owner,async tx => (await tx.query(`select ${INSIGHT_COLUMNS} from bob.routine_results where google_account_id=$1 order by generated_at desc,id desc limit 100`,[googleAccountId])).map(row => InsightSchema.parse(row)));
}
