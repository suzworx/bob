import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

import { isCleanTree, PASS_RECORD } from './validate-attest.mjs';
import { visualSourcesChanged } from '../tools/visual-gate/flash-guard.mjs';

/*
 * validate.mjs — full pre-PR gate for the Bob monorepo.
 *
 * Runs: git whitespace checks (working tree + staged), a staged-ignored scan
 * (secrets.h, .env, data/, .pio), a secret-pattern scan of the staged diff,
 * strict typecheck across workspaces, the @bob/api Vitest suite, and the
 * Cardputer firmware step -- compile, host unit tests, memory budget, and the
 * Waveshare visual flash gate when round-UI sources changed --
 * (skipped with --skip-firmware). The web half also
 * runs deno check + deno test of the Supabase edge functions (skipped when deno
 * is not on PATH).
 *
 * --only=web|server runs one half, so CI can run the halves as parallel jobs:
 * `web` is everything that needs no database (scans, typecheck, ai + ui-v2
 * tests, the scripts tests); `server` is the Postgres-backed api suite.
 * A partial run
 * never compiles firmware and never records an attestation — only the full
 * gate can vouch for a tree.
 *
 * Exit behavior: all steps run; failures are collected and printed, then the
 * script exits 1 if any step failed, 0 otherwise.
 *
 * The credential scanner (secretPatterns / scanSecrets) is exported so the
 * scripts Vitest suite (`npm run test:scripts`) can exercise it. The gate body
 * below runs only when this file is the entry point, so importing the scanner
 * never re-runs the gate.
 */

// Repo root is one level above scripts/. On Windows the npm.cmd shim is
// required — spawnSync cannot resolve .cmd files without a shell.
const ROOT = resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const shell = process.platform === 'win32';
const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : null;
if (only !== null && only !== 'web' && only !== 'server') {
  console.error(`validate: --only must be web or server, got "${only}"`);
  process.exit(2);
}
const runWeb = only !== 'server';
const runServer = only !== 'web';
const skipFirmware = only !== null || process.argv.includes('--skip-firmware');
const py = (process.env.BOB_PY ?? (process.platform === 'win32' ? 'py -3.11' : 'python3')).split(' ');

// Credential-shaped content the staged-diff scan rejects. Kept as plain
// regexes so the CLI and the test suite share exactly one definition. The
// existing sk-or-v1- pattern stays even though OpenRouter is retired: it still
// catches an old key in a stale .env staged by accident.
// The single list of env names whose literal values are secrets. Add a name
// here, never a second named-env regex.
export const SECRET_ENV_NAMES = [
  'OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY', 'BOB_V2_HOST', 'BOB_WEB_TOKEN',
  'BOB_DATABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD', 'DEVICE_SHARED_SECRET', 'SMTP_PASS', 'SMTP_PASSWORD', 'BOB_SMTP_PASSWORD',
  'NOTIFY_EMAIL_SECRET', 'BOB_NOTIFY_EMAIL_SECRET',
  'SEND_EMAIL_HOOK_SECRET', 'WAITLIST_CODE_PEPPER', 'BOB_GOOGLE_BRIDGE_SECRET', 'BRAINTRUST_API_KEY',
  'LANGFUSE_SECRET_KEY', 'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'BOB_OTLP_EXTRA_TRACES_HEADERS', 'BOB_OTLP_EXTRA_LOGS_HEADERS', 'BOB_OTLP_EXTRA_METRICS_HEADERS',
];

// NAME=value with a real-looking literal. Exempt: placeholders, <...>
// segments, $ references (shell or CI) and loopback Postgres URLs.
const namedEnvPattern = new RegExp(
  `(?<![.\\w])(${SECRET_ENV_NAMES.join('|')})\\s*=[ \\t]*["']?` +
  `(?!your_|placeholder|example|<|\\$|postgres(?:ql)?:\\/\\/[^@]*@(?:127\\.0\\.0\\.1|localhost|\\[::1\\])[:/]|.*<[^>]*>)` +
  `[^\\s"'<]{16,}`,
);

