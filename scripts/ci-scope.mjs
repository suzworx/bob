import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/*
 * ci-scope.mjs — which CI jobs a change needs.
 *
 * Writes web|server|firmware|docker=true|false to $GITHUB_OUTPUT. ci.yml skips
 * a job whose flag is false, and the `validate` aggregate accepts a skipped
 * half only when its flag says the skip was deliberate.
 *
 * The changed files come from git, not the GitHub API:
 *   pull_request — origin/<base>...HEAD (needs fetch-depth: 0)
 *   push         — <before>..<sha>; an all-zeros <before> (a new branch) runs everything
 *
 * Any doubt runs everything: an unknown path, a file that shapes every job
 * (ci.yml, root manifests and configs, validate.mjs), another event, or a git
 * failure. A missed skip costs minutes; a wrong skip lets a break reach main.
 */

const ROOT = resolve(import.meta.dirname, '..');
const ZERO_SHA = /^0+$/;

export const JOBS = ['web', 'server', 'firmware', 'docker'];

// Files every job depends on: a change here runs everything.
const EVERYTHING = [
  /^\.github\/workflows\/ci\.yml$/,
  /^package(-lock)?\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^scripts\/validate\.mjs$/,
];

// First match wins. A path no rule matches runs everything.
const RULES = [
  // Vitest config controls software suites; firmware uses PlatformIO/C++.
  [/^vitest\.config\.ts$/, ['web', 'server']],
  // Prose no job reads: docs, agent tooling, root markdown. Markdown inside an
  // app falls to that app's rule below.
  [/^(docs\/|\.claude\/|[^/]+\.md$)/, []],
  // These scripts exercise software only. Keep other scripts fail-closed:
  // tooling can also change firmware builds or release packaging.
  [/^scripts\/(ci-scope(?:\.test)?\.mjs|demo-routines(?:-model)?\.ts)$/, ['web', 'server', 'docker']],
  // Device wire changes must still compile/test both sides of the contract.
  [/^apps\/api\/(src|tests)\/voice\/protocol(?:[.-]|\/)/, ['web', 'server', 'firmware', 'docker']],
  // ai's own suite runs in web; api imports ai as raw source.
  [/^apps\/ai\//, ['web', 'server', 'docker']],
  [/^apps\/api\//, ['server', 'docker']],
  [/^apps\/ui-v2\//, ['web', 'docker']],
  [/^apps\/mobile\//, ['web']],
  [/^\.env\.example$/, ['web']],
  // Migrations feed the server suites; scripts/invite-only.test.ts (web) reads supabase/config.toml.
  [/^supabase\//, ['web', 'server']],
  // The CA roots drift check runs in web, not in the firmware job.
  [/^apps\/cardputer\/(ca-roots\/|include\/ca_roots\.h$|scripts\/gen-ca-roots\.mjs$)/, ['web', 'firmware']],
  // The shared wire fixtures are one contract, two suites: the firmware host
  // tests parse them, apps/api/tests/voice/wire-fixtures.test.ts (server) checks them.
  [/^apps\/cardputer\/test\/fixtures\//, ['server', 'firmware']],
  [/^apps\/cardputer\//, ['firmware']],
  // The image and the scripts only the image runs: the tools stage's verified
  // download and the container's entry script. No suite reads them.
  [/^(Dockerfile|\.dockerignore|scripts\/(fetch-verified\.mjs|start-server\.sh))$/, ['docker']],
];

// The web job runs the scripts suite, whose repo-wide rules (no-agent-doubles
// and the like) read every app's sources and tests. A change there always
// runs web, so the path filter can never skip a rule the change may break.
// Unclassified scripts run everything; the explicit software scripts above
// still run web and its repo-wide rules.
const RULE_READS = /^apps\/[^/]+\/(src|tests)\//;

const all = (value) => Object.fromEntries(JOBS.map((job) => [job, value]));

/** The jobs a set of changed paths needs. */
export function scope(files) {
  const needed = all(false);
  for (const file of files) {
    if (EVERYTHING.some((pattern) => pattern.test(file))) return all(true);
    const rule = RULES.find(([pattern]) => pattern.test(file));
    if (!rule) return all(true);
    for (const job of rule[1]) needed[job] = true;
    if (RULE_READS.test(file)) needed.web = true;
  }
  return needed;
}

/** The git diff range for this event, or null when everything must run. */
export function diffRange({ event, baseRef, before, sha }) {
  if (event === 'pull_request' && baseRef) return `origin/${baseRef}...HEAD`;
  if (event === 'push' && before && sha && !ZERO_SHA.test(before)) return `${before}..${sha}`;
  return null;
}

/**
 * The final decision. `files` is null when the diff could not be computed.
 * Known software changes skip firmware on both PRs and main. The release job
 * requires firmware success, so it does not publish an unchanged binary.
 * Unsupported events and unavailable diffs remain fail-closed.
 */
export function decide({ event, files }) {
  if (!['pull_request', 'push'].includes(event) || files === null) return all(true);
  return scope(files);
}

const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  const event = process.env.GITHUB_EVENT_NAME ?? '';
  const range = diffRange({
    event,
    baseRef: process.env.GITHUB_BASE_REF,
    before: process.env.BEFORE,
    sha: process.env.GITHUB_SHA,
  });
  let files = null;
  if (range) {
    const diff = spawnSync('git', ['diff', '--name-only', range], { cwd: ROOT, encoding: 'utf8' });
    if (diff.status === 0) {
      files = diff.stdout.split('\n').filter(Boolean);
    } else {
      console.log(`::warning::git diff ${range} failed, so everything runs: ${diff.stderr.trim()}`);
    }
  } else {
    console.log(`No diff range for event "${event}", so everything runs.`);
  }
  if (files) console.log(`${files.length} changed file(s) in ${range}:\n  ${files.join('\n  ')}`);

  const needed = decide({ event, files });
  const lines = JOBS.map((job) => `${job}=${needed[job]}`);
  console.log(lines.join(' '));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}
