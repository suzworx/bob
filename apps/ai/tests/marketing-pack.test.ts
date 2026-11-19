import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bobMarketingPack } from '../src/marketing-pack.ts';

// Pinned review date; the engineering default expiry is 90 days later.
const REVIEW_DATE = '2026-10-30';
const EXPIRY_DATE = '2027-01-28';
const DAY_MS = 86_400_000;
// The approved art hashes are the spec: this file never recomputes them from the image files.
const APPROVED_ART_SHA256: Readonly<Record<string, string>> = {
  'bob-playful': '862e3a2f9e3bc1c213b9de4ec2df389143c24ad114dd74c4133f6e00e4ca2f57',
  'bob-helper': 'b6f524dd57891cc4d187620a631c6fc0f64ce83bcf2bbb9b47bfe127b3e5b100',
};
const PRIVATE_KEYS = ['userId', 'user_id', 'accountId', 'email', 'spaceId', 'campaignId', 'token', 'secret'];

type Source = Partial<Record<'kind' | 'repoPath' | 'sha256' | 'sourceURL' | 'revision' | 'sourcePath' | 'excerpt' | 'excerptSha256' | 'verification', string>>;
const evidenceById: Readonly<Record<string, { readonly statement: string; readonly sources: readonly Source[] }>> = bobMarketingPack.evidence;
const assetById: Readonly<Record<string, { readonly sha256: string; readonly rights: string }>> = bobMarketingPack.assets;

const ctaOf = (id: string) => bobMarketingPack.ctas.find((cta) => cta.id === id);
const claimsOfClass = (classification: string) =>
  bobMarketingPack.claims.filter((claim) => claim.sourceClassification === classification);

/** Every object key in a value, at any depth. */
function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child)]);
}

