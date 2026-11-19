#!/usr/bin/env node
/**
 * Code-quality gates (epic #611): the checks that keep the codebase easy to read,
 * change and debug. Run by `npm run validate` and `npm run check`.
 *
 *   ZERO rules   Biome lint rules that must have no violation at all (loose typing,
 *                assignments hidden in conditions, unused imports, ...).
 *   RATCHETS     Measured per file against scripts/quality-baseline.json: cognitive
 *                complexity over 15 per function, non-null assertions, unused
 *                variables, source files over 1,000 lines, import cycles. A count may
 *                fall but never rise, and a file that is not in the baseline starts at
 *                zero. A fallen count must be committed (`--update`), so it cannot
 *                creep back. `--update` refuses to raise a number without --allow-increase.
 *
 * Biome parses TypeScript itself (no dependency on the TypeScript compiler API) and
 * takes ~0.2 s over the whole repo. The TypeScript strictness flags live in
 * tsconfig.base.json and are checked by `npm run typecheck`.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecifier, specifiersOf } from './check-boundaries.mjs';
import { runBin } from './run-bin.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'scripts/quality-baseline.json');
const posix = (p) => p.split(sep).join('/');

export const MAX_FILE_LINES = 1000;
export const COMPLEXITY_MAX = 15;

/** Biome rules that must not fire at all. */
export const ZERO_RULES = [
  'noExplicitAny', 'noDoubleEquals', 'noImplicitAnyLet', 'noAssignInExpressions',
  'noUselessCatch', 'noFallthroughSwitchClause', 'noUnusedImports',
];
/** Biome rules whose per-file count may only fall. */
export const RATCHET_RULES = ['noExcessiveCognitiveComplexity', 'noNonNullAssertion', 'noUnusedVariables'];

const SIZE_EXEMPT = /(?:^|\/)(?:schemas|web-schemas)\.ts$|\.test\.[cm]?[jt]sx?$|\/tests?\//u;
const SIZE_ROOTS = ['apps/api/src', 'apps/ai/src', 'apps/ui-v2/src'];
const CYCLE_ROOTS = ['apps/api/src', 'apps/ai/src', 'apps/ui-v2/src'];
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/u;

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') yield* walk(full);
    } else if (SOURCE_EXT.test(entry.name)) yield full;
  }
}

/** `{ file: lines }` for source files over the limit. */
export function oversizedFiles(files, limit = MAX_FILE_LINES) {
  const out = {};
  for (const { path, text } of files) {
    if (SIZE_EXEMPT.test(path)) continue;
    const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
    if (lines > limit) out[path] = lines;
  }
  return out;
}

/** Import cycles as sorted, ` > `-joined member lists (strongly connected components of 2+ files). */
export function importCycles(files) {
  const known = new Set(files.map((f) => f.path));
  const graph = new Map();
  for (const { path, text } of files) {
    const edges = new Set();
    for (const spec of specifiersOf(text)) {
      if (!spec.startsWith('.')) continue;
      const base = resolveSpecifier(path, spec);
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
        if (known.has(candidate) && candidate !== path) { edges.add(candidate); break; }
      }
    }
    graph.set(path, [...edges]);
  }
  // Tarjan's strongly connected components.
  let counter = 0;
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [], cycles = [];
  const visit = (node) => {
    index.set(node, counter); low.set(node, counter); counter += 1;
    stack.push(node); onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) { visit(next); low.set(node, Math.min(low.get(node), low.get(next))); }
      else if (onStack.has(next)) low.set(node, Math.min(low.get(node), index.get(next)));
    }
    if (low.get(node) === index.get(node)) {
      const scc = [];
      let member;
      do { member = stack.pop(); onStack.delete(member); scc.push(member); } while (member !== node);
      if (scc.length > 1) cycles.push(scc.sort().join(' > '));
    }
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return cycles.sort();
}

/**
 * Compare measured `{ key: count }` against a baseline.
 * @returns {{ worse: string[]; better: string[] }} keys that rose (or are new) and keys that fell (or vanished)
 */
export function compareRatchet(current, baseline) {
  const worse = [], better = [];
  for (const [key, count] of Object.entries(current)) {
    const allowed = baseline[key] ?? 0;
    if (count > allowed) worse.push(`${key}: ${count} (baseline ${allowed})`);
    else if (count < allowed) better.push(`${key}: ${count} (baseline ${allowed})`);
  }
  for (const key of Object.keys(baseline)) if (!(key in current)) better.push(`${key}: 0 (baseline ${baseline[key]})`);
  return { worse, better };
}

