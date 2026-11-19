import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StoreConflictError, StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { requireAppAccess, requireAppSpace, type AppPermission } from './app-access.ts';
import { BobAppDefinitionSchema } from './schemas.ts';
import { DEFAULT_MARKETING_CONFIG, MARKETING_GRANTS, MARKETING_PACKAGE_ID, MarketingConfigSchema, MarketingInstallSchema, MarketingInstallationSchema, MarketingLifecycleSchema, MarketingSelectionSchema } from './marketing-schemas.ts';
import { MARKETING_BASELINE_GRANTS, MARKETING_PACKAGE_VERSION, MARKETING_WORKSPACE_DEFINITION, marketingPackage } from './marketing-registry.ts';

// Installation writes recheck the current audience. Personal writes retain the owner fence; shared lifecycle
// writes take the audience before app locks. Session admission is checked again inside the write transaction.
//
// Replay is deduplication: a repeated key returns the CURRENT installation or selection, not the exact original
// result. Exact stored results belong to U3 and stay in separate records. Keys live until account erasure (not app
// deletion) and are capped per owner. At capacity, new install, activate, resume and selection writes are refused
// with an explicit limit error, and no key is ever deleted. Pause still lands without a new key so a revocation is
// never blocked, and it still enforces expectedRevision.
type Installation = z.infer<typeof MarketingInstallationSchema>;
type Selection = { installationId: string; expiresAt: number };
type Capability = (typeof MARKETING_GRANTS)[number];
type Row = {
  id: string; app_id: string; space_id: string | null; can_manage: boolean; package_id: string; state: Installation['state']; granted_capabilities: string[]; revision: number;
  config_revision: number; config: unknown; package_version: string; created_at: Date; updated_at: Date;
};
const COLUMNS = 'id,app_id,space_id,(space_id is null or bob_private.is_space_owner_or_admin(space_id)) as can_manage,package_id,state,granted_capabilities,revision,config_revision,config,package_version,created_at,updated_at';
const OPERATION_LIMIT = 10000;
/** The registry baseline grant every selection and active lookup requires (see MARKETING_BASELINE_GRANTS). */
const READ_GRANT = ['campaign.read'] as const;

/** The package is read from the row, never assumed: a row for another package must not render as Marketing. */
function map(row: Row): Installation {
  return MarketingInstallationSchema.parse({
    id: row.id, appId: row.app_id, spaceId: row.space_id, canManage: row.can_manage, state: row.state, grantedCapabilities: row.granted_capabilities,
    revision: row.revision, configRevision: row.config_revision, config: MarketingConfigSchema.parse(row.config),
    package: { packageId: row.package_id, name: marketingPackage().name, version: row.package_version },
    createdAt: new Date(row.created_at).getTime(), updatedAt: new Date(row.updated_at).getTime(),
  });
}
async function ownerLock(tx: Db, owner: string): Promise<void> {
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 1225))', [owner]);
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** Postgres text[] literal for the grant list: values are fixed identifiers, never user input. */
const pgArray = (values: readonly string[]): string => `{${values.join(',')}}`;

