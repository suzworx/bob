#!/usr/bin/env node
/**
 * check-marketing-pack.mjs (issue 1396, U1) — structural release-integrity check
 * for Bob's marketing pack. Run with `node --import tsx` so the real exported
 * pack is loaded, never evaluated with regexes.
 *
 * Seam (exported for tests): validateMarketingPack takes the pack, the repository
 * root and a clock, so fixture repositories and fixed dates can drive it. marketingContentRevision hashes the pack's canonical JSON.
 * The checker only detects drift: it never writes digests, dates, claims or the pack.
 *
 * Content is bound by file hashes, never by git commit ids, so the check survives a
 * rewritten or squashed history.
 *
 * Structural only: hashes and dates prove that files and records are unchanged or
 * not expired. They do not prove that any copy is true or that art is faithful.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const CLASSIFICATIONS = ['implemented-capability', 'public-positioning', 'product-principle', 'planned'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ERRORS = 50;
const MAX_LINE = 240;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Keys sorted, arrays in order, undefined dropped: the same content always gives the same text.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function marketingContentRevision(pack) {
  return sha256(canonicalJson(pack) ?? 'null');
}

// Lexical and real-path containment, checked before any read. Returns { abs } or { problem }.
function resolveInside(root, repoPath) {
  if (typeof repoPath !== 'string' || repoPath === '') return { problem: 'empty path' };
  if (isAbsolute(repoPath)) return { problem: 'absolute path refused' };
  const abs = resolve(root, repoPath);
  const rel = relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { problem: 'escapes repository root' };
  }
  if (existsSync(abs) && !realpathSync(abs).startsWith(`${realpathSync(root)}${sep}`)) {
    return { problem: 'escapes repository root' };
  }
  return { abs };
}

// Public-copy source paths are provenance labels, not local files: only refuse absolute or parent paths.
const isSafeRelative = (path) => typeof path === 'string' && path !== '' && !isAbsolute(path)
  && !path.split(/[\\/]/).includes('..');

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isNonEmptyList = (value) => Array.isArray(value) && value.length > 0;
const listOf = (value) => (Array.isArray(value) ? value : []);

// Required fields: text must be a nonempty string and list fields must be arrays. False when not a record.
function requireFields(record, label, texts, lists, fail) {
  if (!isRecord(record)) {
    fail(`${label}: not a record`);
    return false;
  }
  for (const field of texts) {
    if (!isText(record[field])) fail(`${label}: missing ${field}`);
  }
  for (const field of lists) {
    if (!Array.isArray(record[field])) fail(`${label}: ${field} must be a list`);
  }
  return true;
}

function checkSourceShape(source, label, fail) {
  if (!isRecord(source)) {
    fail(`${label}: source is not a record`);
  } else if (source.kind === 'local-file') {
    requireFields(source, label, ['repoPath', 'sha256'], [], fail);
  } else if (source.kind === 'public-copy') {
    requireFields(source, label, ['sourceURL', 'revision', 'sourcePath', 'excerpt', 'excerptSha256', 'verification'], [], fail);
    if (!Number.isInteger(source.line) || source.line < 1) fail(`${label}: line must be a positive integer`);
  } else {
    fail(`${label}: unrecognized source kind`);
  }
}

function checkEvidenceShape(id, item, fail) {
  const label = `evidence ${id}`;
  if (!requireFields(item, label, ['statement'], ['sources'], fail)) return;
  if (!isNonEmptyList(item.sources)) {
    fail(`${label}: sources must be a nonempty list`);
    return;
  }
  item.sources.forEach((source, index) => checkSourceShape(source, `${label} source ${index + 1}`, fail));
}

// Per-record field shapes for each list the checks read. Each entry is a nonempty list in the published pack.
const LIST_SHAPES = {
  claims: (record, label, fail) => requireFields(record, label,
    ['text', 'sourceClassification', 'reviewer', 'reviewedAt', 'expiresAt'], ['evidenceIds', 'prerequisites'], fail),
  ctas: (record, label, fail) => requireFields(record, label, ['kind', 'readiness'], ['prerequisites'], fail),
  unknowns: (record, label, fail) => requireFields(record, label, ['question', 'rule'], [], fail),
  audiences: (record, label, fail) => requireFields(record, label,
    ['label', 'campaignPriority', 'confirmQuestion'], ['evidenceIds'], fail),
  prohibitions: (record, label, fail) => requireFields(record, label, ['rule'], [], fail),
};

// Every record needs a nonempty ID that is unique within its list, then its own field shape.
function checkList(name, list, fail) {
  const seen = new Set();
  list.forEach((record, index) => {
    const label = `${name} record ${index + 1}`;
    const id = isRecord(record) ? record.id : undefined;
    if (!isText(id)) fail(`${label}: id must be a nonempty string`);
    else if (seen.has(id)) fail(`duplicate ${name} id ${id}`);
    seen.add(id);
    LIST_SHAPES[name](record, label, fail);
  });
}

// A keyed record (evidence or assets) must be nonempty, with nonempty keys and a valid item shape.
function checkKeyed(name, map, checkItem, fail) {
  if (!isRecord(map) || Object.keys(map).length === 0) {
    fail(`${name} must be a nonempty record`);
    return;
  }
  for (const [id, item] of Object.entries(map)) {
    if (isText(id)) checkItem(id, item, fail);
    else fail(`${name}: a key is blank`);
  }
}

// Structure first: the pack must have the shape the checks read, with no silent defaults.
function checkPackShape(pack, fail) {
  if (!isRecord(pack)) {
    fail('pack is not an object: the bobMarketingPack export is missing or has the wrong type');
    return;
  }
  if (pack.schemaVersion !== 1) fail('schemaVersion must be 1');
  requireFields(pack.identity, 'identity', ['name', 'mission'], [], fail);
  if (requireFields(pack.identity?.originalArt, 'identity.originalArt', ['rule', 'declaration'], ['assetIds'], fail)
    && !isNonEmptyList(pack.identity.originalArt.assetIds)) {
    fail('identity.originalArt.assetIds must be a nonempty list');
  }
  requireFields(pack.offer, 'offer', ['kind', 'purchase', 'immediateAccess', 'ctaId'], [], fail);
  for (const name of Object.keys(LIST_SHAPES)) {
    if (isNonEmptyList(pack[name])) checkList(name, pack[name], fail);
    else fail(`${name} must be a nonempty list`);
  }
  checkKeyed('evidence', pack.evidence, checkEvidenceShape, fail);
  checkKeyed('assets', pack.assets, (id, item, f) => requireFields(item, `asset ${id}`, ['path', 'sha256', 'kind', 'rights'], [], f), fail);
}

// Cross-record references: every reference must name an existing record, never a dangling one.
function checkReferences(pack, fail) {
  const evidence = isRecord(pack.evidence) ? pack.evidence : {};
  const assets = isRecord(pack.assets) ? pack.assets : {};
  for (const audience of listOf(pack.audiences)) {
    for (const id of listOf(audience?.evidenceIds)) {
      if (!Object.hasOwn(evidence, id)) fail(`audience ${audience?.id}: dangling evidence reference ${id}`);
    }
  }
  for (const id of listOf(pack.identity?.originalArt?.assetIds)) {
    if (!Object.hasOwn(assets, id)) fail(`identity: dangling asset reference ${id}`);
  }
  if (!listOf(pack.ctas).some((cta) => cta?.id === pack.offer?.ctaId)) fail(`offer: dangling cta reference ${pack.offer?.ctaId}`);
}

/**
 * Pure seam. pack: the exported bobMarketingPack. root: repository root. now: Date
 * (the check date).
 * Reads source files, never writes; returns bounded, identifier-only error lines.
 */
