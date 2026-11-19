import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StoreConflictError, StoreError, StoreNotFoundError, withUser, type Db } from '../platform/db/db.ts';
import { assertToolEnabled } from '../tools/policy.ts';
import { lockMarketingInstallation, requireMarketingInstallation } from './marketing-install.ts';
import { marketingConversationSpace } from './marketing-store.ts';
import { MARKETING_CONFIG_TOOL_GRANTS, MARKETING_PACKAGE_VERSION } from './marketing-registry.ts';
import {
  MARKETING_CONFIG_DEPENDENCIES, MARKETING_CONFIG_EXTENSION_KEYS, MarketingConfigApplyRequestSchema, MarketingConfigDetailResponseSchema,
  MarketingConfigDiscardRequestSchema, MarketingConfigProposalSchema, MarketingConfigProposeRequestSchema, MarketingConfigReceiptSchema,
  MarketingConfigRestoreRequestSchema, canonicalJson, diffConfig, type MarketingConfigProposal, type MarketingConfigReceipt,
} from './marketing-config-schemas.ts';
import { MARKETING_PACKAGE_ID, MarketingConfigSchema, type MarketingConfig } from './marketing-schemas.ts';

// Configuration builder service (U4). Shared writes lock the audience before the app; personal writes retain the
// owner fence. Every write rechecks its installation under that lock. Config grants nothing and never touches
// app records or campaign rows. Config revisions are independent of the installation revision.
const OPERATION_LIMIT = 10000;
const PROPOSAL_LIMIT = 20;
const PAST_REVISIONS = 100;
const HISTORY_VIEW = 20;

type Row = { id: string; app_id: string; space_id: string | null; state: 'draft' | 'active' | 'paused' | 'inactive'; config_revision: number; config: unknown; package_version: string; package_id: string };
type ProposalRow = {
  id: string; base_config_revision: number; package_version: string; proposed_config: unknown; canonical_hash: string; required_capabilities: string[];
  preview_receipt: { changes: unknown[]; dependencies: unknown[] }; status: 'pending' | 'applied' | 'discarded'; created_at: Date;
};
type VersionRow = { revision: number; config: unknown; package_version: string; source_proposal_id: string | null; created_at: Date };
type Installed = Awaited<ReturnType<typeof requireMarketingInstallation>>;
type ToolOrigin = { conversationId: string; turnId: string };
export type MarketingConfigMutation = { receipt: MarketingConfigReceipt; proposal: MarketingConfigProposal | null };
export type MarketingConfigDetail = z.infer<typeof MarketingConfigDetailResponseSchema>;

const sha = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
const PROPOSAL_COLUMNS = 'id,base_config_revision,package_version,proposed_config,canonical_hash,required_capabilities,preview_receipt,status,created_at';

