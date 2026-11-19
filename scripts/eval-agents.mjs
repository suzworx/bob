import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/*
 * eval-agents.mjs — score the domain agents (.claude/agents/bob-*.md) on replayed historical fixes.
 *
 * Each task in evals/agents/tasks/<agent>/<id>.json names a real single-domain fix commit. The agent starts
 * from its parent with the commit's tests hidden, gets the task in words, and is scored by applying the
 * hidden tests and running the task's gates. `--dry` validates the tasks and prints the planned runs.
 *
 * The pure functions are exported for the scripts Vitest suite (`npm run test:scripts`); the CLI runs only
 * when this file is the entry point. It is a measurement, not a gate: failing tasks still exit 0.
 */

const ROOT = resolve(import.meta.dirname, '..');
const TASKS_DIR = join(ROOT, 'evals/agents/tasks');
const RESULTS_DIR = join(ROOT, 'evals/agents/results');
const HEADINGS = ['## PLAN', '## CHANGES', '## GATES RUN', '## EVIDENCE', '## RISKS', '## Findings outside owns:'];
const AGENT_CONFIG = ['.claude/agents', '.claude/domains.json', '.claude/skills/bob-dev', '.mcp.json'];
const PROMPT_SUFFIX = '\n\nFollow your contract; end with the report headings.';
const MODEL = 'claude-opus-5-5';
const TIMEOUT_MS = 30 * 60 * 1000;
const FIELDS = { id: 'string', agent: 'string', commit: 'string', base: 'string', prompt: 'string', maxBudgetUsd: 'number' };

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const domainOf = (manifest, agent) => manifest.domains.find((domain) => `bob-${domain.name}` === agent);
const tail = (text, lines = 40) => text.split('\n').slice(-lines).join('\n');

// Every task file under dir/<agent>/, optionally filtered by agent name and task id.
export function loadTasks(dir = TASKS_DIR, { agent, task } = {}) {
  return readdirSync(dir).filter((name) => !agent || name === agent).sort()
    .flatMap((name) => readdirSync(join(dir, name)).filter((file) => file.endsWith('.json')).sort()
      .map((file) => JSON.parse(readFileSync(join(dir, name, file), 'utf8'))))
    .filter((loaded) => !task || loaded.id === task);
}

// Git lookups against this repo's history; validateTask takes fakes in the unit tests.
export const GIT_LOOKUPS = {
  resolveCommit: (rev) => git(ROOT, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).status === 0,
  hasFile: (commit, path) => git(ROOT, ['cat-file', '-e', `${commit}:${path}`]).status === 0,
};

// Returns one message per problem, [] when the task is runnable. checkHistory: false checks only the schema and the
// agent, for a shallow clone (CI) where the task's commits are absent.
export function validateTask(task, manifest, { resolveCommit, hasFile, checkHistory = true } = GIT_LOOKUPS) {
  const problems = Object.entries(FIELDS)
    .filter(([field, type]) => typeof task[field] !== type)
    .map(([field, type]) => `${field} must be a ${type}`);
  for (const field of ['hiddenTests', 'gates']) {
    if (!Array.isArray(task[field]) || task[field].length === 0) problems.push(`${field} must be a non-empty array`);
  }
  if (problems.length > 0) return problems;
  if (!domainOf(manifest, task.agent)) problems.push(`unknown agent "${task.agent}"`);
  if (!checkHistory) return problems;
  if (!resolveCommit(task.base)) problems.push(`base "${task.base}" does not resolve`);
  for (const file of task.hiddenTests.filter((path) => !hasFile(task.commit, path))) {
    problems.push(`hidden test ${file} does not exist in ${task.commit}`);
  }
  return problems;
}

// Scores one run: 1 when the gates pass inside owns, 0.5 when they pass but files outside owns changed, else 0.
export function scoreRun({ changedFiles, domain, gateResults, resultText, costUsd, turns }) {
  const globs = [...domain.owns, ...domain.tests];
  const outsideOwns = changedFiles.filter((file) => !globs.some((glob) => posix.matchesGlob(file, glob)));
  const gatesPass = gateResults.length > 0 && gateResults.every((gate) => gate.exitCode === 0);
  const lines = new Set(String(resultText ?? '').split('\n').map((line) => line.trim()));
  const ownsRespected = outsideOwns.length === 0;
  return {
    gatesPass,
    ownsRespected,
    outsideOwns,
    reportFormat: HEADINGS.every((heading) => lines.has(heading)),
    costUsd,
    turns,
    score: gatesPass ? (ownsRespected ? 1 : 0.5) : 0,
  };
}