export function validateMarketingPack({ pack, root, now }) {
  const errors = [];
  const fail = (message) => errors.push(message);
  checkPackShape(pack, fail);
  if (isRecord(pack)) checkReferences(pack, fail);
  if (errors.length === 0) runContentChecks(pack, root, now, fail);
  const shown = errors.slice(0, MAX_ERRORS).map((line) => line.slice(0, MAX_LINE));
  if (errors.length > MAX_ERRORS) shown.push(`...and ${errors.length - MAX_ERRORS} more`);
  return { ok: errors.length === 0, errors: shown, contentRevision: marketingContentRevision(pack) };
}

// Runs only after the shape and reference checks pass, so every read below is of a checked structure.
function runContentChecks(pack, root, now, fail) {
  const ctx = {
    root,
    now,
    evidence: pack.evidence,
    claims: pack.claims,
    fail,
  };
  ctx.claimsFor = (evidenceId) => ctx.claims
    .filter((claim) => claim.evidenceIds.includes(evidenceId))
    .map((claim) => claim.id)
    .join(', ');
  checkClaims(ctx);
  checkEvidence(ctx);
  checkAssets(ctx, pack.assets, pack.identity.originalArt.assetIds);
}

const dayMs = (text) => (DATE.test(text ?? '') ? Date.parse(`${text}T00:00:00Z`) : NaN);