/** Mutation keys are bound to an actor, installation and intent. Changed intent conflicts. */
function fingerprintOf(kind: string, installationId: string, intent: unknown): string {
  return sha({ kind, installationId, intent });
}
/** A replay returns the exact stored result. A changed intent under the same key is a conflict, never a second write. */
async function replay(tx: Db, owner: string, installationId: string, mutationId: string, fingerprint: string): Promise<MarketingConfigMutation | null> {
  const [row] = await tx.query<{ fingerprint: string; receipt: unknown; proposal_snapshot: unknown }>(
    'select fingerprint,receipt,proposal_snapshot from bob.marketing_config_operations where user_id=$1 and installation_id=$2 and mutation_id=$3', [owner, installationId, mutationId]);
  if (!row) return null;
  if (row.fingerprint !== fingerprint) throw new StoreConflictError('marketing_mutation_conflict');
  return parseMutation({ receipt: row.receipt, proposal: row.proposal_snapshot });
}
function parseMutation(value: unknown): MarketingConfigMutation {
  const parsed = z.strictObject({ receipt: MarketingConfigReceiptSchema, proposal: MarketingConfigProposalSchema.nullable() }).parse(value);
  return parsed;
}
async function atCapacity(tx: Db, owner: string, installationId: string): Promise<void> {
  const [count] = await tx.query<{ count: number }>('select count(*)::int as count from bob.marketing_config_operations where user_id=$1 and installation_id=$2', [owner, installationId]);
  if ((count?.count ?? 0) >= OPERATION_LIMIT) throw new StoreError('marketing_operation_limit');
}
/** The minimal receipt has no config. A bounded, strict enum-only proposal snapshot preserves exact replay after history pruning. */
async function record(tx: Db, owner: string, mutationId: string, fingerprint: string, mutation: MarketingConfigMutation): Promise<void> {
  await tx.query('insert into bob.marketing_config_operations(user_id,mutation_id,fingerprint,receipt,installation_id,proposal_snapshot) values($1,$2,$3,$4::text::jsonb,$5,$6::text::jsonb)',
    [owner, mutationId, fingerprint, JSON.stringify(mutation.receipt), mutation.receipt.installationId, mutation.proposal === null ? null : JSON.stringify(mutation.proposal)]);
}
/** The write guard locks and rechecks access, then requires a live installation and configure grant. */
async function guard(tx: Db, owner: string, installationId: string, permission: 'write' | 'manage'): Promise<Installed> {
  await lockMarketingInstallation(tx, owner, installationId, permission);
  return requireMarketingInstallation(tx, installationId, MARKETING_CONFIG_TOOL_GRANTS.propose_marketing_config);
}
/** Tool writes recheck the actual sender, matching audience and source policy under the mutation lock, including retries. */
async function requireToolOrigin(tx: Db, owner: string, installationId: string, origin: ToolOrigin | undefined): Promise<void> {
  if (!origin) return;
  const spaceId = await marketingConversationSpace(tx, owner, installationId, origin.conversationId, origin.turnId);
  if (!spaceId) throw new StoreConflictError('marketing_scope_required');
  await assertToolEnabled(tx, owner, 'propose_marketing_config', { spaceId, conversationId: origin.conversationId });
}
/** Read path: works while inactive so members can see why config is locked; RLS hides other audiences. */
async function loadOwned(tx: Db, id: string): Promise<Row> {
  const [row] = await tx.query<Row>('select id,app_id,space_id,state,config_revision,config,package_version,package_id from bob.bob_app_installations where id=$1', [id]);
  if (!row || row.package_id !== MARKETING_PACKAGE_ID) throw new StoreNotFoundError('marketing_installation_not_found');
  if (row.package_version !== MARKETING_PACKAGE_VERSION) throw new StoreError('marketing_package_unavailable');
  return row;
}
/** Records the current config as revision N the first time a change needs it, so every change has a restorable prior. */
async function ensureVersion(tx: Db, installation: Installed): Promise<void> {
  await tx.query(`insert into bob.marketing_config_versions(user_id,installation_id,revision,config,package_version,source_proposal_id)
    select user_id,id,config_revision,config,package_version,null from bob.bob_app_installations where id=$1
    on conflict (installation_id,revision) do nothing`, [installation.id]);
}
/** Writes a new config revision and its version. Config revision only: the installation revision and app data do not move. */
async function commitConfig(tx: Db, installation: Installed, config: MarketingConfig, sourceProposalId: string | null): Promise<number> {
  await ensureVersion(tx, installation);
  const next = installation.configRevision + 1;
  await tx.query('update bob.bob_app_installations set config=$2::text::jsonb,config_revision=$3,updated_at=now() where id=$1',
    [installation.id, JSON.stringify(config), next]);
  await tx.query(`insert into bob.marketing_config_versions(user_id,installation_id,revision,config,package_version,source_proposal_id)
    select user_id,id,$2::integer,$3::text::jsonb,package_version,$4::uuid from bob.bob_app_installations where id=$1`,
  [installation.id, next, JSON.stringify(config), sourceProposalId]);
  await prune(tx, installation.id, next);
  return next;
}
/** Bounded retention: keeps the current revision and the latest 100 past revisions. Pending proposals are never pruned. */
async function prune(tx: Db, installationId: string, current: number): Promise<void> {
  await tx.query('delete from bob.marketing_config_versions where installation_id=$1 and revision < $2', [installationId, current - PAST_REVISIONS]);
  await tx.query(`delete from bob.marketing_config_proposals where installation_id=$1 and status<>'pending' and id not in (
    select id from bob.marketing_config_proposals where installation_id=$1 and status<>'pending' order by created_at desc,id desc limit $2)`,
  [installationId, PAST_REVISIONS]);
}
/** The one entry point for unsupported or cadence-like requests: explicit unavailable, never a silent config edit. */
function parseProposed(value: unknown): MarketingConfig {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && (MARKETING_CONFIG_EXTENSION_KEYS as readonly string[]).some((key) => key in value)) {
    throw new StoreError('marketing_extension_unavailable');
  }
  return MarketingConfigSchema.parse(value);
}
function view(row: ProposalRow, appId: string, spaceId: string | null): MarketingConfigProposal {
  return MarketingConfigProposalSchema.parse({
    id: row.id, appUrl: spaceId === null ? `/apps/${appId}` : `/spaces/${spaceId}/apps?app=${appId}`, status: row.status, baseConfigRevision: row.base_config_revision, packageVersion: row.package_version, canonicalHash: row.canonical_hash,
    config: MarketingConfigSchema.parse(row.proposed_config), changes: row.preview_receipt.changes, dependencies: row.preview_receipt.dependencies,
    dataImpact: 'none', requiresApply: true, createdAt: new Date(row.created_at).getTime(),
  });
}
/** The hash binds the exact config, the owner, installation, base revision, package, grant requirement and preview receipt. */
function bind(input: { installationId: string; owner: string; baseConfigRevision: number; packageVersion: string; config: unknown; requiredCapabilities: string[]; previewReceipt: unknown }): string {
  return sha(input);
}
/** Shared proof belongs to the installation audience, not erasable author attribution. */
function proofOwner(actor: string, installation: Installed): string {
  return installation.spaceId === null ? actor : `space:${installation.spaceId}:installation:${installation.id}`;
}
function validateProposal(owner: string, installation: Installed, proposal: ProposalRow, hash: string): MarketingConfig {
  if (proposal.status !== 'pending') throw new StoreConflictError('marketing_proposal_not_pending');
  if (proposal.base_config_revision !== installation.configRevision || proposal.package_version !== installation.package.version) {
    throw new StoreConflictError('marketing_config_stale');
  }
  const config = MarketingConfigSchema.parse(proposal.proposed_config);
  const recomputed = bind({ installationId: installation.id, owner: proofOwner(owner, installation), baseConfigRevision: proposal.base_config_revision, packageVersion: proposal.package_version,
    config, requiredCapabilities: proposal.required_capabilities, previewReceipt: proposal.preview_receipt });
  if (canonicalJson(proposal.required_capabilities) !== canonicalJson([MARKETING_CONFIG_TOOL_GRANTS.propose_marketing_config])) throw new StoreError('marketing_proposal_tampered');
  if (hash !== proposal.canonical_hash || recomputed !== proposal.canonical_hash) throw new StoreError('marketing_proposal_tampered');
  return config;
}
function receipt(kind: MarketingConfigReceipt['kind'], installationId: string, proposalId: string | null, configRevision: number, noChange: boolean): MarketingConfigReceipt {
  return { kind, installationId, proposalId, configRevision, noChange };
}