// summary.md: one table per agent, then totals.
export function renderSummary(results) {
  const yes = (value) => (value ? 'yes' : 'no');
  const agents = [...new Set(results.map((result) => result.agent))].sort();
  const sections = agents.map((agent) => [
    `## ${agent}`, '', '| task | score | gates | owns | report | cost | turns |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...results.filter((result) => result.agent === agent).map((result) => (result.error
      ? `| ${result.id} | 0 | error: ${result.error.split('\n')[0]} | | | | |`
      : `| ${result.id} | ${result.score} | ${yes(result.gatesPass)} | ${yes(result.ownsRespected)} | ` +
        `${yes(result.reportFormat)} | $${(result.costUsd ?? 0).toFixed(2)} | ${result.turns ?? '?'} |`)),
    '',
  ].join('\n'));
  const sum = (key) => results.reduce((total, result) => total + (result[key] ?? 0), 0);
  const forced = results.filter((result) => result.worktreeForced).map((result) => result.id);
  return [
    '# Agent eval summary', '', ...sections,
    '## Totals', '', `- tasks: ${results.length}`, `- score: ${sum('score')} / ${results.length}`,
    `- cost: $${sum('costUsd').toFixed(2)}`, `- turns: ${sum('turns')}`,
    ...(forced.length > 0 ? [`- worktrees removed with --force (dirty after the run): ${forced.join(', ')}`] : []),
    '',
  ].join('\n');
}

const TS_IMPORT = /^\s*import\s+(?:type\s+)?([\w$\s{},*]+?)\s+from\s+['"](\.[^'"]+)['"]/gm;
// Only explicitly relative includes: a bare "doctest.h" may resolve through an -I path, not the test's folder.
const C_INCLUDE = /^\s*#\s*include\s+"(\.\.?\/[^"]+)"/gm;
const C_SOURCE = /\.(c|cc|cpp|h|hpp)$/;
const QUALIFIED = /\b([A-Za-z_]\w*)::([A-Za-z_]\w*)/g;

// Names one TS import clause brings in: 'default' for a default import, '*' for a namespace.
function importedNames(clause) {
  const braces = /\{([^}]*)\}/.exec(clause);
  const outside = clause.replace(/\{[^}]*\}/, '').split(',').map((part) => part.trim()).filter(Boolean);
  const names = outside.map((part) => (part.startsWith('*') ? '*' : 'default'));
  for (const part of braces ? braces[1].split(',') : []) {
    const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
    if (name) names.push(name);
  }
  return names;
}

// Merges { module, names } entries by module, keeping first-seen order.
function mergeModules(entries) {
  const modules = new Map();
  for (const { module, names } of entries) modules.set(module, [...new Set([...(modules.get(module) ?? []), ...names])]);
  return [...modules].map(([module, names]) => ({ module, names }));
}

// The namespace-qualified identifiers a C/C++ test uses that symbolExists(member) says are new: bob::name as
// `name`, any other Scope::member as written. std:: is never new.
function newSymbols(testText, symbolExists) {
  return [...new Set([...testText.matchAll(QUALIFIED)]
    .filter(([, scope, member]) => scope !== 'std' && !symbolExists(member))
    .map(([, scope, member]) => (scope === 'bob' ? member : `${scope}::${member}`)))];
}

// The repo-relative modules a test imports or #includes that do not exist yet (exists(path) is false),
// with the names it imports from each. Only relative specifiers count; packages and <system> headers never do.
// A C/C++ test also gets its new qualified symbols, filed under the first missing include, else "(new symbol)".
export function extractInterface(testText, testPath, exists, symbolExists = () => true) {
  const resolveSpec = (spec) => posix.normalize(posix.join(posix.dirname(testPath), spec));
  const entries = [
    ...[...testText.matchAll(TS_IMPORT)].map(([, clause, spec]) => ({ module: resolveSpec(spec), names: importedNames(clause) })),
    ...[...testText.matchAll(C_INCLUDE)].map(([, spec]) => ({ module: resolveSpec(spec), names: [] })),
  ];
  const missing = mergeModules(entries.filter(({ module }) => !exists(module)));
  const symbols = C_SOURCE.test(testPath) ? newSymbols(testText, symbolExists) : [];
  if (symbols.length === 0) return missing;
  return mergeModules([...missing, { module: missing[0]?.module ?? '(new symbol)', names: symbols }]);
}

