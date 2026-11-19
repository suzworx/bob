import { z } from 'zod';

// Strict wire contracts for the first-party Marketing installation (U2). Exported through web-schemas for the UI.
export const MARKETING_PACKAGE_ID = 'bob-marketing';
export const MARKETING_VIEWS = ['campaign', 'content', 'schedule', 'results'] as const;
export const MARKETING_GRANTS = ['campaign.draft', 'campaign.configure', 'campaign.read'] as const;
const CHANNELS = ['instagram', 'linkedin'] as const;
const mutationId = z.uuid();
const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

// Config grants nothing: it only shapes what the workspace shows and which channels a draft defaults to.
export const MarketingConfigSchema = z.strictObject({
  visibleViews: z.array(z.enum(MARKETING_VIEWS)).min(1).max(4).refine(unique, 'Views must be unique.'),
  contentGrouping: z.enum(['none', 'channel', 'pillar']),
  defaultChannels: z.array(z.enum(CHANNELS)).min(1).max(2).refine(unique, 'Channels must be unique.'),
});
export type MarketingConfig = z.infer<typeof MarketingConfigSchema>;
export const DEFAULT_MARKETING_CONFIG: MarketingConfig = { visibleViews: [...MARKETING_VIEWS], contentGrouping: 'none', defaultChannels: [...CHANNELS] };

const MarketingPackageSummarySchema = z.strictObject({ packageId: z.literal(MARKETING_PACKAGE_ID), name: z.string(), version: z.string() });
export const MarketingInstallationSchema = z.strictObject({
  id: z.uuid(), appId: z.uuid(), spaceId: z.uuid().nullable(), canManage: z.boolean(), state: z.enum(['draft', 'active', 'paused', 'inactive']),
  grantedCapabilities: z.array(z.enum(MARKETING_GRANTS)), revision: z.number().int().positive(),
  configRevision: z.number().int().positive(), config: MarketingConfigSchema, package: MarketingPackageSummarySchema,
  createdAt: z.number().int(), updatedAt: z.number().int(),
});
const MARKETING_CAPABILITIES = ['drafting', 'publishing', 'analytics', 'research', 'render', 'conversions'] as const;
export const MarketingPackageSchema = z.strictObject({
  packageId: z.literal(MARKETING_PACKAGE_ID), version: z.string(), name: z.string(), mission: z.string(), voice: z.string(),
  roles: z.array(z.strictObject({ id: z.string(), label: z.string(), summary: z.string(), skillId: z.string(), skillVersion: z.string() })).length(6),
  assets: z.array(z.strictObject({ id: z.string(), url: z.string(), rights: z.string() })),
  capabilities: z.array(z.strictObject({ id: z.enum(MARKETING_CAPABILITIES), status: z.enum(['available', 'unavailable']), reason: z.string() })).length(6),
  grants: z.array(z.enum(MARKETING_GRANTS)),
});

export const MarketingInstallSchema = z.strictObject({ packageId: z.literal(MARKETING_PACKAGE_ID), mutationId, spaceId: z.uuid().nullable().optional() });
export const MarketingLifecycleSchema = z.strictObject({
  operation: z.enum(['activate', 'pause', 'resume']), expectedRevision: z.number().int().positive().max(2147483646), mutationId,
});
export const MarketingSelectionSchema = z.strictObject({ installationId: z.uuid().nullable(), mutationId });

export const MarketingPackageResponseSchema = z.strictObject({ package: MarketingPackageSchema });
export const MarketingInstallResponseSchema = z.strictObject({ installation: MarketingInstallationSchema });
export const MarketingInstallationsResponseSchema = z.strictObject({
  installations: z.array(MarketingInstallationSchema), selectedInstallationId: z.uuid().nullable(),
});
export const MarketingSelectionResponseSchema = z.strictObject({
  selection: z.strictObject({ installationId: z.uuid(), expiresAt: z.number().int() }).nullable(),
});

export const MarketingInstallationsQuerySchema = z.strictObject({ spaceId: z.uuid().nullable().optional() });