/** Looks up a key. Callers check the session first, so a reused key with a different intent conflicts only for an authorized caller. */
async function receiptOf(tx: Db, owner: string, mutationId: string, hash: string): Promise<{ installationId: string | null } | null> {
  const [receipt] = await tx.query<{ fingerprint: string; installation_id: string | null }>(
    'select fingerprint,installation_id from bob.bob_app_marketing_operations where user_id=$1 and mutation_id=$2', [owner, mutationId]);
  if (!receipt) return null;
  if (receipt.fingerprint !== hash) throw new StoreConflictError('marketing_mutation_conflict');
  return { installationId: receipt.installation_id };
}
async function atCapacity(tx: Db, owner: string): Promise<boolean> {
  const [count] = await tx.query<{ count: number }>('select count(*)::int as count from bob.bob_app_marketing_operations where user_id=$1', [owner]);
  return (count?.count ?? 0) >= OPERATION_LIMIT;
}
/** Stores the key and its result only. The caller has checked capacity. No intent, content or campaign data is kept. */
async function record(tx: Db, owner: string, mutationId: string, hash: string, installationId: string | null): Promise<void> {
  await tx.query('insert into bob.bob_app_marketing_operations(user_id,mutation_id,fingerprint,installation_id) values($1,$2,$3,$4)',
    [owner, mutationId, hash, installationId]);
}
/** The caller's own session, through the reviewed wrapper: no direct auth schema access and no session from the body. */
export async function requireMarketingSession(tx: Db, sessionId: string): Promise<void> {
  const [row] = await tx.query<{ active: boolean }>('select bob_private.marketing_session_active($1::uuid) as active', [sessionId]);
  if (row?.active !== true) throw new StoreError('marketing_session_inactive');
}
/** Not found for a missing id, another owner's id (row-level security hides it) or another package. Unsupported version is unavailable. */
async function loadInstallation(tx: Db, id: string | null): Promise<Installation> {
  const [row] = id === null ? [] : await tx.query<Row>(`select ${COLUMNS} from bob.bob_app_installations where id=$1`, [id]);
  if (!row || row.package_id !== MARKETING_PACKAGE_ID) throw new StoreNotFoundError('marketing_installation_not_found');
  if (row.package_version !== MARKETING_PACKAGE_VERSION) throw new StoreError('marketing_package_unavailable');
  return map(row);
}
/** Live means the installation is active AND its app is active, read in the same transaction. */
async function isLive(tx: Db, installation: Installation, allowPaused = false): Promise<boolean> {
  const [app] = await tx.query<{ lifecycle: string }>('select lifecycle from bob.bob_apps where id=$1', [installation.appId]);
  return (installation.state === 'active' || (allowPaused && installation.state === 'paused')) && app?.lifecycle === 'active';
}

