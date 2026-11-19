import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { marketingContentRevision, runCheck, validateMarketingPack } from './check-marketing-pack.mjs';

// Expected digests are fixed literals, computed with sha256sum over the exact bytes written
// below. The checker's own hash function is never used to produce an expected value.
const ALPHA = 'b6a98d9ce9a2d9149288fa3df42d377c3e42737afdcdaf714e33c0a100b51060'; // "alpha\n"
const BRAVO = '5da8f23decf397b13f4f55b6fb8a61936238bfe08ed9d901132974f1beccc45c'; // "bravo\n"
const ART_V1 = 'c04b2af3f2fb88eae6f9a85a1cb042cfb0b96679cf2661646dc46db4a3cacdda'; // "art-v1"
const EXCERPT = '7d9d2dc86e79728d95394fac4c9d482ed309d6fef9545142fe66b02e76e944ea'; // "Bob. Your playful AI companion on phone and device."
const CANONICAL_AB = '63c9663de90ee828bbda6cd9acf02d0c653986c1ec25aa239920641edc9a1de5'; // '{"a":[2],"b":1}'
const LANDING = '3ff0d883acbb591691dca451af31bf5e8c235220';
const NOW = new Date('2026-10-30T12:00:00Z');
const CLI = resolve(import.meta.dirname, 'check-marketing-pack.mjs');
const ROOT = resolve(import.meta.dirname, '..');
const LOADER = pathToFileURL(resolve(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mkt-pack-'));
  dirs.push(dir);
  const files = { 'src/a.ts': 'alpha\n', 'src/b.ts': 'bravo\n', 'assets/art.webp': 'art-v1', 'unrelated.txt': 'x\n' };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

function pack() {
  const claim = (id, evidenceIds) => ({
    id, text: `claim ${id}`, sourceClassification: 'product-principle', evidenceIds, prerequisites: [],
    reviewedAt: '2026-10-30', reviewer: 'engineering review', expiresAt: '2027-01-28',
  });
  return {
    schemaVersion: 1,
    identity: {
      name: 'Bob', mission: "Bob lightens up people's moods.",
      originalArt: { rule: 'owner original art only', declaration: 'owner-original concept artwork', assetIds: ['bob-playful'] },
    },
    offer: { kind: 'early-beta-interest', purchase: 'not-offered', immediateAccess: 'not-promised', ctaId: 'cta.waitlist' },
    ctas: [{ id: 'cta.waitlist', kind: 'waitlist', readiness: 'pending-live-verification', prerequisites: ['live target verified'] }],
    unknowns: [{ id: 'unknown.price', question: 'What is the retail price?', rule: 'Unknown price is never free.' }],
    audiences: [{ id: 'individuals', label: 'For you', campaignPriority: 'hypothesis', confirmQuestion: 'Do they sign up?', evidenceIds: ['ev.a'] }],
    prohibitions: [{ id: 'prohibit.offline-ai', rule: 'Never say Bob works offline.' }],
    evidence: {
      'ev.a': { statement: 'a', sources: [{ kind: 'local-file', repoPath: 'src/a.ts', sha256: ALPHA }] },
      'ev.b': { statement: 'b', sources: [{ kind: 'local-file', repoPath: 'src/b.ts', sha256: BRAVO }] },
      'ev.site': {
        statement: 'site',
        sources: [{
          kind: 'public-copy', sourceURL: `https://github.com/suzworx/heybob-landing-page/blob/${LANDING}/src/lib/seo.ts`,
          revision: LANDING, sourcePath: 'src/lib/seo.ts', line: 8,
          excerpt: 'Bob. Your playful AI companion on phone and device.', excerptSha256: EXCERPT,
          verification: 'repository_snapshot',
        }],
      },
    },
    claims: [claim('claim.uses-a', ['ev.a']), claim('claim.uses-b', ['ev.b']), claim('claim.site', ['ev.site'])],
    assets: { 'bob-playful': { path: 'assets/art.webp', sha256: ART_V1, kind: 'owner-original-art', rights: 'owner original' } },
  };
}

const check = (root, overrides = {}) => validateMarketingPack({
  pack: pack(), root, now: NOW, ...overrides,
});

describe('validateMarketingPack seam', () => {
  it('passes a valid snapshot offline', () => {
    const result = check(fixture());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('a changed source errors and names only its dependent claims', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'src/a.ts'), 'alpha changed\n');
    const result = check(dir);
    const text = result.errors.join('\n');
    expect(result.ok).toBe(false);
    expect(text).toContain('ev.a');
    expect(text).toContain('claim.uses-a');
    expect(text).not.toContain('claim.uses-b');
    expect(text).not.toContain('claim.site');
  });

  it('an unrelated source change raises no error', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'unrelated.txt'), 'changed\n');
    expect(check(dir).errors).toEqual([]);
  });

  it('altered original art fails and names its asset id', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'assets/art.webp'), 'art-v2');
    const text = check(dir).errors.join('\n');
    expect(text).toContain('bob-playful');
    expect(text).not.toContain('ev.a');
  });

  it('a missing evidence file is named with its dependent claim', () => {
    const dir = fixture();
    rmSync(join(dir, 'src/b.ts'));
    const text = check(dir).errors.join('\n');
    expect(text).toContain('ev.b');
    expect(text).toContain('claim.uses-b');
  });

  it('duplicate claim IDs fail', () => {
    const p = pack();
    p.claims.push({ ...p.claims[0] });
    const result = check(fixture(), { pack: p });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('duplicate');
  });

  it('a dangling evidence reference fails and names the missing ID', () => {
    const p = pack();
    p.claims[0].evidenceIds = ['ev.missing'];
    const result = check(fixture(), { pack: p });
    expect(result.errors.join('\n')).toContain('ev.missing');
  });

  it('an expired claim fails under a fixed clock', () => {
    const result = check(fixture(), { now: new Date('2027-02-01T00:00:00Z') });
    expect(result.errors.join('\n')).toContain('expired');
  });

  it('a path that escapes the repository root or is absolute is refused', () => {
    const escape = pack();
    escape.evidence['ev.a'].sources[0].repoPath = '../outside.txt';
    expect(check(fixture(), { pack: escape }).errors.join('\n')).toContain('escapes');
    const absolute = pack();
    absolute.evidence['ev.a'].sources[0].repoPath = resolve(tmpdir(), 'outside.txt');
    expect(check(fixture(), { pack: absolute }).errors.join('\n')).toContain('absolute');
  });

  it('a changed public-copy excerpt digest fails offline and names the evidence', () => {
    const p = pack();
    p.evidence['ev.site'].sources[0].excerptSha256 = ALPHA;
    expect(check(fixture(), { pack: p }).errors.join('\n')).toContain('ev.site');
  });

  it('a failing check never changes the pack or any file', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'src/a.ts'), 'altered\n');
    const p = pack();
    const before = marketingContentRevision(p);
    const listing = readdirSync(dir, { recursive: true }).map(String).sort();
    const bytes = readFileSync(join(dir, 'src/a.ts'), 'utf8');
    check(dir, { pack: p });
    check(dir, { pack: p });
    expect(marketingContentRevision(p)).toBe(before);
    expect(readdirSync(dir, { recursive: true }).map(String).sort()).toEqual(listing);
    expect(readFileSync(join(dir, 'src/a.ts'), 'utf8')).toBe(bytes);
    expect(existsSync(join(dir, 'pack.json'))).toBe(false);
  });

  it('the content revision is canonical JSON, independent of key order', () => {
    expect(marketingContentRevision({ b: 1, a: [2] })).toBe(CANONICAL_AB);
    expect(marketingContentRevision({ a: [2], b: 1 })).toBe(CANONICAL_AB);
  });

  it('the real repository pack passes through the CLI from any caller cwd', () => {
    const run = spawnSync(process.execPath, ['--import', LOADER, CLI], { cwd: tmpdir(), encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/content revision: [0-9a-f]{64}/);
  });

  it('an unrecognized source classification fails', () => {
    const p = pack();
    p.claims[0].sourceClassification = 'fabricated';
    expect(check(fixture(), { pack: p }).errors.join('\n')).toContain('unrecognized sourceClassification');
  });

  it('deployed status needs deployment proof; implemented status never implies deployed', () => {
    const p = pack();
    p.claims[0].status = 'deployed';
    expect(check(fixture(), { pack: p }).errors.join('\n')).toContain('deploymentProof');
    p.claims[0].status = 'implemented';
    expect(check(fixture(), { pack: p }).errors).toEqual([]);
  });
});