function checkDates(label, claim, now, fail) {
  const reviewed = dayMs(claim.reviewedAt);
  const expires = dayMs(claim.expiresAt);
  if (Number.isNaN(reviewed)) fail(`${label}: reviewedAt is not a YYYY-MM-DD date`);
  else if (reviewed > now.getTime()) fail(`${label}: reviewedAt is after the check date`);
  if (Number.isNaN(expires)) fail(`${label}: expiresAt is not a YYYY-MM-DD date`);
  else if (now.getTime() >= expires) fail(`${label}: expired on ${claim.expiresAt}`);
}

const CLAIM_FIELDS = ['text', 'reviewer', 'reviewedAt', 'expiresAt'];

function checkClaimFields(claim, label, evidence, fail) {
  for (const field of CLAIM_FIELDS) {
    if (typeof claim[field] !== 'string' || claim[field] === '') fail(`${label}: missing ${field}`);
  }
  if (!CLASSIFICATIONS.includes(claim.sourceClassification)) fail(`${label}: unrecognized sourceClassification`);
  if (!Array.isArray(claim.evidenceIds) || claim.evidenceIds.length === 0) fail(`${label}: no evidenceIds`);
  for (const id of claim.evidenceIds ?? []) {
    if (!Object.hasOwn(evidence, id)) fail(`${label}: dangling evidence reference ${id}`);
  }
  if (!Array.isArray(claim.prerequisites)) fail(`${label}: prerequisites must be a list`);
}

// A deployed status is never inferred from implemented: it needs a complete, human-recorded proof.
function checkDeploymentProof(claim, label, fail) {
  const proof = claim.deploymentProof;
  if (claim.status === 'deployed' && !(proof?.rev && proof?.date && proof?.method && proof?.observer)) {
    fail(`${label}: deployed status needs a complete deploymentProof`);
  }
}

// Claim records: unique IDs, required fields, known classification, resolvable evidence,
// dates and expiry, and deployment proof for a deployed status.
function checkClaims({ claims, evidence, now, fail }) {
  const ids = new Set();
  for (const claim of claims) {
    const label = `claim ${claim.id}`;
    if (ids.has(claim.id)) fail(`duplicate claim id ${claim.id}`);
    ids.add(claim.id);
    checkClaimFields(claim, label, evidence, fail);
    checkDates(label, claim, now, fail);
    checkDeploymentProof(claim, label, fail);
  }
}

// Raw-byte digest of a file, or null when it cannot be read as a file.
function fileDigest(abs) {
  try {
    return sha256(readFileSync(abs));
  } catch {
    return null;
  }
}

const FIRST_PARTY_BLOB = 'https://github.com/suzworx/heybob-landing-page/blob/';

