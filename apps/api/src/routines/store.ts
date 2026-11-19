import { z } from 'zod';
import { StoreConflictError, StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { RoutineCreateSchema, RoutineDeleteSchema, RoutineSchema, RoutineUpdateSchema } from './schemas.ts';
import { nextRoutineRun } from './schedule.ts';

type Routine = z.infer<typeof RoutineSchema>;
type Row = {
  id: string; google_account_id: string; kind: 'daily_gmail_digest'; local_time: string; time_zone: string;
  scheduled_read_consent: true; email_result: boolean; status: 'active' | 'paused' | 'archived'; name: string; instructions: string; gmail_query: string; summary_style: 'concise' | 'detailed'; weekdays: number[]; revision: number;
  next_run_at: Date | string | null; created_at: Date | string; updated_at: Date | string;
};
const COLUMNS = 'name, instructions, gmail_query, summary_style, weekdays, id, google_account_id, kind, local_time, time_zone, scheduled_read_consent, email_result, status, revision, next_run_at, created_at, updated_at';

async function scoped<T>(db: Db, owner: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  try {
    return await withUser(db, owner, fn);
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError('routine_storage_unavailable');
  }
}

function map(row: Row): Routine {
  return RoutineSchema.parse({
    name: row.name, instructions: row.instructions, gmailQuery: row.gmail_query, summaryStyle: row.summary_style, weekdays: row.weekdays,
    id: row.id, googleAccountId: row.google_account_id, kind: row.kind, localTime: row.local_time,
    timeZone: row.time_zone, scheduledReadConsent: row.scheduled_read_consent, emailResult: row.email_result, status: row.status,
    revision: row.revision, nextRunAt: row.next_run_at === null ? null : new Date(row.next_run_at).getTime(),
    createdAt: new Date(row.created_at).getTime(), updatedAt: new Date(row.updated_at).getTime(),
  });
}

/** Presence and requested capability are definition-time checks, NOT live grants.
 * An executor must freshly authorize gmail.read before every bounded provider read. */
async function requireAccount(tx: Db, id: string): Promise<void> {
  const rows = await tx.query<{ id: string }>(
    `select id from bob.google_accounts where id = $1
     and authorization_capabilities @> array['gmail.read']::text[] for share`, [id],
  );
  if (!rows[0]) throw new StoreNotFoundError('routine_account_unavailable');
}

async function currentRoutine(tx: Db, id: string, revision: number): Promise<Routine> {
  const rows = await tx.query<Row>(`select ${COLUMNS} from bob.routines where id = $1 for update`, [id]);
  if (!rows[0]) throw new StoreNotFoundError('routine_not_found');
  const routine = map(rows[0]);
  if (routine.status === 'archived') throw new StoreNotFoundError('routine_not_found');
  if (routine.revision !== revision) throw new StoreConflictError('routine_revision_conflict');
  return routine;
}

function requiredRow(rows: Row[]): Routine {
  if (!rows[0]) throw new StoreError('routine_write_failed');
  return map(rows[0]);
}

function resolveEmailResult(value: boolean | undefined, current: Routine): boolean {
  return value ?? current.emailResult;
}

/** Saves an intended schedule only; no execution or delivery is promised here. */
export async function createRoutine(db: Db, owner: string, value: z.input<typeof RoutineCreateSchema>, now: number): Promise<Routine> {
  const input = RoutineCreateSchema.parse(value);
  const next = nextRoutineRun({ localTime: input.localTime, timeZone: input.timeZone, weekdays: input.weekdays }, now);
  return scoped(db, owner, async (tx) => {
    await requireAccount(tx, input.googleAccountId);
    return requiredRow(await tx.query<Row>(
      `insert into bob.routines (user_id,google_account_id,kind,local_time,time_zone,scheduled_read_consent,next_run_at,created_at,updated_at,name,instructions,gmail_query,summary_style,weekdays,email_result)
       values ($1,$2,$3,$4,$5,true,$6,$7,$7,$8,$9,$10,$11,$12,$13) returning ${COLUMNS}`,
      [owner, input.googleAccountId, input.kind, input.localTime, input.timeZone, new Date(next), new Date(now), input.name, input.instructions, input.gmailQuery, input.summaryStyle, input.weekdays, input.emailResult],
    ));
  });
}

export async function listRoutines(db: Db, owner: string, includeArchived = false): Promise<Routine[]> {
  return scoped(db, owner, async (tx) => (await tx.query<Row>(
    `select ${COLUMNS} from bob.routines where ($1::boolean or status <> 'archived') order by created_at, id`, [includeArchived],
  )).map(map));
}

export async function updateRoutine(db: Db, owner: string, id: string, value: z.infer<typeof RoutineUpdateSchema>, now: number): Promise<Routine> {
  z.uuid().parse(id);
  const input = RoutineUpdateSchema.parse(value);
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new StoreError('Invalid routine clock');
  return scoped(db, owner, async (tx) => {
    // Account before routine matches disconnect's parent-before-cascade lock order.
    await tx.query(`select g.id from bob.google_accounts g where g.id=$2 or g.id=(select google_account_id from bob.routines where id=$1) order by g.id for share of g`, [id, input.googleAccountId ?? null]);
    const current = await currentRoutine(tx, id, input.expectedRevision);
    const localTime = input.localTime ?? current.localTime;
    const timeZone = input.timeZone ?? current.timeZone;
    const status = input.status ?? current.status;
    const googleAccountId = input.googleAccountId ?? current.googleAccountId;
    if (status === 'active' || input.googleAccountId) await requireAccount(tx, googleAccountId);
    const weekdays = input.weekdays ?? current.weekdays;
    const next = status !== 'active' ? null : new Date(nextRoutineRun({ localTime, timeZone, weekdays }, now));
    return requiredRow(await tx.query<Row>(
      `update bob.routines set local_time=$2,time_zone=$3,status=$4,next_run_at=$5,
       revision=revision+1,updated_at=$6,name=$8,instructions=$9,gmail_query=$10,summary_style=$11,weekdays=$12,google_account_id=$13,
       email_result=$14,last_coverage_end=case when google_account_id<>$13 then null else last_coverage_end end where id=$1 and revision=$7 returning ${COLUMNS}`,
      [id, localTime, timeZone, status, next, new Date(now), input.expectedRevision, input.name ?? current.name, input.instructions ?? current.instructions, input.gmailQuery ?? current.gmailQuery, input.summaryStyle ?? current.summaryStyle, weekdays, googleAccountId, resolveEmailResult(input.emailResult, current)],
    ));
  });
}

export async function deleteRoutine(db: Db, owner: string, id: string, value: z.infer<typeof RoutineDeleteSchema>): Promise<void> {
  z.uuid().parse(id);
  const input = RoutineDeleteSchema.parse(value);
  await scoped(db, owner, async (tx) => {
    await currentRoutine(tx, id, input.expectedRevision);
    await tx.query("update bob.routines set status='archived',next_run_at=null,revision=revision+1,updated_at=now() where id=$1 and revision=$2", [id, input.expectedRevision]);
  });
}
