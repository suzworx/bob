/**
 * Bob's built-in marketing product pack (issue 1396, U1): public brand truth
 * compiled into the code. No file reads at runtime, and no account, user or
 * campaign data. Structural checks show that a file or string is unchanged; they
 * never certify that copy is true. The review record is a source review by an
 * engineering agent, not semantic proof.
 */
import { artSha256, landingExcerpts, localFileSha256 } from './marketing-pack-digests.ts';

/** Every claim shares one review record: the pinned review date and the 90-day engineering expiry. */
const REVIEW = {
  reviewedAt: '2026-10-30',
  reviewer: 'Source review by an engineering agent (structural, not semantic proof)',
  expiresAt: '2027-01-28',
} as const;


const localSource = (repoPath: keyof typeof localFileSha256) =>
  ({ kind: 'local-file', repoPath, sha256: localFileSha256[repoPath] }) as const;

/** The fact rows: each states one fact and lists the sources that show it. */
const evidence = {
  'bob.mission': {
    statement: "Bob lightens up people's moods: adorable, fun and kind.",
    sources: [localSource('AGENTS.md')],
  },
  'bob.character': {
    statement: 'Bob is adorable, minimal and fun; errors look apologetic, never alarming.',
    sources: [localSource('.claude/skills/bob-character/SKILL.md')],
  },
  'bob.positioning': {
    statement: 'Public copy presents Bob as a playful AI companion on phone and device, for play, chat and plans.',
    sources: [{ kind: 'public-copy', ...landingExcerpts['seo.title'] }, { kind: 'public-copy', ...landingExcerpts['seo.description-play'] }],
  },
  'bob.early-beta': {
    statement: 'Public copy asks visitors to sign up for early beta, which registers interest.',
    sources: [{ kind: 'public-copy', ...landingExcerpts['seo.description-beta'] }, { kind: 'public-copy', ...landingExcerpts['faq.beta-access'] }],
  },
  'bob.audiences': {
    statement: 'Public copy addresses four segments: individuals, families, older adults and businesses.',
    sources: [
      { kind: 'public-copy', ...landingExcerpts['audience.for-you'] },
      { kind: 'public-copy', ...landingExcerpts['audience.families'] },
      { kind: 'public-copy', ...landingExcerpts['audience.older-adults'] },
      { kind: 'public-copy', ...landingExcerpts['audience.businesses'] },
    ],
  },
  'bob.channels': {
    statement: 'Public copy places Bob on your phone and the Bob device; telephone calling and other messaging apps are planned.',
    sources: [{ kind: 'public-copy', ...landingExcerpts['seo.description-device'] }, { kind: 'public-copy', ...landingExcerpts['faq.channels-planned'] }],
  },
  'bob.tasks-plans': {
    statement: 'Task, calendar and event tools act only in the space bound to the turn.',
    sources: [localSource('apps/ai/src/productivity-tools.ts'), localSource('apps/api/src/tasks/agent-callbacks.ts')],
  },
  'bob.everyday-help': {
    statement: 'Reminder, note and search tools act inside the bound space. The inbox tool reads unread notices for the same account only, including account-wide ones.',
    sources: [
      localSource('apps/ai/src/voice-tools.ts'),
      localSource('apps/api/src/voice/tool-providers.ts'),
      localSource('apps/api/src/voice/voice-tools.ts'),
    ],
  },
  'bob.play': {
    statement: 'Animal Riddles and Simon Says are registered games, filtered by account settings and age band.',
    sources: [localSource('apps/ai/src/games/registry.ts')],
  },
  'bob.memory-boundary': {
    statement: 'Personal memory is read and fed only in a private space or a legacy conversation with no space; pair and group conversations read and feed none.',
    sources: [
      localSource('apps/ai/src/memory-tools.ts'),
      localSource('apps/api/src/memory/extract.ts'),
      localSource('apps/api/src/workflows/workflow-web-chat-turn.ts'),
      localSource('apps/api/src/voice/turn/context.ts'),
      localSource('apps/api/src/voice/turn/generate.ts'),
      localSource('apps/api/src/conversations/scope.ts'),
    ],
  },
  'bob.device-concept': {
    statement: 'The pictured device is a concept; retail pricing and shipping are unannounced.',
    sources: [{ kind: 'public-copy', ...landingExcerpts['faq.device-concept'] }],
  },
  'bob.business-exploration': {
    statement: 'Business direction is exploratory; no dedicated offer, pricing, deployment or CRM, Slack or inventory integration is announced.',
    sources: [
      { kind: 'public-copy', ...landingExcerpts['faq.business-not-announced'] },
      { kind: 'public-copy', ...landingExcerpts['faq.business-boundary'] },
      { kind: 'public-copy', ...landingExcerpts['faq.business-crm-question'] },
    ],
  },
} as const;