/** Member read: current config, pending proposals, bounded versions and unavailable dependencies. Inactive is still readable. */
export async function readMarketingConfig(db: Db, owner: string, installationId: string, beforeRevision?: number): Promise<MarketingConfigDetail> {
  return withUser(db, owner, async (tx) => {
    const row = await loadOwned(tx, installationId);
    const pending = await tx.query<ProposalRow>(`select ${PROPOSAL_COLUMNS} from bob.marketing_config_proposals
      where installation_id=$1 and status='pending' order by created_at desc,id desc limit $2`, [installationId, PROPOSAL_LIMIT]);
    const versions = await tx.query<VersionRow>(`select revision,config,package_version,source_proposal_id,created_at from bob.marketing_config_versions
      where installation_id=$1 and ($3::integer is null or revision<$3) order by revision desc limit $2`, [installationId, HISTORY_VIEW + 1, beforeRevision ?? null]);
    return MarketingConfigDetailResponseSchema.parse({
      installation: { id: row.id, state: row.state, configRevision: row.config_revision, config: MarketingConfigSchema.parse(row.config), packageVersion: row.package_version, packageId: MARKETING_PACKAGE_ID },
      pending: pending.map((proposal) => view(proposal, row.app_id, row.space_id)),
      nextBeforeRevision: versions.length > HISTORY_VIEW ? versions[HISTORY_VIEW - 1]?.revision ?? null : null,
      versions: versions.slice(0, HISTORY_VIEW).map((version) => {
        const parsed = MarketingConfigSchema.safeParse(version.config);
        // An unreadable old version shows no config: it is never relabelled with the current one.
        return { revision: version.revision, config: parsed.success ? parsed.data : null, packageVersion: version.package_version,
          sourceProposalId: version.source_proposal_id, restorable: parsed.success && version.package_version === MARKETING_PACKAGE_VERSION,
          createdAt: new Date(version.created_at).getTime() };
      }),
      dependencies: MARKETING_CONFIG_DEPENDENCIES.map((dependency) => ({ ...dependency })),
    });
  });
}