// Pack contract tests on the real exported pack: commercial and CTA rules are data facts, not regex safety claims.
describe('marketing pack contract (real pack)', () => {
  it('keeps the price unknown and the purchase CTA blocked', async () => {
    const { bobMarketingPack: real } = await import('../apps/ai/src/marketing-pack.ts');
    expect(real.unknowns.map((unknown) => unknown.id)).toContain('unknown.price');
    const purchase = real.ctas.filter((cta) => cta.kind === 'purchase');
    expect(purchase.length).toBeGreaterThan(0);
    expect(purchase.every((cta) => cta.readiness === 'blocked')).toBe(true);
    expect(real.offer.purchase).toBe('not-offered');
  });

  it('keeps the waitlist CTA distinct from product sign-in', async () => {
    const { bobMarketingPack: real } = await import('../apps/ai/src/marketing-pack.ts');
    const kind = (id) => real.ctas.find((cta) => cta.id === id)?.kind;
    expect(kind('cta.waitlist')).toBe('waitlist');
    expect(kind('cta.sign-in')).toBe('product-sign-in');
  });
});

// Correction c1 (fail closed on malformed structure) and c2 (first-party public-copy provenance).
describe('fail-closed structure and provenance', () => {
  const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // sha256 of ""
  const failsWith = (p, text) => {
    const result = check(fixture(), { pack: p });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(text);
  };

  it('rejects an empty object, null and undefined without throwing', () => {
    expect(() => check(fixture(), { pack: {} })).not.toThrow();
    expect(check(fixture(), { pack: {} }).ok).toBe(false);
    expect(check(fixture(), { pack: null }).ok).toBe(false);
    expect(check(fixture(), { pack: undefined }).ok).toBe(false);
  });

  it('rejects a wrong collection shape and a pack whose claims are deleted', () => {
    const wrong = pack();
    wrong.claims = {};
    failsWith(wrong, 'claims');
    const emptied = pack();
    emptied.claims = [];
    failsWith(emptied, 'claims');
  });

  it('rejects a claim with a missing or blank ID', () => {
    const missing = pack();
    delete missing.claims[0].id;
    failsWith(missing, 'id');
    const blank = pack();
    blank.claims[0].id = '  ';
    failsWith(blank, 'id');
  });

  it('rejects a malformed evidence source without throwing', () => {
    const nullSource = pack();
    nullSource.evidence['ev.a'].sources = [null];
    failsWith(nullSource, 'ev.a');
    const noKind = pack();
    noKind.evidence['ev.a'].sources = [{ repoPath: 'src/a.ts' }];
    failsWith(noKind, 'ev.a');
  });

  it('refuses a module without the bobMarketingPack export, with no silent pass', async () => {
    const dir = fixture();
    const moduleFile = join(dir, 'no-pack.mjs');
    writeFileSync(moduleFile, 'export const notThePack = {};\n');
    const lines = [];
    const log = { error: (line) => lines.push(line), info: (line) => lines.push(line) };
    const code = await runCheck({
      moduleUrl: pathToFileURL(moduleFile).href, root: dir, now: NOW, log,
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('bobMarketingPack');
  });

  it('rejects a forged repository or host behind a matching suffix', () => {
    const host = pack();
    host.evidence['ev.site'].sources[0].sourceURL = `https://evil.example/blob/${LANDING}/src/lib/seo.ts`;
    failsWith(host, 'ev.site');
    const repo = pack();
    repo.evidence['ev.site'].sources[0].sourceURL = `https://github.com/attacker/heybob-landing-page/blob/${LANDING}/src/lib/seo.ts`;
    failsWith(repo, 'ev.site');
  });

  it('requires verification and a positive integer line on public copy', () => {
    const noVerification = pack();
    delete noVerification.evidence['ev.site'].sources[0].verification;
    failsWith(noVerification, 'ev.site');
    const noLine = pack();
    delete noLine.evidence['ev.site'].sources[0].line;
    failsWith(noLine, 'ev.site');
    const zeroLine = pack();
    zeroLine.evidence['ev.site'].sources[0].line = 0;
    failsWith(zeroLine, 'ev.site');
  });

  it('rejects an empty excerpt even with its matching empty-string digest', () => {
    const p = pack();
    const source = p.evidence['ev.site'].sources[0];
    source.excerpt = '';
    source.excerptSha256 = EMPTY_SHA;
    failsWith(p, 'ev.site');
  });
});