/** Biome diagnostics grouped as `{ rule: { file: count } }`, plus the raw zero-rule hits. */
export function groupDiagnostics(diagnostics) {
  const counts = {};
  const zero = [];
  for (const d of diagnostics) {
    const rule = String(d.category ?? '').split('/').pop();
    // Biome prints native separators; the baseline is keyed by POSIX paths.
    const file = d.location?.path?.replaceAll('\\', '/');
    if (!file) continue;
    if (ZERO_RULES.includes(rule)) zero.push(`${file}:${d.location.start?.line ?? '?'}: ${rule}`);
    else if (RATCHET_RULES.includes(rule)) {
      counts[rule] ??= {};
      counts[rule][file] = (counts[rule][file] ?? 0) + 1;
    }
  }
  return { counts, zero };
}

function runBiome() {
  const result = runBin('@biomejs/biome', 'biome', ['lint', '--reporter=json', '--max-diagnostics=none'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  const start = result.stdout.indexOf('{');
  if (start < 0) throw new Error(`biome printed no JSON (exit ${result.status}): ${result.stderr.slice(0, 400)}`);
  return JSON.parse(result.stdout.slice(start)).diagnostics ?? [];
}

function readSources(roots) {
  const files = [];
  for (const root of roots) {
    for (const file of walk(join(ROOT, root))) {
      if (statSync(file).size > 0) files.push({ path: posix(relative(ROOT, file)), text: readFileSync(file, 'utf8') });
    }
  }
  return files;
}

/** Everything the gate measures now, in the baseline's shape. */
export function measure() {
  const { counts, zero } = groupDiagnostics(runBiome());
  const sources = readSources([...new Set([...SIZE_ROOTS, ...CYCLE_ROOTS])]);
  return {
    zero,
    measured: {
      biome: Object.fromEntries(RATCHET_RULES.map((rule) => [rule, sortKeys(counts[rule] ?? {})])),
      size: sortKeys(oversizedFiles(sources)),
      cycles: importCycles(sources),
    },
  };
}

const sortKeys = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1)));

function loadBaseline() {
  return existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : { biome: {}, size: {}, cycles: [] };
}

/** Failures and stale-baseline notes for a measurement against a baseline. */
export function evaluate(zero, measured, baseline) {
  const failures = zero.map((line) => `zero-tolerance rule: ${line}`);
  const stale = [];
  const groups = [
    ...RATCHET_RULES.map((rule) => [rule, measured.biome[rule] ?? {}, baseline.biome?.[rule] ?? {}]),
    [`file over ${MAX_FILE_LINES} lines`, measured.size, baseline.size ?? {}],
  ];
  for (const [name, current, base] of groups) {
    const { worse, better } = compareRatchet(current, base);
    failures.push(...worse.map((line) => `${name} rose: ${line}`));
    stale.push(...better.map((line) => `${name} fell: ${line}`));
  }
  const known = new Set(baseline.cycles ?? []);
  failures.push(...measured.cycles.filter((c) => !known.has(c)).map((c) => `new import cycle: ${c}`));
  stale.push(...(baseline.cycles ?? []).filter((c) => !measured.cycles.includes(c)).map((c) => `import cycle gone: ${c}`));
  return { failures, stale };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const { zero, measured } = measure();
  const baseline = loadBaseline();
  const { failures, stale } = evaluate(zero, measured, baseline);

  if (args.has('--update')) {
    const raised = failures.filter((line) => !line.startsWith('zero-tolerance'));
    if (raised.length > 0 && !args.has('--allow-increase')) {
      console.error(`refusing to raise the baseline (a number may only fall):\n  ${raised.join('\n  ')}\nFix the code, or pass --allow-increase with a reason in the PR.`);
      process.exit(1);
    }
    if (zero.length > 0) { console.error(`fix the zero-tolerance hits first:\n  ${zero.join('\n  ')}`); process.exit(1); }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(measured, null, 2)}\n`);
    console.log(`quality baseline written: ${Object.values(measured.biome).reduce((n, o) => n + Object.keys(o).length, 0)} biome file entries, ${Object.keys(measured.size).length} oversized files, ${measured.cycles.length} cycles`);
    return;
  }

  if (failures.length === 0 && stale.length === 0) {
    const total = (rule) => Object.values(measured.biome[rule] ?? {}).reduce((a, b) => a + b, 0);
    console.log(`quality: ok (over-complex functions ${total('noExcessiveCognitiveComplexity')}, non-null assertions ${total('noNonNullAssertion')}, unused variables ${total('noUnusedVariables')}, oversized files ${Object.keys(measured.size).length}, cycles ${measured.cycles.length}; all at or below baseline)`);
    return;
  }
  for (const line of failures) console.error(`quality: ${line}`);
  for (const line of stale) console.error(`quality: ${line}`);
  if (failures.length > 0) console.error('\nFix the code. Cognitive complexity: extract a function, use early returns, flatten nesting (limit 15 per function).');
  if (stale.length > 0) console.error('\nThe baseline is out of date because things improved. Run `node scripts/check-quality.mjs --update` and commit scripts/quality-baseline.json.');
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