/** Install is the only write that creates state from a session, so the session is checked under the lock before any replay or write. */
export async function installMarketingPackage(db: Db, owner: string, value: unknown, sessionId: string): Promise<Installation> {
  const input = MarketingInstallSchema.parse(value); const hash = fingerprint(input); const session = z.uuid().parse(sessionId);
  return withUser(db, owner, async (tx) => {
    if (input.spaceId) await requireAppSpace(tx, input.spaceId, 'manage', true);
    else await ownerLock(tx, owner);
    await requireMarketingSession(tx, session);
    const previous = await receiptOf(tx, owner, input.mutationId, hash);
    if (previous) return loadInstallation(tx, previous.installationId);
    if (await atCapacity(tx, owner)) throw new StoreError('marketing_operation_limit');
    const [existing] = await tx.query<{ id: string }>('select id from bob.bob_app_installations where package_id=$1 and space_id is not distinct from $2::uuid', [MARKETING_PACKAGE_ID, input.spaceId ?? null]);
    if (existing) throw new StoreConflictError('marketing_already_installed');
    const [quota] = await tx.query<{ count: number }>('select count(*)::int as count from bob.bob_apps where space_id is not distinct from $1::uuid', [input.spaceId ?? null]);
    if ((quota?.count ?? 0) >= 30) throw new StoreError('app_quota_reached');
    const definition = BobAppDefinitionSchema.parse(MARKETING_WORKSPACE_DEFINITION);
    const [app] = await tx.query<{ id: string }>('insert into bob.bob_apps(user_id,definition,state,space_id) values($1,$2::text::jsonb,$3::text::jsonb,$4) returning id',
      [input.spaceId ? null : owner, JSON.stringify(definition), '{}', input.spaceId ?? null]);
    const [row] = await tx.query<{ id: string }>(
      'insert into bob.bob_app_installations(user_id,app_id,package_id,package_version,granted_capabilities,config) values($1,$2,$3,$4,$5::text[],$6::text::jsonb) returning id',
      [input.spaceId ? null : owner, app?.id, MARKETING_PACKAGE_ID, MARKETING_PACKAGE_VERSION, pgArray(MARKETING_BASELINE_GRANTS), JSON.stringify(DEFAULT_MARKETING_CONFIG)]);
    const installation = await loadInstallation(tx, row?.id ?? null);
    await record(tx, owner, input.mutationId, hash, installation.id);
    return installation;
  });
}
export async function listMarketingInstallations(db: Db, owner: string, options: { spaceId?: string | null } = {}): Promise<Installation[]> {
  return withUser(db, owner, async (tx) => {
    if (options.spaceId) await requireAppSpace(tx, options.spaceId, 'read', false);
    return (await tx.query<Row>(
    `select ${COLUMNS} from bob.bob_app_installations where package_id=$1 and package_version=$2 and space_id is not distinct from $3::uuid order by created_at,id limit 30`,
    [MARKETING_PACKAGE_ID, MARKETING_PACKAGE_VERSION, options.spaceId ?? null])).map(map);
  });
}
export async function getMarketingInstallation(db: Db, owner: string, id: string): Promise<Installation> {
  return withUser(db, owner, (tx) => loadInstallation(tx, id));
}
function nextState(state: Installation['state'], operation: 'activate' | 'pause' | 'resume'): 'active' | 'paused' {
  if (operation === 'pause' && state === 'active') return 'paused';
  if ((operation === 'activate' && state === 'draft') || (operation === 'resume' && state === 'paused')) return 'active';
  throw new StoreError('marketing_transition_invalid');
}
/** Writes one lifecycle transition: the app and the installation move together on activate and resume; pause leaves the app. */
async function transition(tx: Db, installation: Installation, next: 'active' | 'paused'): Promise<void> {
  const [app] = await tx.query<{ lifecycle: string }>('select lifecycle from bob.bob_apps where id=$1', [installation.appId]);
  if (next === 'active' && app?.lifecycle === 'archived') throw new StoreError('marketing_app_archived');
  if (next === 'active' && app?.lifecycle !== 'active') {
    await tx.query("update bob.bob_apps set lifecycle='active',revision=revision+1,updated_at=now() where id=$1", [installation.appId]);
  }
  if (next === 'paused') await tx.query('delete from bob.bob_app_selection where installation_id=$1', [installation.id]);
  await tx.query('update bob.bob_app_installations set state=$2,revision=revision+1,updated_at=now() where id=$1', [installation.id, next]);
}
export async function changeMarketingLifecycle(db: Db, owner: string, id: string, value: unknown): Promise<Installation> {
  const input = MarketingLifecycleSchema.parse(value); const hash = fingerprint({ id, input });
  return withUser(db, owner, async (tx) => {
    await lockMarketingInstallation(tx, owner, id, 'manage');
    const previous = await receiptOf(tx, owner, input.mutationId, hash);
    if (previous) return loadInstallation(tx, previous.installationId);
    const installation = await loadInstallation(tx, id);
    // The revision is enforced before the already-paused case, so a stale pause never lands against a later resume.
    if (installation.revision !== input.expectedRevision) throw new StoreConflictError('marketing_revision_conflict');
    const full = await atCapacity(tx, owner);
    if (full && input.operation !== 'pause') throw new StoreError('marketing_operation_limit');
    if (installation.state === 'paused' && input.operation === 'pause') {
      if (!full) await record(tx, owner, input.mutationId, hash, id);
      return installation;
    }
    await transition(tx, installation, nextState(installation.state, input.operation));
    if (!full) await record(tx, owner, input.mutationId, hash, id);
    return loadInstallation(tx, id);
  });
}
/** A selection is current only while it is unexpired, its installation is active on a live app, the package and version are supported, and the stored grant includes the registry baseline campaign.read. */
async function currentSelection(tx: Db): Promise<Selection | null> {
  const [row] = await tx.query<{ installation_id: string; expires_at: Date }>(`select s.installation_id,s.expires_at from bob.bob_app_selection s
    join bob.bob_app_installations i on i.id=s.installation_id join bob.bob_apps a on a.id=i.app_id
    where s.expires_at>now() and i.state='active' and a.lifecycle='active'
      and i.package_id=$1 and i.package_version=$2 and i.granted_capabilities @> $3::text[]`,
  [MARKETING_PACKAGE_ID, MARKETING_PACKAGE_VERSION, pgArray(READ_GRANT)]);
  return row ? { installationId: row.installation_id, expiresAt: new Date(row.expires_at).getTime() } : null;
}
/** Every selection write, the clear included, checks the caller's session under the lock first: a queued clear behind an erasure writes nothing. */
export async function selectMarketingInstallation(db: Db, owner: string, value: unknown, sessionId: string): Promise<Selection | null> {
  const input = MarketingSelectionSchema.parse(value); const hash = fingerprint(input); const session = z.uuid().parse(sessionId);
  return withUser(db, owner, async (tx) => {
    await ownerLock(tx, owner);
    await requireMarketingSession(tx, session);
    if (input.installationId) await lockMarketingInstallation(tx, owner, input.installationId, 'read');
    if (await receiptOf(tx, owner, input.mutationId, hash)) return currentSelection(tx);
    if (await atCapacity(tx, owner)) throw new StoreError('marketing_operation_limit');
    if (input.installationId === null) {
      await tx.query('delete from bob.bob_app_selection where user_id=$1', [owner]);
      await record(tx, owner, input.mutationId, hash, null);
      return null;
    }
    await requireMarketingInstallation(tx, input.installationId, 'campaign.read');
    await tx.query(`insert into bob.bob_app_selection(user_id,installation_id,expires_at) values($1,$2,now()+interval '1 hour')
      on conflict (user_id) do update set installation_id=excluded.installation_id,expires_at=excluded.expires_at`, [owner, input.installationId]);
    await record(tx, owner, input.mutationId, hash, input.installationId);
    return currentSelection(tx);
  });
}
/**
 * Re-checks one installation inside a transaction that already holds its audience/owner lock. Every mutation calls this under the
 * lock, so a read taken outside the lock is never trusted for a write. A missing or other-owner id is not_found. An
 * inactive installation or app, an unsupported package and a missing stored grant are typed errors. The effective grant
 * is the stored grant intersected with the registry baseline, and it is only checked when a capability is required.
 * allowPaused is for the owner's own campaign pointer only: it stores no content and runs no agent.
 */
