import { bobMarketingPack, marketingPhaseSkills, marketingPhases } from '@bob/ai';
import type { z } from 'zod';
import { MARKETING_GRANTS, MARKETING_PACKAGE_ID, type MarketingPackageSchema } from './marketing-schemas.ts';

// The compiled-in first-party package (U2, extended in U3). Adding a package is a reviewed code change: nothing is
// downloaded, no model writes a package, and nothing under .claude/ is read at runtime.
export const MARKETING_PACKAGE_VERSION = '1.0.0';
// Registry baseline: drafting, configuring and reading campaigns. Publishing is never granted by installation.
export const MARKETING_BASELINE_GRANTS = [...MARKETING_GRANTS];

// Curated display text per preparation phase. Role IDs and skill IDs/versions come from the actual U4 module; the
// instruction text of a skill is never served from here.
const ROLE_DISPLAY: Record<(typeof marketingPhases)[number], { label: string; summary: string }> = {
  strategy: { label: 'Strategy', summary: 'Sets the campaign goal, the audience and what success looks like.' },
  positioning: { label: 'Positioning', summary: "Turns Bob's public truth into one promise and three message pillars." },
  planning: { label: 'Planning', summary: 'Plans the calendar: channel, format, pillar and call to action.' },
  creative: { label: 'Creative', summary: 'Writes drafts that cite approved claims and original art.' },
  review: { label: 'Review', summary: 'Checks each draft against the claims, forbidden phrases and art rules.' },
  measurement: { label: 'Measurement', summary: 'Plans what to measure. Missing data is shown as not available, never zero.' },
};

// Truthful capability state. Drafting is available; nothing else is until its unit is built and proven.
const CAPABILITIES = [
  { id: 'drafting', status: 'available', reason: 'Writes drafts for review. Instagram takes images and carousels; LinkedIn takes text, images and carousels. Nothing is published.' },
  { id: 'publishing', status: 'unavailable', reason: 'No channel connection is proven yet, so nothing is published.' },
  { id: 'analytics', status: 'unavailable', reason: 'Metrics are not collected yet, so reports show not available.' },
  { id: 'research', status: 'unavailable', reason: 'No research source is configured.' },
  { id: 'render', status: 'unavailable', reason: 'Image rendering is not built yet, so drafts reference the original art only.' },
  { id: 'conversions', status: 'unavailable', reason: 'Conversions are not measured, so no conversion figures are shown.' },
] as const;

// Same-origin originals only. The UI serves these from its public folder; repository paths never leave the server.
const ASSET_URLS: Readonly<Record<string, string>> = { 'bob-playful': '/brand/bob/bob-playful.webp', 'bob-helper': '/brand/bob/bob-helper.webp' };

/** The Marketing tool allowlist: a tool is offered only when the installation holds its grant. Runtime grants never come from skill text. */
export const MARKETING_TOOL_GRANTS = {
  marketing_context: 'campaign.read', research_sources: 'campaign.read', list_capabilities: 'campaign.read',
  list_campaigns: 'campaign.read', read_campaign: 'campaign.read', select_campaign: 'campaign.read',
  list_drafts: 'campaign.read', read_draft: 'campaign.read',
  add_marketing_review_note: 'campaign.draft',
  create_campaign: 'campaign.configure', save_plan_section: 'campaign.draft', save_draft: 'campaign.draft', update_draft: 'campaign.draft',
  // Also needs campaign.configure, checked in the store with the write: it creates the campaign too.
  save_week_plan: 'campaign.draft',
} as const satisfies Record<string, (typeof MARKETING_GRANTS)[number]>;
export type MarketingToolName = keyof typeof MARKETING_TOOL_GRANTS;

/** Apps specialist configuration tools stay separate from the Marketing execution tools. */
export const MARKETING_CONFIG_TOOL_GRANTS = {
  read_marketing_config: 'campaign.read', propose_marketing_config: 'campaign.configure',
} as const satisfies Record<string, (typeof MARKETING_GRANTS)[number]>;

/** The package display: identity, roles and original art come from the product pack and U4 skills, never typed in here. */
export function marketingPackage(): z.infer<typeof MarketingPackageSchema> {
  const { identity, assets } = bobMarketingPack;
  const packAssets: Record<string, { rights: string }> = assets;
  return {
    packageId: MARKETING_PACKAGE_ID, version: MARKETING_PACKAGE_VERSION, name: identity.name,
    mission: identity.mission, voice: identity.voice,
    roles: marketingPhases.map((phase) => ({
      id: phase, label: ROLE_DISPLAY[phase].label, summary: ROLE_DISPLAY[phase].summary,
      skillId: marketingPhaseSkills[phase].id, skillVersion: marketingPhaseSkills[phase].version,
    })),
    assets: Object.entries(ASSET_URLS).map(([id, url]) => ({ id, url, rights: packAssets[id]?.rights ?? '' })),
    capabilities: CAPABILITIES.map((capability) => ({ ...capability })),
    grants: [...MARKETING_BASELINE_GRANTS],
  };
}

/** The workspace shell that installation creates: one empty table and one view. U3 replaces it with marketing tables. */
export const MARKETING_WORKSPACE_DEFINITION = {
  schemaVersion: 1, title: 'Bob Marketing', lifecycle: 'keep',
  tables: [{ id: 'campaigns', fields: [{ id: 'title', type: 'text' }] }], actions: [], metrics: [],
  views: [{ id: 'workspace', kind: 'table', title: 'Campaigns', table: 'campaigns', fields: ['title'], actions: [] }],
} as const;