// The interface a task's hidden tests use: read at `commit`, missing at `base`. Hidden tests themselves don't
// count, and neither does a symbol another hidden file (a test shim) mentions, since the checkout restores it.
export function taskInterface(task, root = ROOT) {
  const texts = new Map(task.hiddenTests.map((test) => [test, git(root, ['show', `${task.commit}:${test}`]).stdout]));
  const exists = (path) => task.hiddenTests.includes(path) ||
    git(root, ['cat-file', '-e', `${task.base}:${path}`]).status === 0;
  const atBase = new Map();
  const inBase = (name) => {
    if (!atBase.has(name)) {
      atBase.set(name, git(root, ['grep', '-q', '-w', '-e', name, task.base, '--', 'apps/cardputer']).status === 0);
    }
    return atBase.get(name);
  };
  // Hidden support files (test shims) come back whole with the checkout, so only real tests name symbols.
  const isTest = (path) => /(^|\/)test_[^/]*$|\.test\./.test(path);
  return mergeModules([...texts].flatMap(([test, text]) => {
    const inOtherHidden = (name) => [...texts].some(([other, body]) => other !== test && new RegExp(`\\b${name}\\b`).test(body));
    const symbolExists = isTest(test) ? (name) => inOtherHidden(name) || inBase(name) : () => true;
    return extractInterface(text, test, exists, symbolExists);
  }));
}

const interfaceLines = (modules) => modules.map(({ module, names }) => (names.length > 0 ? `${module}: ${names.join(', ')}` : module));

// Changed paths from `git diff --numstat` (run with --ignore-cr-at-eol, so a line-ending-only rewrite is 0/0)
// plus untracked files, without the copied agent config and the hidden tests removed here.
export function parseChangedFiles(numstat, untracked, task) {
  const skip = (file) => AGENT_CONFIG.some((path) => file === path || file.startsWith(`${path}/`)) ||
    task.hiddenTests.includes(file);
  const tracked = numstat.split('\n').map((line) => line.split('\t'))
    .filter((columns) => columns.length === 3 && !(columns[0] === '0' && columns[1] === '0'))
    .map((columns) => columns[2]);
  const added = untracked.split('\n').map((line) => line.trim()).filter(Boolean);
  return [...tracked, ...added].filter((file) => !skip(file));
}

function changedFiles(dir, task) {
  const numstat = git(dir, ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false',
    'diff', '--ignore-cr-at-eol', '--numstat', '--no-renames', 'HEAD']).stdout;
  const untracked = git(dir, ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard']).stdout;
  return parseChangedFiles(numstat, untracked, task);
}

// Hides the tests, copies today's agent config in, and installs dependencies when the worktree has none.
function prepareWorktree(dir, task, root) {
  for (const file of task.hiddenTests) rmSync(join(dir, file), { force: true });
  for (const path of AGENT_CONFIG.filter((config) => existsSync(join(root, config)))) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(root, path), join(dir, path), { recursive: true });
  }
  if (existsSync(join(dir, 'node_modules'))) return;
  const install = spawnSync('npm ci --prefer-offline', { cwd: dir, shell: true, encoding: 'utf8' });
  if (install.status !== 0) throw new Error(`npm ci failed: ${tail(install.stderr ?? '', 5)}`);
}

// The task in words, plus the interface the hidden tests use, so the agent can meet it without seeing them.
function promptFor(task, modules) {
  if (modules.length === 0) return task.prompt + PROMPT_SUFFIX;
  return `${task.prompt}\n\nInterface the acceptance tests will use (create or keep exactly these):\n` +
    `${interfaceLines(modules).join('\n')}${PROMPT_SUFFIX}`;
}