const secretPatterns = [
  /sk-or-v1-[A-Za-z0-9]{16,}/,
  /vcst_[A-Za-z0-9_-]{16,}/,
  /vck_[A-Za-z0-9_-]{20,}/,
  /-----BEGIN (RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY/,
  /AKIA[0-9A-Z]{16}/,
  // sb_publishable_ keys are deliberately absent: they ship in the browser.
  /sb_secret_[A-Za-z0-9_-]{20,}/,
  /sbp_[a-f0-9]{40}/,
  /(?<![\w.])dp\.(?:st|ct|pt|sa)\.[A-Za-z0-9_.-]{20,}/,
  /olxd_[A-Za-z0-9_-]{43}\b/,
  /postgres(?:ql)?:\/\/[^:\s@\/]+:(?!your_|placeholder|example)[^@\s<>\[\]]{6,}@(?!(?:127\.0\.0\.1|localhost|\[::1\])[:/])/,
  namedEnvPattern,
];

// Pure scanner: returns the patterns (regex objects) that match a slice of
// text. Side-effect free so the test suite can assert fixtures directly.
export function scanSecrets(text) {
  return secretPatterns.filter((pattern) => pattern.test(text));
}

export { secretPatterns };

// Only run the gate when validate.mjs is executed directly, so the vitest
// suite can import scanSecrets without re-running the whole gate.
const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  const steps = [];
  const failed = [];

  // Run a labeled npm command from the repo root with inherited stdio; record
  // the step and fail the run when the command exits non-zero. On Windows the
  // npm.cmd shim requires a shell, otherwise spawnSync fails with EINVAL.
  function run(label, command, args, options = {}) {
    steps.push(label);
    process.stdout.write(`\n==> ${label}\n`);
    const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell, ...options });
    if (result.status !== 0) failed.push(label);
    return result.status === 0;
  }

  // Same as run(), for direct git invocations from the repo root.
  function runGit(label, args) {
    steps.push(label);
    process.stdout.write(`\n==> ${label}\n`);
    const result = spawnSync('git', args, { cwd: ROOT, stdio: 'inherit', shell: false });
    if (result.status !== 0) failed.push(label);
    return result.status === 0;
  }

  if (runWeb) {
    // Reject trailing whitespace / conflict markers in both the working tree and
    // the staged diff.
    runGit('git whitespace check (working tree)', ['diff', '--check']);
    runGit('git whitespace check (staged)', ['diff', '--cached', '--check']);

    // Fail when any staged file is gitignored — the usual suspects are secrets.h,
    // .env, data/, and .pio artifacts.
    const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: ROOT, encoding: 'utf8' });
    const stagedFiles = staged.stdout.split('\n').filter(Boolean);
    const ignoredStaged = stagedFiles.filter((file) =>
      spawnSync('git', ['check-ignore', '-q', '--', file], { cwd: ROOT }).status === 0);
    if (ignoredStaged.length > 0) {
      steps.push('no ignored files staged (secrets.h, .env, data/, .pio)');
      failed.push(`ignored files staged: ${ignoredStaged.join(', ')}`);
      console.error(`\nFAIL: gitignored files are staged: ${ignoredStaged.join(', ')}`);
    }

    // Scan the staged diff for credential-shaped content. In addition to the
    // legacy Gateway/OpenRouter keys, private key blocks, and AWS access keys,
    // this catches the feature-008 credential kinds: Supabase secret keys, Bob
    // device tokens, Postgres URLs with an inline password, and the new named env
    // vars bound to real-looking values.
    const stagedDiff = spawnSync('git', ['diff', '--cached'], { cwd: ROOT, encoding: 'utf8' }).stdout;
    const leaked = scanSecrets(stagedDiff);
    if (leaked.length > 0) {
      steps.push('no secrets in staged diff');
      failed.push(`secret pattern matched staged diff: ${leaked.map((p) => p.source).join(', ')}`);
      console.error(`\nFAIL: staged diff matches secret patterns (${leaked.length}).`);
    }

    // Typecheck across all workspaces and run the database-free suites. The CA
    // roots drift check runs with the web half — a rotated/removed root must
    // fail the gate even when the firmware build is skipped.
    run('CA roots drift check', 'node', [resolve(ROOT, 'apps/cardputer/scripts/gen-ca-roots.mjs'), '--check']);
    run('import boundaries', 'node', [resolve(ROOT, 'scripts/check-boundaries.mjs')]);
    run('dead code (knip)', npm, ['run', 'lint:dead']);
    run('doc paths', 'node', [resolve(ROOT, 'scripts/check-doc-paths.mjs')]);
    run('ui catalog', 'node', [resolve(ROOT, 'scripts/ui-catalog/check.mjs')]);
    run('marketing pack integrity', npm, ['run', 'check:marketing-pack']);
    run('skill front matter', 'node', [resolve(ROOT, 'scripts/check-skills.mjs')]);
    run('ios design consistency', 'node', [resolve(ROOT, 'scripts/check-ios-design.mjs')]);
    run('domain agents manifest', 'node', [resolve(ROOT, 'scripts/check-agents.mjs')]);
    run('code quality (complexity, typing, size, cycles)', 'node', [resolve(ROOT, 'scripts/check-quality.mjs')]);
    run('typecheck', npm, ['run', 'typecheck']);
    run('unit tests (ai)', npm, ['test', '--workspace', '@bob/ai']);
    run('unit tests (ui-v2)', npm, ['test', '--workspace', '@bob/ui-v2']);
    run('unit tests (scripts)', npm, ['run', 'test:scripts']);

    if (spawnSync('deno', ['--version'], { cwd: ROOT, stdio: 'ignore', shell }).status === 0) {
      // Keep Deno off the root package.json: the functions pin their own npm: imports.
      process.env.DENO_NO_PACKAGE_JSON = '1';
      const functionsDir = resolve(ROOT, 'supabase/functions');
      const entries = readdirSync(functionsDir)
        .map((name) => `supabase/functions/${name}/index.ts`)
        .filter((file) => existsSync(resolve(ROOT, file)));
      run('deno check (supabase functions)', 'deno', ['check', ...entries]);
      run('deno test (supabase functions)', 'deno', ['test', '--allow-read', '--allow-env', 'supabase/functions']);
    } else {
      process.stdout.write('\n==> deno check + test (supabase functions): SKIPPED, deno is not on PATH\n');
    }
  }

  // The api suite clones a Postgres template (createTestDb).
  if (runServer) {
    run('unit tests', npm, ['test', '--workspace', '@bob/api']);
  }
  // The firmware step: compile, then the host unit tests (real src/protocol.cpp
  // under ASan+UBSan; Docker's pinned gcc when no local compiler) and the
  // static memory budget, which re-reads the size summary of the build just
  // done (docs/cardputer/testing.md).
  if (!skipFirmware) {
    run('firmware compile', npm, ['run', 'device:compile']);
    run('firmware host tests', npm, ['run', 'test:firmware']);
    run('firmware memory budget', 'node', [resolve(ROOT, 'scripts/firmware-budget.mjs'), '--check']);
    // The Waveshare round UI must match the approved demo before it can be flashed (tools/visual-gate).
    const visual = visualSourcesChanged(ROOT);
    if (visual.length > 0 && !existsSync(resolve(ROOT, 'tools/bob-sim'))) {
      process.stdout.write('\n==> visual flash gate: SKIPPED, this checkout has no tools/bob-sim (no round-UI firmware)\n');
    } else if (visual.length > 0) {
      run('visual gate unit tests', py[0], [...py.slice(1), '-I', resolve(ROOT, 'tools/visual-gate/diff_test.py')], { shell: false });
      run(`visual flash gate (${visual.length} round-UI file(s) changed)`, 'node', [resolve(ROOT, 'tools/visual-gate/gate.mjs'), '--require']);
    }
  }

  // Summarize pass/fail; exit non-zero when any step failed.
  console.log(`\n==== validate: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${steps.length} steps) ====`);
  if (failed.length > 0) {
    console.error(`Failed steps:\n  - ${failed.join('\n  - ')}`);
    process.exit(1);
  }

  // Record the pass against the tree hash (content, not commit) so `npm run
  // attest` can tell GitHub this content already passed here and CI can skip
  // the suite it would otherwise repeat on a paid runner. CI's validate job
  // runs this same gate with --skip-firmware (the firmware job compiles), so a
  // --skip-firmware pass still covers everything that job would do. data/ is
  // gitignored, so the record never leaves the machine that earned it.
  // Only a clean working tree can be attested: HEAD's tree is then exactly the
  // content this run tested, and exactly what a push publishes. So the order is
  // commit, validate, push, attest.
  const porcelain = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: ROOT, encoding: 'utf8' });
  if (only !== null) {
    console.log(`Partial run (--only=${only}), so this pass was not recorded.`);
  } else if (!isCleanTree(porcelain.stdout)) {
    console.log('Uncommitted changes, so this pass was not recorded. Commit, re-run validate, push, then `npm run attest`.');
  } else if (tree.status === 0 && tree.stdout.trim()) {
    const file = resolve(ROOT, PASS_RECORD);
    mkdirSync(dirname(file), { recursive: true });
    const record = { tree: tree.stdout.trim(), at: new Date().toISOString(), firmware: !skipFirmware };
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    console.log('Recorded the pass. After pushing, run `npm run attest` so CI can skip this suite.');
  }
}