/** Claims: stable IDs, scoped text, evidence, prerequisites and a source classification. Public copy is never classed as implementation. */
const claims = [
  { id: 'mission.lightens-moods', sourceClassification: 'product-principle', evidenceIds: ['bob.mission'], prerequisites: [],
    text: "Bob exists to lighten people's moods: adorable, fun and kind.", ...REVIEW },
  { id: 'character.kind-and-adorable', sourceClassification: 'product-principle', evidenceIds: ['bob.character'], prerequisites: [],
    text: "Bob's look and tone stay adorable, minimal and kind; only the owner's original art shows him.", ...REVIEW },
  { id: 'positioning.companion', sourceClassification: 'public-positioning', evidenceIds: ['bob.positioning'], prerequisites: [],
    text: 'The public site presents Bob as a playful AI companion for play, chat and making plans.', ...REVIEW },
  { id: 'channels.phone-and-device', sourceClassification: 'public-positioning', evidenceIds: ['bob.channels'], prerequisites: [],
    text: 'The public site presents Bob as an AI companion on your phone and on the Bob device.', ...REVIEW },
  { id: 'channels.planned', sourceClassification: 'planned', evidenceIds: ['bob.channels'],
    prerequisites: ['shipped and verified before any availability wording'],
    text: 'Telephone calling and other messaging apps are planned, not available.', ...REVIEW },
  { id: 'early-beta.interest', sourceClassification: 'public-positioning', evidenceIds: ['bob.early-beta'],
    prerequisites: ['live waitlist target verified before an executable CTA'],
    text: 'Signing up for early beta registers interest only. It is not a purchase and promises no immediate access.', ...REVIEW },
  { id: 'audiences.four-segments', sourceClassification: 'public-positioning', evidenceIds: ['bob.audiences'], prerequisites: [],
    text: 'The public site addresses individuals, families, older adults and businesses.', ...REVIEW },
  { id: 'capability.tasks-and-plans', sourceClassification: 'implemented-capability', evidenceIds: ['bob.tasks-plans'],
    prerequisites: ['the turn is bound to a space the account belongs to'],
    text: 'Bob can list, create, complete and update tasks, and list and create calendar events, inside the bound space.', ...REVIEW },
  { id: 'capability.everyday-help', sourceClassification: 'implemented-capability', evidenceIds: ['bob.everyday-help'],
    prerequisites: ['the turn is bound to a space the account belongs to'],
    text: 'Bob can create, list and cancel reminders, create and read notes, and search inside the bound space. The inbox lists unread notices for this account only, including account-wide notices.', ...REVIEW },
  { id: 'capability.games', sourceClassification: 'implemented-capability', evidenceIds: ['bob.play'],
    prerequisites: ['account settings allow the game and the age band fits'],
    text: 'Animal Riddles and Simon Says are built-in games, offered only when account settings allow them.', ...REVIEW },
  { id: 'capability.memory-personal', sourceClassification: 'implemented-capability', evidenceIds: ['bob.memory-boundary'],
    prerequisites: ['memory is on for the account'],
    text: 'Bob reads and feeds personal memory only in a private space; pair and group conversations get no personal memory.', ...REVIEW },
  { id: 'memory.no-perfect-recall', sourceClassification: 'product-principle', evidenceIds: ['bob.memory-boundary'], prerequisites: [],
    text: 'Bob does not promise perfect recall of anything said earlier.', ...REVIEW },
  { id: 'device.concept-only', sourceClassification: 'public-positioning', evidenceIds: ['bob.device-concept'],
    prerequisites: ['a price and shipping announcement before any price or delivery wording'],
    text: 'The pictured Bob device is a concept. Its retail price and shipping are not announced.', ...REVIEW },
  { id: 'business.exploratory', sourceClassification: 'public-positioning', evidenceIds: ['bob.business-exploration'],
    prerequisites: ['an announced offering before any business offer wording'],
    text: 'The business direction is exploratory: no dedicated offer, pricing, deployment or CRM, Slack or inventory integration is announced.', ...REVIEW },
] as const;

const identity = {
  name: 'Bob',
  mission: "Bob lightens up people's moods.",
  voice: 'warm, playful and kind; never pushy, fear-based or guilt-based',
  originalArt: {
    rule: 'Show Bob only with the owner original art listed in assets. Never draw, regenerate, restyle, flip or recolour Bob.',
    assetIds: ['bob-playful', 'bob-helper'],
    declaration: 'owner-original concept artwork, not a retail product photograph',
  },
} as const;

