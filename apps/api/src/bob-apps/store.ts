import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { StoreConflictError, StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { BobAppActionSchema, BobAppCreateSchema, BobAppDeleteSchema, BobAppMutationSchema, BobAppSchema, BobAppsQuerySchema, BobAppSummarySchema } from './api-schemas.ts';
import { applyRecordAction, calculateMetrics } from './records.ts';
import { pauseMarketingForApp } from './marketing-install.ts';
import { lockPersonalAppOwner, requireAppAccess, requireAppSpace, type AppAudience, type AppPermission } from './app-access.ts';

type App = z.infer<typeof BobAppSchema>;
type Row = { id: string; installation_id: string; space_id: string | null; can_manage: boolean; lifecycle: App['lifecycle']; revision: number; definition: App['definition']; state: App['state']; pending_definition: App['definition'] | null; undo_definition: App['definition'] | null; created_at: Date; updated_at: Date };
const AUDIENCE_COLUMNS = 'i.id as installation_id,a.space_id,(a.space_id is null or bob_private.is_space_owner_or_admin(a.space_id)) as can_manage';
function validateData(definition: App['definition'], state: App['state']): void {
  if (Buffer.byteLength(JSON.stringify(definition), 'utf8') > 150000) throw new StoreError('app_definition_full');
  try { calculateMetrics(definition, state); }
  catch { throw new StoreError('app_records_incompatible'); }
}
function map(row: Row): App {
  return BobAppSchema.parse({ id: row.id, installationId: row.installation_id, spaceId: row.space_id, canManage: row.can_manage, lifecycle: row.lifecycle, revision: row.revision, definition: row.definition, state: row.state,
    metrics: calculateMetrics(row.definition, row.state), pendingDefinition: row.pending_definition, canUndo: row.undo_definition !== null,
    createdAt: new Date(row.created_at).getTime(), updatedAt: new Date(row.updated_at).getTime() });
}
async function current(tx: Db, id: string, lock = false): Promise<Row> {
  const [row] = await tx.query<Row>(`select a.*,${AUDIENCE_COLUMNS} from bob.bob_apps a join bob.bob_app_installations i on i.app_id=a.id where a.id=$1 ${lock ? 'for update of a' : ''}`, [id]);
  if (!row) throw new StoreNotFoundError('app_not_found');
  return row;
}
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
async function replay(tx: Db, actor: string, mutationId: string, hash: string, spaceId: string | null, appId: string | null = null): Promise<string | null> {
  const [receipt] = await tx.query<{ app_id: string; fingerprint: string }>(`select app_id,fingerprint from bob.bob_app_mutations
    where user_id=$1 and mutation_id=$2 and space_id is not distinct from $3::uuid and ($4::uuid is null or target_app_id=$4 or fingerprint=$5)`, [actor, mutationId, spaceId, appId, hash]);
  if (!receipt) return null;
  if (receipt.fingerprint !== hash) throw new StoreConflictError('app_mutation_conflict');
  return receipt.app_id;
}
async function receipt(tx: Db, owner: string, mutationId: string, hash: string, audience: AppAudience, resultId = audience.appId): Promise<void> {
  await tx.query('insert into bob.bob_app_mutations(user_id,mutation_id,fingerprint,app_id,installation_id,space_id,target_app_id) values($1,$2,$3,$4,$5,$6,$7)', [owner, mutationId, hash, resultId, audience.installationId, audience.spaceId, audience.appId]);
  await tx.query(`delete from bob.bob_app_mutations where user_id=$1 and (installation_id,mutation_id) in
    (select installation_id,mutation_id from bob.bob_app_mutations where user_id=$1 order by created_at desc,mutation_id desc offset 1000)`, [owner]);
}
async function insert(tx: Db, owner: string, definition: App['definition'], state: App['state'], spaceId: string | null): Promise<App> {
  validateData(definition, state);
  const [quota] = await tx.query<{ count: number }>('select count(*)::int as count from bob.bob_apps where space_id is not distinct from $1::uuid', [spaceId]);
  if ((quota?.count ?? 0) >= 30) throw new StoreError('app_quota_reached');
  const id = randomUUID();
  await tx.query('insert into bob.bob_apps(id,user_id,definition,state,space_id,created_by) values($1,$2,$3::text::jsonb,$4::text::jsonb,$5,$6)', [id, spaceId === null ? owner : null, JSON.stringify(definition), JSON.stringify(state), spaceId, owner]);
  await tx.query('select bob_private.ensure_bob_app_installation($1)', [id]);
  return map(await current(tx, id));
}
export async function listBobApps(db: Db, owner: string, options: { limit?: number; cursor?: string; spaceId?: string | null } = {}): Promise<z.infer<typeof BobAppSummarySchema>[]> {
  const query = BobAppsQuerySchema.parse(options);
  return withUser(db, owner, async (tx) => {
    if (query.spaceId) await requireAppSpace(tx, query.spaceId, 'read', false);
    const rows = await tx.query<Row & { title: string }>(
      `select a.*,a.definition->>'title' as title,${AUDIENCE_COLUMNS} from bob.bob_apps a join bob.bob_app_installations i on i.app_id=a.id
       where ($1::uuid is null or a.id>$1::uuid) and a.space_id is not distinct from $3::uuid order by a.id limit $2`, [query.cursor ?? null, query.limit, query.spaceId ?? null]);
    return rows.map((row) => BobAppSummarySchema.parse({ id: row.id, installationId: row.installation_id, spaceId: row.space_id, canManage: row.can_manage, title: row.title, lifecycle: row.lifecycle, revision: row.revision,
      createdAt: new Date(row.created_at).getTime(), updatedAt: new Date(row.updated_at).getTime() }));
  });
}
export async function getBobApp(db: Db, owner: string, id: string): Promise<App> {
  return withUser(db, owner, async (tx) => map(await current(tx, id)));
}
export async function createBobApp(db: Db, owner: string, value: unknown): Promise<App> {
  const input = BobAppCreateSchema.parse(value); const hash = fingerprint(input);
  return withUser(db, owner, async (tx) => {
    const spaceId = input.spaceId ?? null;
    if (spaceId === null) await lockPersonalAppOwner(tx, owner);
    else await requireAppSpace(tx, spaceId, 'write', true);
    const previous = await replay(tx, owner, input.mutationId, hash, spaceId);
    if (previous) return map(await current(tx, previous));
    const app = await insert(tx, owner, input.definition, input.state ?? {}, spaceId);
    await receipt(tx, owner, input.mutationId, hash, await requireAppAccess(tx, owner, app.id, 'read', false));
    return app;
  });
}
function checkRevision(row: Row, revision: number): void {
  if (row.revision !== revision) throw new StoreConflictError('app_revision_conflict');
}
async function save(tx: Db, row: Row): Promise<App> {
  validateData(row.definition, row.state);
  await tx.query(`update bob.bob_apps set lifecycle=$2,definition=$3::text::jsonb,state=$4::text::jsonb,pending_definition=$5::text::jsonb,
    undo_definition=$6::text::jsonb,revision=revision+1,updated_at=now() where id=$1`,
  [row.id, row.lifecycle, JSON.stringify(row.definition), JSON.stringify(row.state), row.pending_definition === null ? null : JSON.stringify(row.pending_definition), row.undo_definition === null ? null : JSON.stringify(row.undo_definition)]);
  return map(await current(tx, row.id));
}
function edit(row: Row, input: z.infer<typeof BobAppMutationSchema>): void {
  if (input.operation === 'archive') { row.lifecycle = 'archived'; return; }
  if (input.operation === 'restore') { row.lifecycle = 'draft'; return; }
  if (row.lifecycle === 'archived') throw new StoreError('app_archived');
  if (input.operation === 'pause') { if (row.lifecycle !== 'active') throw new StoreError('app_not_active'); row.lifecycle = 'paused'; return; }
  if (input.operation === 'resume') { if (row.lifecycle !== 'paused') throw new StoreError('app_not_paused'); row.lifecycle = 'active'; return; }
  if (input.operation === 'activate') { row.lifecycle = 'active'; return; }
  if (input.operation === 'revise') { validateData(input.definition, row.state); row.pending_definition = input.definition; return; }
  const target = input.operation === 'undo' ? row.undo_definition : row.pending_definition;
  if (!target) throw new StoreError('app_revision_missing');
  validateData(target, row.state);
  row.undo_definition = row.definition; row.definition = target; row.pending_definition = null;
}
export async function mutateBobApp(db: Db, owner: string, id: string, value: unknown): Promise<App> {
  const input = BobAppMutationSchema.parse(value); const hash = fingerprint({ id, input });
  return withUser(db, owner, async (tx) => {
    const permission: AppPermission = ['revise', 'duplicate'].includes(input.operation) ? 'write' : 'manage';
    const audience = await requireAppAccess(tx, owner, id, permission, true);
    if (audience.kind === 'package' && ['pause', 'resume'].includes(input.operation)) throw new StoreError('use_package_controls');
    const previous = await replay(tx, owner, input.mutationId, hash, audience.spaceId, id);
    if (previous) return map(await current(tx, previous));
    const row = await current(tx, id, true); checkRevision(row, input.expectedRevision);
    const app = input.operation === 'duplicate'
      ? await insert(tx, owner, row.definition, row.state, audience.spaceId)
      : await applyMutation(tx, row, input, audience, permission);
    await receipt(tx, owner, input.mutationId, hash, audience, app.id);
    return app;
  });
}
async function applyMutation(tx: Db, row: Row, input: z.infer<typeof BobAppMutationSchema>, audience: AppAudience, permission: AppPermission): Promise<App> {
  edit(row, input);
  const app = await save(tx, row);
  if (['pause', 'archive', 'restore', 'apply_revision', 'undo'].includes(input.operation)) {
    await tx.query('update bob.bob_app_refresh_settings set enabled=false,next_run_at=null,revision=revision+1 where app_id=$1', [row.id]);
    await tx.query("update bob.bob_app_runs set status='skipped',failure_code='stale',completed_at=now() where app_id=$1 and status='pending'", [row.id]);
    if (input.operation === 'archive' || input.operation === 'restore') await pauseMarketingForApp(tx, row.id);
  }
  if (audience.kind === 'generic' && permission === 'manage') {
    await tx.query('update bob.bob_app_installations set state=$2,revision=revision+1,updated_at=now() where id=$1', [audience.installationId, row.lifecycle === 'archived' ? 'inactive' : row.lifecycle]);
  }
  return app;
}
export async function runBobAppAction(db: Db, owner: string, id: string, value: unknown): Promise<App> {
  const input = BobAppActionSchema.parse(value); const hash = fingerprint({ id, input });
  return withUser(db, owner, async (tx) => {
    const audience = await requireAppAccess(tx, owner, id, 'write', true);
    const previous = await replay(tx, owner, input.mutationId, hash, audience.spaceId, id);
    if (previous) return map(await current(tx, previous));
    const row = await current(tx, id, true); checkRevision(row, input.expectedRevision);
    if (row.lifecycle !== 'active') throw new StoreError('app_not_active');
    const table = row.definition.actions.find((action) => action.id === input.command.action)?.table;
    const bound = await tx.query('select app_id from bob.bob_app_refresh_settings where app_id=$1 and target_table=$2 and enabled', [id, table]);
    if (bound.length) throw new StoreError('app_table_automatically_updated');
    try { row.state = applyRecordAction(row.definition, row.state, input.command); }
    catch { throw new StoreError('app_record_change_invalid'); }
    const app = await save(tx, row); await receipt(tx, owner, input.mutationId, hash, audience); return app;
  });
}
export async function deleteBobApp(db: Db, owner: string, id: string, value: unknown): Promise<void> {
  const input = BobAppDeleteSchema.parse(value); const hash = fingerprint({ id, delete: input });
  await withUser(db, owner, async (tx) => {
    const audience = (await tx.query('select id from bob.bob_apps where id=$1', [id])).length
      ? await requireAppAccess(tx, owner, id, 'manage', true) : await deletedAudience(tx, owner, id, input.mutationId);
    if (await replay(tx, owner, input.mutationId, hash, audience.spaceId, id)) return;
    checkRevision(await current(tx, id, true), input.expectedRevision);
    await tx.query('delete from bob.bob_apps where id=$1', [id]);
    await receipt(tx, owner, input.mutationId, hash, audience);
  });
}

async function deletedAudience(tx: Db, owner: string, id: string, mutationId: string): Promise<AppAudience> {
  const [row] = await tx.query<{ space_id: string | null; installation_id: string }>('select space_id,installation_id from bob.bob_app_mutations where user_id=$1 and app_id=$2 and mutation_id=$3', [owner, id, mutationId]);
  if (!row) throw new StoreNotFoundError('app_not_found');
  if (row.space_id === null) await lockPersonalAppOwner(tx, owner);
  else await requireAppSpace(tx, row.space_id, 'manage', true);
  return { appId: id, installationId: row.installation_id, spaceId: row.space_id, kind: 'generic', canManage: true };
}
