import { z } from 'zod';
import { MARKETING_PACKAGE_ID, MarketingConfigSchema, type MarketingConfig } from './marketing-schemas.ts';

// Wire contracts for the Marketing configuration builder (U4). Strict everywhere: unknown keys are rejected, so config
// can never carry grants, tool names, accounts, approval, cadence, code or CSS. Exported for the U5 router and UI.
const mutationId = z.uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const configRevision = z.number().int().positive().max(2147483646);

/** Dependencies the builder names but cannot provide yet. Each one is shown as unavailable, never as a fake setting. */
export const MARKETING_CONFIG_DEPENDENCIES = [
  { id: 'weekly-metrics', status: 'unavailable', reason: 'Weekly metrics are not collected yet, so reports show not available.' },
  { id: 'playbooks', status: 'unavailable', reason: 'Playbooks are not built yet, so no playbook can be selected.' },
  { id: 'native-skills', status: 'unavailable', reason: 'Additional custom or native skill extensions are unavailable. The six built-in Marketing skills remain available.' },
  { id: 'workflows', status: 'unavailable', reason: 'Custom workflows are not supported; configuration only shapes the workspace.' },
  { id: 'connectors', status: 'unavailable', reason: 'No channel connector is connected, so nothing is published.' },
] as const;
/** Requests for an extension that belongs to another policy. They answer unavailable rather than invalid. */
export const MARKETING_CONFIG_EXTENSION_KEYS = ['cadence', 'publishing', 'playbooks', 'workflows', 'connectors', 'metrics', 'skills'] as const;

export const MarketingConfigChangeSchema = z.discriminatedUnion('field', [
  z.strictObject({ field: z.literal('visibleViews'), before: MarketingConfigSchema.shape.visibleViews, after: MarketingConfigSchema.shape.visibleViews }),
  z.strictObject({ field: z.literal('contentGrouping'), before: MarketingConfigSchema.shape.contentGrouping, after: MarketingConfigSchema.shape.contentGrouping }),
  z.strictObject({ field: z.literal('defaultChannels'), before: MarketingConfigSchema.shape.defaultChannels, after: MarketingConfigSchema.shape.defaultChannels }),
]);
const MarketingConfigDependencySchema = z.strictObject({
  id: z.enum(MARKETING_CONFIG_DEPENDENCIES.map((dependency) => dependency.id) as [string, ...string[]]),
  status: z.literal('unavailable'),
  reason: z.string(),
});
export const MarketingConfigProposalSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['pending', 'applied', 'discarded']),
  baseConfigRevision: configRevision,
  packageVersion: z.string(),
  canonicalHash: hash,
  appUrl: z.string().regex(/^\/(?:apps\/[0-9a-f-]{36}|spaces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/apps\?app=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/),
  config: MarketingConfigSchema,
  changes: z.array(MarketingConfigChangeSchema),
  dependencies: z.array(MarketingConfigDependencySchema),
  dataImpact: z.literal('none'),
  requiresApply: z.literal(true),
  createdAt: z.number().int(),
});
/** The typed minimal receipt the server stores per mutation key. Replay returns this exact object. */
export const MarketingConfigReceiptSchema = z.strictObject({
  kind: z.enum(['proposed', 'applied', 'discarded', 'restored']),
  installationId: z.uuid(),
  proposalId: z.uuid().nullable(),
  configRevision: configRevision,
  noChange: z.boolean(),
});
const MarketingConfigVersionSchema = z.strictObject({
  revision: configRevision, config: MarketingConfigSchema.nullable(), packageVersion: z.string(), sourceProposalId: z.uuid().nullable(),
  restorable: z.boolean(), createdAt: z.number().int(),
});
export const MarketingConfigDetailResponseSchema = z.strictObject({
  installation: z.strictObject({
    id: z.uuid(), state: z.enum(['draft', 'active', 'paused', 'inactive']), configRevision, config: MarketingConfigSchema, packageVersion: z.string(),
    packageId: z.literal(MARKETING_PACKAGE_ID),
  }),
  pending: z.array(MarketingConfigProposalSchema).max(20),
  versions: z.array(MarketingConfigVersionSchema).max(20),
  nextBeforeRevision: configRevision.nullable(),
  dependencies: z.array(MarketingConfigDependencySchema),
});
export const MarketingConfigHistoryQuerySchema = z.strictObject({ beforeRevision: z.coerce.number().int().positive().max(2147483646).optional() });
export const MarketingConfigProposeRequestSchema = z.strictObject({ mutationId, expectedConfigRevision: configRevision, config: z.unknown() });
export const MarketingConfigApplyRequestSchema = z.strictObject({ mutationId, proposalId: z.uuid(), hash, expectedConfigRevision: configRevision });
export const MarketingConfigDiscardRequestSchema = z.strictObject({ mutationId, proposalId: z.uuid(), expectedConfigRevision: configRevision });
export const MarketingConfigRestoreRequestSchema = z.strictObject({ mutationId, versionRevision: configRevision, expectedConfigRevision: configRevision });
export const MarketingConfigMutationResponseSchema = z.strictObject({ receipt: MarketingConfigReceiptSchema, proposal: MarketingConfigProposalSchema.nullable() });

export type MarketingConfigProposal = z.infer<typeof MarketingConfigProposalSchema>;
export type MarketingConfigReceipt = z.infer<typeof MarketingConfigReceiptSchema>;
export type MarketingConfigChange = z.infer<typeof MarketingConfigChangeSchema>;
export type { MarketingConfig };

/** Canonical JSON: object keys sorted, array order kept. The hash binds the exact config bytes the owner was shown. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Field-level diff between the current and proposed config. Only changed fields appear; the preview has no side effects. */
export function diffConfig(current: MarketingConfig, proposed: MarketingConfig): MarketingConfigChange[] {
  return (['visibleViews', 'contentGrouping', 'defaultChannels'] as const)
    .filter((field) => canonicalJson(current[field]) !== canonicalJson(proposed[field]))
    .map((field) => MarketingConfigChangeSchema.parse({ field, before: current[field], after: proposed[field] }));
}