describe('Bob marketing product pack (public seam)', () => {
  it('gives a consumer Bob identity without owner intake', () => {
    expect(bobMarketingPack.identity.name).toBe('Bob');
    expect(bobMarketingPack.identity.mission).toBe("Bob lightens up people's moods.");
  });

  it('lists the implemented capabilities a consumer may state as working', () => {
    expect(claimsOfClass('implemented-capability').map((claim) => claim.id).sort()).toEqual([
      'capability.everyday-help',
      'capability.games',
      'capability.memory-personal',
      'capability.tasks-and-plans',
    ]);
  });

  it('keeps early-beta interest distinct from purchase and promises no immediate access', () => {
    expect(bobMarketingPack.offer.kind).toBe('early-beta-interest');
    expect(bobMarketingPack.offer.purchase).toBe('not-offered');
    expect(bobMarketingPack.offer.immediateAccess).toBe('not-promised');
    expect(ctaOf('cta.waitlist')?.kind).toBe('waitlist');
    expect(ctaOf('cta.sign-in')?.kind).toBe('product-sign-in');
    expect(ctaOf('cta.purchase')?.kind).toBe('purchase');
  });

  it('never marks a CTA ready and blocks the purchase CTA', () => {
    for (const cta of bobMarketingPack.ctas) expect(cta.readiness).not.toBe('ready');
    expect(ctaOf('cta.purchase')?.readiness).toBe('blocked');
    expect(ctaOf('cta.waitlist')?.readiness).toBe('pending-live-verification');
  });

  it('never states a deployed claim without proof, and never cites public copy as implementation', () => {
    for (const claim of bobMarketingPack.claims) {
      expect(claim).not.toHaveProperty('deploymentProof');
      expect(claim.sourceClassification).not.toBe('deployed');
    }
    for (const claim of claimsOfClass('public-positioning')) {
      for (const evidenceId of claim.evidenceIds) {
        expect(evidenceById[evidenceId]?.sources.every((source) => source.kind === 'public-copy')).toBe(true);
      }
    }
  });

  it('resolves every claim, evidence and asset reference', () => {
    for (const claim of bobMarketingPack.claims) {
      for (const evidenceId of claim.evidenceIds) expect(evidenceById[evidenceId]).toBeDefined();
    }
    for (const assetId of bobMarketingPack.identity.originalArt.assetIds) {
      expect(assetById[assetId]).toBeDefined();
    }
  });

  it('pins the approved Bob art by SHA-256 and declares it owner-original concept art', () => {
    for (const [id, sha256] of Object.entries(APPROVED_ART_SHA256)) {
      expect(assetById[id]?.sha256).toBe(sha256);
    }
    expect(bobMarketingPack.identity.originalArt.declaration).toBe('owner-original concept artwork, not a retail product photograph');
  });

  it('checks every public excerpt against its stored SHA-256 offline', () => {
    for (const evidence of Object.values(evidenceById)) {
      for (const source of evidence.sources) {
        if (source.kind !== 'public-copy') continue;
        expect(createHash('sha256').update(source.excerpt ?? '', 'utf8').digest('hex')).toBe(source.excerptSha256);
      }
    }
  });

  it('dates every review from the pinned date, expires it 90 days later, and labels the reviewer accurately', () => {
    for (const claim of bobMarketingPack.claims) {
      expect(claim.reviewedAt).toBe(REVIEW_DATE);
      expect(claim.expiresAt).toBe(EXPIRY_DATE);
      expect((Date.parse(claim.expiresAt) - Date.parse(claim.reviewedAt)) / DAY_MS).toBe(90);
      expect(claim.reviewer).toMatch(/source review by an engineering agent/i);
    }
  });

  it('keeps every campaign audience a hypothesis that names what would confirm it', () => {
    expect(bobMarketingPack.audiences.map((audience) => audience.id).sort()).toEqual(['businesses', 'families', 'individuals', 'older-adults']);
    for (const audience of bobMarketingPack.audiences) {
      expect(audience.campaignPriority).toBe('hypothesis');
      expect(audience.confirmQuestion.length).toBeGreaterThan(0);
    }
  });

  it('reports commercial unknowns as unknown and never as free', () => {
    expect(bobMarketingPack.unknowns.map((unknown) => unknown.id).sort()).toEqual([
      'unknown.app-store',
      'unknown.checkout',
      'unknown.conversion-baseline',
      'unknown.delivery-date',
      'unknown.inventory',
      'unknown.price',
      'unknown.shipping',
    ]);
    expect(bobMarketingPack.unknowns.find((unknown) => unknown.id === 'unknown.price')?.rule).toMatch(/never free/);
  });

  it('forbids every claim the owner ruled out', () => {
    expect(bobMarketingPack.prohibitions.map((prohibition) => prohibition.id).sort()).toEqual([
      'prohibit.fake-testimonials',
      'prohibit.guaranteed-reach',
      'prohibit.instant-answers',
      'prohibit.medical-effects',
      'prohibit.offline-ai',
      'prohibit.unannounced-integrations',
    ]);
  });

  it('contains no user, account or campaign data', () => {
    const keys = keysDeep(bobMarketingPack);
    for (const key of PRIVATE_KEYS) expect(keys).not.toContain(key);
  });

  it('states the inbox as the account inbox with account-wide notices, not only the bound space', () => {
    const everyday = bobMarketingPack.claims.find((claim) => claim.id === 'capability.everyday-help');
    expect(everyday?.text).toMatch(/account-wide notices/);
    expect(everyday?.text).not.toMatch(/inbox inside the bound space/);
    expect(evidenceById['bob.everyday-help']?.sources.map((source) => source.repoPath)).toContain('apps/api/src/voice/voice-tools.ts');
  });

  it('cites every authoritative source that decides personal versus shared memory, each with a SHA-256 digest', () => {
    const sources = evidenceById['bob.memory-boundary']?.sources ?? [];
    expect(sources.map((source) => source.repoPath)).toEqual(expect.arrayContaining([
      'apps/ai/src/memory-tools.ts',
      'apps/api/src/memory/extract.ts',
      'apps/api/src/workflows/workflow-web-chat-turn.ts',
      'apps/api/src/voice/turn/context.ts',
      'apps/api/src/voice/turn/generate.ts',
      'apps/api/src/conversations/scope.ts',
    ]));
    for (const source of sources) {
      if (source.kind === 'local-file') expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