// Replays one task in a detached worktree at its base and scores the agent's change. Spends real money.
export function runTask(task, { manifest, root = ROOT } = {}) {
  const domain = domainOf(manifest, task.agent);
  const dir = join(mkdtempSync(join(tmpdir(), 'bob-eval-')), task.id);
  const added = git(root, ['worktree', 'add', '--detach', dir, task.base]);
  if (added.status !== 0) throw new Error(`git worktree add failed: ${added.stderr.trim()}`);
  let run;
  try {
    prepareWorktree(dir, task, root);
    const modules = taskInterface(task, root);
    const claude = spawnSync('claude', [
      '-p', promptFor(task, modules), '--agent', task.agent, '--model', MODEL, '--output-format', 'json',
      '--permission-mode', 'bypassPermissions', '--max-budget-usd', String(task.maxBudgetUsd),
    ], { cwd: dir, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    let output = {};
    try {
      output = JSON.parse(claude.stdout);
    } catch {
      output = {};
    }
    const changed = changedFiles(dir, task);
    const checkout = git(dir, ['checkout', task.commit, '--', ...task.hiddenTests]);
    if (checkout.status !== 0) throw new Error(`hidden test checkout failed: ${checkout.stderr.trim()}`);
    const gateResults = task.gates.map((command) => {
      const gate = spawnSync(command, { cwd: dir, shell: true, encoding: 'utf8', timeout: TIMEOUT_MS });
      return { command, exitCode: gate.status ?? -1, tail: tail(`${gate.stdout ?? ''}${gate.stderr ?? ''}`) };
    });
    run = {
      id: task.id, agent: task.agent, commit: task.commit,
      claudeExitCode: claude.status ?? -1, timedOut: claude.error?.code === 'ETIMEDOUT',
      ...scoreRun({
        changedFiles: changed, domain, gateResults, resultText: output.result,
        costUsd: output.total_cost_usd ?? 0, turns: output.num_turns ?? 0,
      }),
      changedFiles: changed, gateResults, interface: modules,
    };
  } finally {
    // The worktree is always dirty here (copied config, the agent's edits), so plain remove is tried first
    // and --force is recorded in the result and summary.md when it was needed.
    const forced = git(root, ['worktree', 'remove', dir]).status !== 0 &&
      git(root, ['worktree', 'remove', '--force', dir]).status === 0;
    rmSync(dirname(dir), { recursive: true, force: true });
    if (run) run.worktreeForced = forced;
  }
  return run;
}

// One --dry line per task, then the interface its prompt will carry, so it can be checked before spending.
function printPlan(task, withHistory) {
  console.log(`plan ${task.agent} ${task.id}: worktree at ${task.base}, hide ${task.hiddenTests.length} test(s), ` +
    `budget $${task.maxBudgetUsd}, gates: ${task.gates.join(' ; ')}`);
  if (!withHistory) {
    console.log('  interface (unknown: the task commit is not in this clone)');
    return;
  }
  const lines = interfaceLines(taskInterface(task));
  for (const line of lines.length > 0 ? lines : ['(none: the hidden tests use only modules that exist at base)']) {
    console.log(`  interface ${line}`);
  }
}

// A shallow clone (CI's default checkout) or a missing task commit has no history to check against.
function historyAvailable(tasks) {
  const shallow = git(ROOT, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true';
  const available = new Map(tasks.map((task) => [task.id, !shallow && GIT_LOOKUPS.resolveCommit(String(task.commit))]));
  if ([...available.values()].includes(false)) console.log('history checks skipped (shallow clone)');
  return available;
}

function main(argv) {
  const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const manifest = JSON.parse(readFileSync(join(ROOT, '.claude/domains.json'), 'utf8'));
  const tasks = loadTasks(TASKS_DIR, { agent: option('--agent'), task: option('--task') });
  const history = historyAvailable(tasks);
  const failures = tasks.flatMap((task) =>
    validateTask(task, manifest, { ...GIT_LOOKUPS, checkHistory: history.get(task.id) })
      .map((problem) => `${task.id}: ${problem}`));
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    return 1;
  }
  if (argv.includes('--dry')) {
    for (const task of tasks) printPlan(task, history.get(task.id));
    console.log(`eval-agents: ${tasks.length} tasks valid (dry run, nothing executed)`);
    return 0;
  }
  const out = join(RESULTS_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(out, { recursive: true });
  const results = [];
  for (const task of tasks) {
    let result;
    try {
      result = runTask(task, { manifest });
    } catch (error) {
      result = { id: task.id, agent: task.agent, commit: task.commit, error: error.message, score: 0 };
    }
    writeFileSync(join(out, `${task.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
    results.push(result);
  }
  writeFileSync(join(out, 'summary.md'), renderSummary(results));
  console.log(`eval-agents: ${results.length} tasks run, results in ${out}`);
  return 0;
}

const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) process.exit(main(process.argv.slice(2)));
