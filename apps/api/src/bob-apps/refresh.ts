import { asServer, withUser, type Db } from '../platform/db/db.ts';
import { requireSpaceMember } from '../spaces/store.ts';
import { assertToolEnabled } from '../tools/policy.ts';
import { nextRoutineRun } from '../routines/schedule.ts';
import { BobAppRefreshConfigSchema } from './refresh-schemas.ts';
import { BobAppDefinitionSchema, RecordStateSchema } from './schemas.ts';
import { calculateMetrics } from './records.ts';
import { checkRefreshTable } from './refresh-store.ts';

type Run = { id: string; app_id: string; app_revision: number; config_revision: number; status: string };
type App = { revision: number; lifecycle: string; definition: unknown; state: unknown };
type Settings = { revision: number; enabled: boolean; config: unknown };
export async function dispatchBobAppRefreshes(db: Db, now: number): Promise<number> {
 const due = await asServer(db, (tx) => tx.query<{ app_id: string; revision: number; config: unknown }>('select * from bob_private.bob_apps_due($1)', [new Date(now)]));
 let count = 0;
 for (const item of due) {
  const parsed = BobAppRefreshConfigSchema.safeParse(item.config);
  if (!parsed.success) {
   await asServer(db, (tx) => tx.query('select bob_private.bob_app_disable_invalid($1,$2)', [item.app_id,item.revision]));
   continue;
  }
  const config = parsed.data;
  const next = nextRoutineRun(config.schedule, now);
  const [result] = await asServer(db, (tx) => tx.query<{id:string|null}>('select bob_private.bob_app_dispatch($1,$2,$3,$4) as id',[item.app_id,item.revision,new Date(next),new Date(now)]));
  if (result?.id) count++;
 }
 return count;
}
async function finish(tx: Db, run: Run, status: 'failed'|'skipped'|'completed', code: string|null, now: number): Promise<void> {
 await tx.query('update bob.bob_app_runs set status=$2,failure_code=$3,completed_at=$4 where id=$1',[run.id,status,code,new Date(now)]);
 if (status === 'failed') await tx.query('update bob.bob_app_refresh_settings set enabled=false,next_run_at=null,last_error=$2 where app_id=$1',[run.app_id,code]);
}
type TaskRow = {id:string;title:string;status:string};
function refreshedState(app: App, config: ReturnType<typeof BobAppRefreshConfigSchema.parse>, tasks: TaskRow[]): string | null {
 try {
  checkRefreshTable(app.definition, config);
  if (tasks.length > 500) return null;
  const state = RecordStateSchema.parse(app.state);
  state[config.targetTable] = tasks.map((task) => ({ id: 't_' + task.id.replaceAll('-','_'), values: {title:task.title, completed:task.status === 'completed'} }));
  calculateMetrics(BobAppDefinitionSchema.parse(app.definition), state);
  const encoded = JSON.stringify(state);
  return Buffer.byteLength(encoded) <= 1000000 ? encoded : null;
 } catch { return null; }
}
async function authorized(tx: Db, owner: string, spaceId: string): Promise<boolean> {
 try {
  await requireSpaceMember(tx, spaceId, owner);
  await assertToolEnabled(tx, owner, 'list_tasks', { spaceId });
  return true;
 } catch { return false; }
}
async function publish(tx: Db, owner: string, run: Run, app: App, settings: Settings, signal: AbortSignal, now: number): Promise<void> {
 const parsed = BobAppRefreshConfigSchema.safeParse(settings.config);
 if (!parsed.success) { await finish(tx,run,'failed','source_unavailable',now); return; }
 const config = parsed.data;
 if (!await authorized(tx, owner, config.spaceId)) { await finish(tx,run,'failed','permission_unavailable',now); return; }
 const tasks = await tx.query<TaskRow>('select id,title,status from bob.tasks where space_id=$1 and trashed_at is null order by id limit 501',[config.spaceId]);
 const encoded = refreshedState(app,config,tasks);
 if (encoded === null) { await finish(tx,run,'failed','source_unavailable',now); return; }
 signal.throwIfAborted();
 if (!await authorized(tx, owner, config.spaceId)) { await finish(tx,run,'failed','permission_unavailable',now); return; }
 await tx.query('update bob.bob_apps set state=$2::text::jsonb,revision=revision+1,updated_at=$3 where id=$1',[run.app_id,encoded,new Date(now)]);
 await tx.query('update bob.bob_app_refresh_settings set last_refresh_at=$2,last_error=null where app_id=$1',[run.app_id,new Date(now)]);
 await finish(tx,run,'completed',null,now);
}
/** Uses the existing queue. A single DB transaction provides retry-safe execution;
 * no external call occurs while the publication fence is held. */
export async function tryHandleBobAppRun(db: Db, id: string, signal: AbortSignal, now = Date.now()): Promise<boolean> {
 const [anchor] = await asServer(db, (tx) => tx.query<{user_id:string;app_id:string}>('select * from bob_private.bob_app_run_owner($1)',[id]));
 if (!anchor) return false;
 signal.throwIfAborted();
 await withUser(db,anchor.user_id,async (tx) => {
  const [app] = await tx.query<App>('select * from bob.bob_apps where id=$1 for update',[anchor.app_id]);
  const [settings] = await tx.query<Settings>('select * from bob.bob_app_refresh_settings where app_id=$1 for update',[anchor.app_id]);
  const [run] = await tx.query<Run>('select * from bob.bob_app_runs where id=$1 for update',[id]);
  if (!run || run.status !== 'pending') return;
  if (!app || !settings || !settings.enabled || app.lifecycle !== 'active' || app.revision !== run.app_revision || settings.revision !== run.config_revision) { await finish(tx,run,'skipped','stale',now); return; }
  await publish(tx,anchor.user_id,run,app,settings,signal,now);
 });
 return true;
}