export async function requireMarketingInstallation(tx: Db, installationId: string, requiredCapability?: Capability, allowPaused = false): Promise<Installation> {
  const installation = await loadInstallation(tx, installationId);
  if (!(await isLive(tx, installation, allowPaused))) throw new StoreConflictError('marketing_not_active');
  const effective = installation.grantedCapabilities.filter((grant) => (MARKETING_BASELINE_GRANTS as readonly string[]).includes(grant));
  if (requiredCapability !== undefined && !effective.includes(requiredCapability)) throw new StoreConflictError('marketing_permission_denied');
  return installation;
}
/**
 * Live installation for an owner's id: cross-owner ids are not_found and unsupported versions are unavailable. An inactive
 * installation or app, or a stored grant missing the baseline campaign.read, is null. The owner read (get) still shows the stored
 * grants, so the UI can explain a revocation; this lookup is the guard that stays fresh.
 */
export async function resolveActiveMarketingInstallation(db: Db, owner: string, id: string): Promise<Installation | null> {
  return withUser(db, owner, async (tx) => {
    const installation = await loadInstallation(tx, id);
    const readable = installation.grantedCapabilities.includes(READ_GRANT[0]);
    return readable && (await isLive(tx, installation)) ? installation : null;
  });
}
/** The owner's own installation is paused and its app can resume. A foreign or missing id throws not found, like every other read. */
export async function isMarketingPaused(db: Db, owner: string, id: string): Promise<boolean> {
  return withUser(db, owner, async (tx) => {
    const installation = await loadInstallation(tx, id);
    const [app] = await tx.query<{ lifecycle: string }>('select lifecycle from bob.bob_apps where id=$1', [installation.appId]);
    return installation.state === 'paused' && app?.lifecycle === 'active';
  });
}
export async function readSelectedMarketingInstallationId(db: Db, owner: string): Promise<string | null> {
  return withUser(db, owner, async (tx) => (await currentSelection(tx))?.installationId ?? null);
}
/** Called inside the generic archive and restore transaction: pauses (never resumes) and drops the selection. */
export async function pauseMarketingForApp(tx: Db, appId: string): Promise<void> {
  await tx.query('delete from bob.bob_app_selection where installation_id in (select id from bob.bob_app_installations where app_id=$1)', [appId]);
  await tx.query("update bob.bob_app_installations set state='paused',revision=revision+1,updated_at=now() where app_id=$1 and state='active'", [appId]);
}

/** Audience lock precedes installation/content locks; personal paths retain their owner fence. */
export async function lockMarketingInstallation(tx: Db, actor: string, id: string, permission: AppPermission): Promise<Installation> {
  const installation = await loadInstallation(tx, id);
  await requireAppAccess(tx, actor, installation.appId, permission, true);
  return loadInstallation(tx, id);
}
