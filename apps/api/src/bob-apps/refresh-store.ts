import { createHash } from 'node:crypto';
import { z } from 'zod';
import { withUser, StoreConflictError, StoreNotFoundError, StoreError, type Db } from '../platform/db/db.ts';
import { requireSpaceMember } from '../spaces/store.ts';
import { assertToolEnabled } from '../tools/policy.ts';
import { BobAppDefinitionSchema } from './schemas.ts';
import { BobAppRefreshConfigSchema, BobAppRefreshInputSchema, BobAppRefreshSchema, BobAppRunsSchema } from './refresh-schemas.ts';
import { requireAppAccess } from './app-access.ts';

type Settings = { enabled: boolean; config: unknown; next_run_at: Date | null; last_refresh_at: Date | null; last_error: string | null };
function response(row?: Settings): z.infer<typeof BobAppRefreshSchema> {
 return BobAppRefreshSchema.parse({ enabled: row?.enabled ?? false, config: row?.config ?? null, nextRunAt: row?.next_run_at ? new Date(row.next_run_at).getTime() : null, lastRefreshAt: row?.last_refresh_at ? new Date(row.last_refresh_at).getTime() : null, lastError: row?.last_error ?? null });
}
export async function getBobAppRefresh(db: Db, owner: string, id: string): Promise<z.infer<typeof BobAppRefreshSchema>> {
 return withUser(db, owner, async (tx) => {
  const audience = await requireAppAccess(tx, owner, id, 'read', false);
  if (audience.spaceId !== null) return response();
  return response((await tx.query<Settings>('select * from bob.bob_app_refresh_settings where app_id=$1', [id]))[0]);
 });
}
export function checkRefreshTable(definition: unknown, config: z.infer<typeof BobAppRefreshConfigSchema>): void {
 const app = BobAppDefinitionSchema.parse(definition); const table = app.tables.find((item) => item.id === config.targetTable);
 if (!table || table.fields.length !== 2 || !table.fields.some((f) => f.id === 'title' && f.type === 'text') || !table.fields.some((f) => f.id === 'completed' && f.type === 'boolean')) throw new StoreError('app_refresh_table_incompatible');
}
async function authorizeConfig(tx: Db, owner: string, app: { lifecycle: string; definition: unknown }, input: z.infer<typeof BobAppRefreshInputSchema>): Promise<void> {
 if (!input.enabled || !input.config) return;
 if (app.lifecycle !== 'active') throw new StoreError('app_not_active');
 checkRefreshTable(app.definition, input.config);
 await requireSpaceMember(tx, input.config.spaceId, owner);
 await assertToolEnabled(tx, owner, 'list_tasks', { spaceId: input.config.spaceId });
}
export async function configureBobAppRefresh(db: Db, owner: string, id: string, raw: unknown, now = Date.now()): Promise<z.infer<typeof BobAppRefreshSchema>> {
 const input = BobAppRefreshInputSchema.parse(raw); const hash = createHash('sha256').update(JSON.stringify({ refresh: id, input })).digest('hex');
 return withUser(db, owner, async (tx) => {
  const audience = await requireAppAccess(tx, owner, id, 'manage', true);
  if (audience.spaceId !== null) throw new StoreError('shared_app_refresh_unavailable');
  const [app] = await tx.query<{ revision: number; lifecycle: string; definition: unknown }>('select revision,lifecycle,definition from bob.bob_apps where id=$1 for update', [id]);
  if (!app) throw new StoreNotFoundError('app_not_found');
  const [receipt] = await tx.query<{ fingerprint: string }>('select fingerprint from bob.bob_app_mutations where user_id=$1 and installation_id=$2 and mutation_id=$3', [owner, audience.installationId, input.mutationId]);
  if (receipt) { if (receipt.fingerprint !== hash) throw new StoreConflictError('app_mutation_conflict'); return response((await tx.query<Settings>('select * from bob.bob_app_refresh_settings where app_id=$1',[id]))[0]); }
  if (app.revision !== input.expectedRevision) throw new StoreConflictError('app_revision_conflict');
  await authorizeConfig(tx,owner,app,input);
  await tx.query("update bob.bob_app_runs set status='skipped',failure_code='stale',completed_at=$2 where app_id=$1 and status='pending'", [id,new Date(now)]);
  const [row] = await tx.query<Settings>(`insert into bob.bob_app_refresh_settings(app_id,user_id,enabled,config,target_table,next_run_at) values($1,$2,$3,$4::text::jsonb,$5,$6)
   on conflict(app_id) do update set enabled=excluded.enabled,config=excluded.config,target_table=excluded.target_table,next_run_at=excluded.next_run_at,revision=bob_app_refresh_settings.revision+1,last_error=null returning *`, [id,owner,input.enabled,JSON.stringify(input.config),input.config?.targetTable ?? null,input.enabled ? new Date(now) : null]);
  await tx.query('insert into bob.bob_app_mutations(user_id,mutation_id,fingerprint,app_id,installation_id,target_app_id) values($1,$2,$3,$4,$5,$4)',[owner,input.mutationId,hash,id,audience.installationId]);
  await tx.query('update bob.bob_apps set revision=revision+1,updated_at=$2 where id=$1',[id,new Date(now)]);
  await tx.query('delete from bob.bob_app_mutations where user_id=$1 and (installation_id,mutation_id) in (select installation_id,mutation_id from bob.bob_app_mutations where user_id=$1 order by created_at desc,mutation_id desc offset 1000)',[owner]);
  return response(row);
 });
}
export async function listBobAppRuns(db: Db, owner: string, id: string): Promise<z.infer<typeof BobAppRunsSchema>> {
 return withUser(db, owner, async (tx) => {
  const audience = await requireAppAccess(tx, owner, id, 'read', false);
  if (audience.spaceId !== null) return BobAppRunsSchema.parse({ runs: [] });
  const rows = await tx.query<{id:string;status:string;scheduled_at:Date;completed_at:Date|null;failure_code:string|null}>('select * from bob.bob_app_runs where app_id=$1 order by scheduled_at desc,id limit 20',[id]);
  return BobAppRunsSchema.parse({ runs: rows.map((r) => ({id:r.id,status:r.status,scheduledAt:new Date(r.scheduled_at).getTime(),completedAt:r.completed_at ? new Date(r.completed_at).getTime() : null,failureCode:r.failure_code})) });
 });
}