// Public copy must pin the first-party landing repository at a full revision and a safe path, carry
// verification and a positive line, and match the digest of a nonempty excerpt. Offline only: the imported
// snapshot is checked, never the live website.
function checkExcerpt(fail, id, source, affected) {
  const pinned = /^[0-9a-f]{40}$/.test(source.revision ?? '');
  const expectedURL = pinned ? `${FIRST_PARTY_BLOB}${source.revision}/${source.sourcePath}` : null;
  if (!pinned || !isSafeRelative(source.sourcePath) || source.sourceURL !== expectedURL) {
    fail(`evidence ${id}: public copy must pin the first-party repository at a full revision and a safe path`);
  }
  if (source.verification !== 'repository_snapshot') fail(`evidence ${id}: public copy verification must be repository_snapshot`);
  if (!Number.isInteger(source.line) || source.line < 1) fail(`evidence ${id}: public copy line must be a positive integer`);
  if (!isText(source.excerpt)) fail(`evidence ${id}: public copy excerpt is empty`);
  else if (sha256(source.excerpt) !== source.excerptSha256) {
    fail(`evidence ${id}: public-copy excerpt digest mismatch (imported snapshot); ${affected}`);
  }
}

// Evidence: a local file must sit inside the repository and match its raw-byte SHA-256; a
// changed or missing file names the evidence ID and the claims that depend on it.
function checkLocalSource(root, id, source, affected, fail) {
  const found = resolveInside(root, source.repoPath);
  if (found.problem) fail(`evidence ${id}: ${source.repoPath ?? '(no path)'}: ${found.problem}`);
  else if (!existsSync(found.abs)) fail(`evidence ${id}: ${source.repoPath} is missing; ${affected}`);
  else if (fileDigest(found.abs) !== source.sha256) fail(`evidence ${id}: ${source.repoPath} changed (sha256 mismatch); ${affected}`);
}

function checkSource(root, id, source, affected, fail) {
  if (source.kind === 'public-copy') checkExcerpt(fail, id, source, affected);
  else if (source.kind === 'local-file') checkLocalSource(root, id, source, affected, fail);
  else fail(`evidence ${id}: unrecognized source kind`);
}

function checkEvidence({ root, evidence, claimsFor, fail }) {
  for (const [id, item] of Object.entries(evidence)) {
    const affected = `claims: ${claimsFor(id) || 'none'}`;
    if (typeof item.statement !== 'string' || item.statement === '') fail(`evidence ${id}: missing statement`);
    if (!Array.isArray(item.sources) || item.sources.length === 0) fail(`evidence ${id}: no sources`);
    for (const source of item.sources ?? []) checkSource(root, id, source, affected, fail);
  }
}

// Approved art: each owner-original file must match its raw-byte digest; a missing or altered file names the asset ID.
function checkAssets({ root, fail }, assets, originalIds) {
  for (const id of originalIds) {
    if (!Object.hasOwn(assets, id)) fail(`identity: dangling asset reference ${id}`);
  }
  for (const [id, asset] of Object.entries(assets)) {
    if (typeof asset.kind !== 'string' || typeof asset.rights !== 'string') fail(`asset ${id}: missing kind or rights`);
    const found = resolveInside(root, asset.path);
    if (found.problem) fail(`asset ${id}: ${asset.path ?? '(no path)'}: ${found.problem}`);
    else if (!existsSync(found.abs)) fail(`asset ${id}: file is missing`);
    else if (fileDigest(found.abs) !== asset.sha256) fail(`asset ${id}: bytes changed (sha256 mismatch)`);
  }
}

// A missing export comes back as undefined, which the shape check then refuses.
export async function loadPackExport(moduleUrl) {
  const loaded = await import(moduleUrl);
  return loaded.bobMarketingPack;
}

// CLI body with an injectable module URL and log, so tests can drive it. Returns the exit code.
export async function runCheck({ moduleUrl, root, now, log = console }) {
  let pack;
  try {
    pack = await loadPackExport(moduleUrl);
  } catch {
    log.error('marketing pack: FAIL (the pack module could not be loaded; run it with npm run check:marketing-pack)');
    return 1;
  }
  const result = validateMarketingPack({ pack, root, now });
  for (const line of result.errors) log.error(`FAIL ${line}`);
  log.info(`marketing pack content revision: ${result.contentRevision}`);
  log.info(`marketing pack: ${result.ok ? 'PASS' : `FAIL (${result.errors.length} problem line(s))`}`);
  return result.ok ? 0 : 1;
}

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = await runCheck({
    moduleUrl: pathToFileURL(resolve(ROOT, 'apps/ai/src/marketing-pack.ts')).href,
    root: ROOT,
    now: new Date(),
  });
}