/** The offer is early-beta interest only: no purchase and no immediate access. */
const offer = {
  kind: 'early-beta-interest',
  purchase: 'not-offered',
  immediateAccess: 'not-promised',
  ctaId: 'cta.waitlist',
} as const;

/** Calls to action. Readiness is never 'ready' until a live target is verified; purchase stays blocked. */
const ctas = [
  { id: 'cta.waitlist', kind: 'waitlist', readiness: 'pending-live-verification',
    prerequisites: ['verified email waitlist live target checked against the production site'] },
  { id: 'cta.sign-in', kind: 'product-sign-in', readiness: 'pending-live-verification',
    prerequisites: ['invited account; never the same as the waitlist'] },
  { id: 'cta.purchase', kind: 'purchase', readiness: 'blocked', prerequisites: ['price, checkout and shipping all exist'] },
] as const;

/** Commercial facts Bob must report as unknown. Unknown price is never free. */
const unknowns = [
  { id: 'unknown.price', question: 'What is the retail price?', rule: 'Unknown price is never free: never state a price or a free offer.' },
  { id: 'unknown.checkout', question: 'Is there a checkout?', rule: 'No checkout is known: no purchase call to action.' },
  { id: 'unknown.shipping', question: 'What is shipping?', rule: 'Shipping is unannounced: never state a cost or time.' },
  { id: 'unknown.delivery-date', question: 'When is delivery?', rule: 'Never state a delivery date.' },
  { id: 'unknown.inventory', question: 'Is any device in stock?', rule: 'Stock is unknown: never imply availability.' },
  { id: 'unknown.conversion-baseline', question: 'What is the conversion baseline?', rule: 'Not measured: never state a conversion rate or result.' },
  { id: 'unknown.app-store', question: 'Is a public app store listing live?', rule: 'Unknown: never claim a store listing.' },
] as const;

/** Claims the owner ruled out. Generated copy must never state them. */
const prohibitions = [
  { id: 'prohibit.offline-ai', rule: 'Never say Bob works offline or without the internet.' },
  { id: 'prohibit.instant-answers', rule: 'Never promise instant answers.' },
  { id: 'prohibit.medical-effects', rule: 'Never claim therapeutic, health or medical effects.' },
  { id: 'prohibit.guaranteed-reach', rule: 'Never promise reach, virality or results.' },
  { id: 'prohibit.fake-testimonials', rule: 'Never invent testimonials or endorsements.' },
  { id: 'prohibit.unannounced-integrations', rule: 'Never claim an integration that is not announced, such as CRM, Slack or inventory.' },
] as const;

/** Campaign audiences are hypotheses: each names the question that would confirm or reject it. */
const audiences = [
  { id: 'individuals', label: 'For you', campaignPriority: 'hypothesis',
    confirmQuestion: 'Do individuals sign up for early beta after a playful companion message?', evidenceIds: ['bob.audiences'] },
  { id: 'families', label: 'For families', campaignPriority: 'hypothesis',
    confirmQuestion: 'Do families respond to shared plans with Bob?', evidenceIds: ['bob.audiences'] },
  { id: 'older-adults', label: 'For older adults', campaignPriority: 'hypothesis',
    confirmQuestion: 'Do older adults respond to a familiar voice at home?', evidenceIds: ['bob.audiences'] },
  { id: 'businesses', label: 'For businesses', campaignPriority: 'hypothesis',
    confirmQuestion: 'Is there demand for a business offer? None is announced.', evidenceIds: ['bob.audiences', 'bob.business-exploration'] },
] as const;

/** Approved Bob art: owner originals only, identified by path and SHA-256. */
const assets = {
  'bob-playful': { path: 'apps/ui-v2/public/brand/bob/bob-playful.webp', sha256: artSha256['bob-playful'],
    kind: 'owner-original-art', rights: 'owner-original concept artwork, not a retail product photograph' },
  'bob-helper': { path: 'apps/ui-v2/public/brand/bob/bob-helper.webp', sha256: artSha256['bob-helper'],
    kind: 'owner-original-art', rights: 'owner-original concept artwork, not a retail product photograph' },
} as const;

/** The compiled pack: the only export. Readonly all the way down. */
export const bobMarketingPack = {
  schemaVersion: 1,
  identity,
  offer,
  claims,
  audiences,
  unknowns,
  prohibitions,
  ctas,
  evidence,
  assets,
} as const;
