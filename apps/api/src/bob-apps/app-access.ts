import { StoreError, StoreNotFoundError, type Db } from '../platform/db/db.ts';

export type AppPermission = 'read' | 'write' | 'manage';
export interface AppAudience {
  appId: string;
  installationId: string;
  spaceId: string | null;
  kind: 'generic' | 'package';
  canManage: boolean;
}

/** Shared mutations take the audience before app/content locks, never the personal owner lock. */
export async function requireAppSpace(tx: Db, spaceId: string, permission: AppPermission, lock: boolean): Promise<boolean> {
  if (lock) {
    const [locked] = await tx.query<{ revision: number | null }>('select bob_private.lock_thread_audience_revision($1) as revision', [spaceId]);
    if (locked?.revision === null || locked?.revision === undefined) throw new StoreNotFoundError('app_not_found');
  }
  const [audience] = await tx.query<{ member: boolean; manager: boolean }>(
    'select bob_private.bob_app_space_member($1) as member,bob_private.is_space_owner_or_admin($1) as manager', [spaceId]);
  if (!audience?.member) throw new StoreNotFoundError('app_not_found');
  if (permission === 'manage' && !audience.manager) throw new StoreError('app_management_required');
  return audience.manager;
}

export async function lockPersonalAppOwner(tx: Db, actorId: string): Promise<void> {
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1,1225))', [actorId]);
}

/** RLS supplies audience visibility. Recheck it after any lock wait and before replay. */
export async function requireAppAccess(tx: Db, actorId: string, appId: string, permission: AppPermission, lock: boolean): Promise<AppAudience> {
  const [row] = await tx.query<{ space_id: string | null; installation_id: string; kind: AppAudience['kind'] }>(
    'select a.space_id,i.id as installation_id,i.kind from bob.bob_apps a join bob.bob_app_installations i on i.app_id=a.id where a.id=$1', [appId]);
  if (!row) throw new StoreNotFoundError('app_not_found');
  const canManage = row.space_id === null
    ? (lock ? await lockPersonalAppOwner(tx, actorId).then(() => true) : true)
    : await requireAppSpace(tx, row.space_id, permission, lock);
  if (lock && !(await tx.query('select id from bob.bob_apps where id=$1 for update', [appId])).length) throw new StoreNotFoundError('app_not_found');
  return { appId, installationId: row.installation_id, spaceId: row.space_id, kind: row.kind, canManage };
}