async function loadProposal(tx: Db, installationId: string, proposalId: string): Promise<ProposalRow> {
  const [row] = await tx.query<ProposalRow>(`select ${PROPOSAL_COLUMNS} from bob.marketing_config_proposals where id=$1 and installation_id=$2`,
    [proposalId, installationId]);
  if (!row) throw new StoreNotFoundError('marketing_proposal_not_found');
  return row;
}
/** Propose: a pure preview plus a pending proposal bound to the exact config. Nothing active changes and no data is touched. */
export async function proposeMarketingConfig(db: Db, owner: string, installationId: string, value: unknown, origin?: ToolOrigin): Promise<MarketingConfigMutation> {
  const input = MarketingConfigProposeRequestSchema.parse(value);
  const proposed = parseProposed(input.config);
  const fingerprint = fingerprintOf('propose', installationId, { expectedConfigRevision: input.expectedConfigRevision, config: proposed });
  return withUser(db, owner, async (tx) => {
    const installation = await guard(tx, owner, installationId, 'write');
    await requireToolOrigin(tx, owner, installationId, origin);
    const previous = await replay(tx, owner, installationId, input.mutationId, fingerprint);
    if (previous) return previous;
    await atCapacity(tx, owner, installationId);
    if (installation.configRevision !== input.expectedConfigRevision) throw new StoreConflictError('marketing_revision_conflict');
    const [pending] = await tx.query<{ count: number }>(`select count(*)::int as count from bob.marketing_config_proposals where installation_id=$1 and status='pending'`, [installationId]);
    if ((pending?.count ?? 0) >= PROPOSAL_LIMIT) throw new StoreError('marketing_proposal_limit');
    const changes = diffConfig(installation.config, proposed);
    const requiredCapabilities = [MARKETING_CONFIG_TOOL_GRANTS.propose_marketing_config];
    const previewReceipt = { changes, dependencies: MARKETING_CONFIG_DEPENDENCIES.map((dependency) => ({ ...dependency })), dataImpact: 'none' };
    const canonicalHash = bind({ installationId, owner: proofOwner(owner, installation), baseConfigRevision: installation.configRevision, packageVersion: installation.package.version,
      config: proposed, requiredCapabilities, previewReceipt });
    const [row] = await tx.query<ProposalRow>(`insert into bob.marketing_config_proposals(user_id,created_by,installation_id,base_config_revision,package_version,proposed_config,canonical_hash,required_capabilities,preview_receipt)
      values((select user_id from bob.bob_app_installations where id=$2),$1,$2,$3,$4,$5::text::jsonb,$6,$8::text[],$7::text::jsonb) returning ${PROPOSAL_COLUMNS}`,
    [owner, installationId, installation.configRevision, installation.package.version, JSON.stringify(proposed), canonicalHash, JSON.stringify(previewReceipt), `{${requiredCapabilities.join(',')}}`]);
    const mutation = { receipt: receipt('proposed', installationId, row?.id ?? null, installation.configRevision, changes.length === 0), proposal: view(row as ProposalRow, installation.appId, installation.spaceId) };
    await record(tx, owner, input.mutationId, fingerprint, mutation);
    return mutation;
  });
}
/** Apply: recomputes the hash from the stored row and checks the base revision, package and live configure grant under the lock. */
export async function applyMarketingConfigProposal(db: Db, owner: string, installationId: string, value: unknown): Promise<MarketingConfigMutation> {
  const input = MarketingConfigApplyRequestSchema.parse(value);
  const fingerprint = fingerprintOf('apply', installationId, { proposalId: input.proposalId, hash: input.hash, expectedConfigRevision: input.expectedConfigRevision });
  return withUser(db, owner, async (tx) => {
    const installation = await guard(tx, owner, installationId, 'manage');
    const previous = await replay(tx, owner, installationId, input.mutationId, fingerprint);
    if (previous) return previous;
    await atCapacity(tx, owner, installationId);
    const proposal = await loadProposal(tx, installationId, input.proposalId);
    if (installation.configRevision !== input.expectedConfigRevision) throw new StoreConflictError('marketing_revision_conflict');
    const config = validateProposal(owner, installation, proposal, input.hash);
    const noChange = canonicalJson(installation.config) === canonicalJson(config);
    const revision = noChange ? installation.configRevision : await commitConfig(tx, installation, config, proposal.id);
    await tx.query("update bob.marketing_config_proposals set status='applied' where id=$1", [proposal.id]);
    // Proposal retention runs after the status change: the proposal just applied is no longer pending and counts now.
    await prune(tx, installationId, revision);
    const mutation = { receipt: receipt('applied', installationId, proposal.id, revision, noChange), proposal: view({ ...proposal, status: 'applied' }, installation.appId, installation.spaceId) };
    await record(tx, owner, input.mutationId, fingerprint, mutation);
    return mutation;
  });
}
/** Discard: a pending proposal only. Discarding a discarded proposal is a no-op; an applied one is a conflict. */
export async function discardMarketingConfigProposal(db: Db, owner: string, installationId: string, value: unknown): Promise<MarketingConfigMutation> {
  const input = MarketingConfigDiscardRequestSchema.parse(value);
  const fingerprint = fingerprintOf('discard', installationId, { proposalId: input.proposalId, expectedConfigRevision: input.expectedConfigRevision });
  return withUser(db, owner, async (tx) => {
    const installation = await guard(tx, owner, installationId, 'manage');
    const previous = await replay(tx, owner, installationId, input.mutationId, fingerprint);
    if (previous) return previous;
    await atCapacity(tx, owner, installationId);
    const proposal = await loadProposal(tx, installationId, input.proposalId);
    if (installation.configRevision !== input.expectedConfigRevision) throw new StoreConflictError('marketing_revision_conflict');
    if (proposal.status === 'applied') throw new StoreConflictError('marketing_proposal_not_pending');
    if (proposal.status === 'discarded') {
      const mutation = { receipt: receipt('discarded', installationId, proposal.id, installation.configRevision, true), proposal: view(proposal, installation.appId, installation.spaceId) };
      await record(tx, owner, input.mutationId, fingerprint, mutation);
      return mutation;
    }
    await tx.query("update bob.marketing_config_proposals set status='discarded' where id=$1", [proposal.id]);
    await prune(tx, installationId, installation.configRevision);
    const mutation = { receipt: receipt('discarded', installationId, proposal.id, installation.configRevision, false), proposal: view({ ...proposal, status: 'discarded' }, installation.appId, installation.spaceId) };
    await record(tx, owner, input.mutationId, fingerprint, mutation);
    return mutation;
  });
}
/** Restore: copies an old config into a NEW revision. Only the configuration changes: no app record, campaign row or grant is written. */
export async function restoreMarketingConfigVersion(db: Db, owner: string, installationId: string, value: unknown): Promise<MarketingConfigMutation> {
  const input = MarketingConfigRestoreRequestSchema.parse(value);
  const fingerprint = fingerprintOf('restore', installationId, { versionRevision: input.versionRevision, expectedConfigRevision: input.expectedConfigRevision });
  return withUser(db, owner, async (tx) => {
    const installation = await guard(tx, owner, installationId, 'manage');
    const previous = await replay(tx, owner, installationId, input.mutationId, fingerprint);
    if (previous) return previous;
    await atCapacity(tx, owner, installationId);
    if (installation.configRevision !== input.expectedConfigRevision) throw new StoreConflictError('marketing_revision_conflict');
    // A pruned, unknown or incompatible version is unavailable: it is never relabelled to the current package.
    const [version] = await tx.query<{ config: unknown; package_version: string }>(
      'select config,package_version from bob.marketing_config_versions where installation_id=$1 and revision=$2', [installationId, input.versionRevision]);
    const parsed = MarketingConfigSchema.safeParse(version?.config);
    if (!version || !parsed.success || version.package_version !== installation.package.version) throw new StoreError('marketing_version_unavailable');
    const noChange = canonicalJson(installation.config) === canonicalJson(parsed.data);
    const revision = noChange ? installation.configRevision : await commitConfig(tx, installation, parsed.data, null);
    const mutation = { receipt: receipt('restored', installationId, null, revision, noChange), proposal: null };
    await record(tx, owner, input.mutationId, fingerprint, mutation);
    return mutation;
  });
}
