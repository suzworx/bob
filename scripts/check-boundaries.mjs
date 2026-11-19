#!/usr/bin/env node
/**
 * Import-boundary check (epic #611, story #613): the layering of apps/* is kept
 * by rules, not by convention. Run by `npm run validate` and `npm run check`.
 *
 * Every rule bans an importer -> target edge, and there are no exceptions: the
 * allowlist that let the epic land in steps was deleted in the close-out (#630).
 * platform/db/db.ts -> logger.ts style edges are not violations because no rule
 * bans platform dependencies. Workflows (apps/api/src/workflows/, see docs/workflows.md)
 * sit above the feature folders: nothing below the transport imports them, and they import
 * no route or the server.
 *
 * No dependency: a regex over import/export/dynamic-import specifiers, resolved
 * to repo-relative paths. `vi.mock` targets are not imports and are not scanned.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/u;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.pio', '.git', 'data', 'coverage', 'test-results', 'playwright-report']);

const posix = (p) => p.split(sep).join('/');
const API_SRC = 'apps/api/src/';
/** The web app's browser suite: test code, not shipped to the browser. */
const UI_E2E = 'apps/ui-v2/e2e/';
/** What the e2e suite may import from apps/api: the HTTP contract and the device wire contract. */
const E2E_API_CONTRACTS = new Set([`${API_SRC}web-schemas.ts`, `${API_SRC}voice/protocol.ts`]);
const WIRE = `${API_SRC}voice/protocol.ts`;
/** Workflows: one `workflow-<name>.ts` per cross-module orchestration (docs/workflows.md). */
const WORKFLOWS = `${API_SRC}workflows/`;
/** Root files directly in apps/api/src: the composition roots and the web-*.ts routes. */
const ROOT_FILE = /^apps\/api\/src\/[^/]+$/u;
const WEB_ROUTE = /^apps\/api\/src\/web-[^/]+\.ts$/u;
const DEVICE_SESSIONS = `${API_SRC}voice/device-sessions.ts`;
/** The composition roots: the only files that resolve the process-wide singletons. */
const ROOTS = new Set([`${API_SRC}server.ts`, `${API_SRC}app-deps.ts`]);
/** One level of feature folders under apps/api/src (docs/adr/0003-flat-feature-folders.md). */
const FEATURE_FILE = /^apps\/api\/src\/(?:account|devices|integrations|routines|spaces|conversations|memory|notifications|firmware|tasks|notes|calendar|reminders|timers|voice)\//u;
/** The voice transport: the session state machine and its handlers, the turn pipeline and the device socket. */
const VOICE_TRANSPORT = /^apps\/api\/src\/voice\/(?:session[^/]*\.ts|handle-[^/]+\.ts|turn\/.+|device-socket\.ts|http\.ts)$/u;
/** HTTP routers: http.ts and <part>-http.ts in a feature folder. */
const HTTP_FILE = /(?:\/|-)http\.ts$/u;
/** The layers below the transport: HTTP routers, the session state machine, the turn pipeline, the server. */
const TRANSPORT = (to) => /^apps\/api\/src\/(?:web-[^/]+|server)\.ts$/u.test(to) || VOICE_TRANSPORT.test(to);

/**
 * @typedef {{ id: string; why: string; applies: (from: string) => boolean;
 *   banned: (to: string, spec: string) => boolean }} Rule
 * @type {Rule[]}
 */
export const RULES = [
  {
    id: 'singletons-only-at-the-roots',
    why: 'getDb and getDeviceSessions may be imported only by the composition roots (server.ts, app-deps.ts) and their own modules; everything else receives them as arguments (AppDeps)',
    applies: (from) => from.startsWith(API_SRC) && !ROOTS.has(from) && from !== `${API_SRC}platform/db/db.ts` && from !== DEVICE_SESSIONS,
    banned: (to, spec, names) => (to === `${API_SRC}platform/db/db.ts` && names.includes('getDb'))
      || (to === DEVICE_SESSIONS && names.includes('getDeviceSessions')),
  },
  {
    id: 'platform-is-shared-infrastructure',
    why: 'apps/api/src/platform/** (db, logger, http middleware, observability, outbox) holds no domain logic: it may import only platform/** from apps/api/src, never a feature folder or a root file',
    applies: (from) => from.startsWith(`${API_SRC}platform/`),
    banned: (to) => to.startsWith(API_SRC) && !to.startsWith(`${API_SRC}platform/`),
  },
  {
    id: 'module-store-below-http',
    why: 'inside a feature folder only http.ts, <part>-http.ts and schemas.ts (in voice also the session, its handlers, turn/ and device-socket, which are its transport) may import the transport: every other file (store, service, tools, scheduler, fan-out, recurrence) must not import an HTTP router, web-*.ts, session, turn, server or (outside voice/) the device wire contract (protocol.ts)',
    applies: (from) => FEATURE_FILE.test(from) && !HTTP_FILE.test(from) && !from.endsWith('/schemas.ts') && !VOICE_TRANSPORT.test(from),
    banned: (to, spec, names, from) => TRANSPORT(to) || (FEATURE_FILE.test(to) && HTTP_FILE.test(to)) || (to === WIRE && !from.startsWith(`${API_SRC}voice/`)),
  },
  {
    id: 'api-uses-ai-public-api',
    why: 'apps/api must import apps/ai through @bob/ai (or @bob/ai/express, @bob/ai/testing), never a path into apps/ai/src',
    applies: (from) => from.startsWith('apps/api/'),
    banned: (to, spec) => to.startsWith('apps/ai/src/') || /(?:^|\/)ai\/src(?:\/|$)/u.test(spec),
  },
  {
    id: 'ai-is-pure',
    why: 'apps/ai must not import apps/api or a database driver (postgres)',
    applies: (from) => from.startsWith('apps/ai/'),
    banned: (to, spec) =>
      to.startsWith('apps/api/') || /^postgres(?:\/|$)/u.test(spec) || /^@bob\/api(?:\/|$)/u.test(spec),
  },
  {
    id: 'ui-only-web-schemas',
    why: 'apps/ui-v2 may import from apps/api only web-schemas.ts (the HTTP contract); its e2e suite has its own rule',
    applies: (from) => from.startsWith('apps/ui-v2/') && !from.startsWith(UI_E2E),
    banned: (to, spec) =>
      (to.startsWith('apps/api/') && to !== `${API_SRC}web-schemas.ts`) || /^@bob\/api(?:\/|$)/u.test(spec),
  },
  {
    id: 'e2e-only-public-contracts',
    why:
      'apps/ui-v2/e2e (never shipped) may import from apps/api only its two public contracts: web-schemas.ts (HTTP) and ' +
      'voice/protocol.ts (the device wire contract its fake Cardputer speaks); never the server internals',
    applies: (from) => from.startsWith(UI_E2E),
    banned: (to, spec) =>
      (to.startsWith('apps/api/') && !E2E_API_CONTRACTS.has(to)) || /^@bob\/api(?:\/|$)/u.test(spec),
  },
  {
    id: 'firmware-has-no-ts-imports',
    why: 'apps/cardputer has no TypeScript imports of other workspaces (its .mjs tooling scripts are not covered)',
    applies: (from) => from.startsWith('apps/cardputer/') && /\.tsx?$/u.test(from),
    banned: (to, spec) => (to.startsWith('apps/') && !to.startsWith('apps/cardputer/')) || /^@bob\//u.test(spec),
  },
  {
    id: 'features-never-import-workflows',
    why: 'a store, service, tool, scheduler or platform file never imports apps/api/src/workflows/: a capability that must call back takes a function injected by the trigger (the HTTP router, root module or transport that calls the workflow)',
    applies: (from) => from.startsWith(API_SRC) && !from.startsWith(WORKFLOWS) && !ROOT_FILE.test(from) && !HTTP_FILE.test(from) && !VOICE_TRANSPORT.test(from),
    banned: (to) => to.startsWith(WORKFLOWS),
  },
  {
    id: 'workflows-below-http',
    why: 'a workflow never imports a web-*.ts route, server.ts or a feature HTTP router: the trigger calls the workflow, so the workflow stays below the transport',
    applies: (from) => from.startsWith(WORKFLOWS),
    banned: (to) => WEB_ROUTE.test(to) || to === `${API_SRC}server.ts` || (FEATURE_FILE.test(to) && HTTP_FILE.test(to)),
  },
];

const IMPORT_RE =
  /(?:^|[\s;{}(])(?:import|export)\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?['"]([^'"\n]+)['"]|(?:^|[^\w.$])import\(\s*['"]([^'"\n]+)['"]\s*\)|require\(\s*['"]([^'"\n]+)['"]\s*\)/gmu;

/** Import specifiers in a source text (static, re-export, dynamic, require); comments are stripped first. */
export function specifiersOf(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/gu, '$1');
  const out = [];
  for (const match of code.matchAll(IMPORT_RE)) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

/** The names a file imports from one specifier (`import { a, type b as c } from 'spec'` -> ['a', 'b']). */
export function importedNames(text, spec) {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const names = [];
  for (const match of text.matchAll(new RegExp(`(?:import|export)\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+['"]${escaped}['"]`, 'gu'))) {
    for (const item of match[1].split(',')) {
      const name = item.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0].trim();
      if (name !== '') names.push(name);
    }
  }
  return names;
}

/** Repo-relative target of a relative specifier, or the bare specifier for a package. */
export function resolveSpecifier(from, spec) {
  if (!spec.startsWith('.')) return spec;
  return posix(relative(ROOT, normalize(join(ROOT, dirname(from), spec))));
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(join(dir, entry.name));
    } else if (SOURCE_EXT.test(entry.name)) yield join(dir, entry.name);
  }
}

/**
 * Violations in `files` ({ path, text }).
 * @returns {{ violations: Array<{ rule: Rule; from: string; to: string }> }}
 */
export function check(files, rules = RULES) {
  const violations = [];
  for (const { path, text } of files) {
    for (const spec of specifiersOf(text)) {
      const to = resolveSpecifier(path, spec);
      for (const rule of rules) {
        if (!rule.applies(path) || !rule.banned(to, spec, importedNames(text, spec), path)) continue;
        violations.push({ rule, from: path, to: to.startsWith('apps/') || spec.startsWith('.') ? to : spec });
      }
    }
  }
  return { violations };
}

function main() {
  const files = [];
  for (const workspace of readdirSync(join(ROOT, 'apps'), { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    for (const file of sourceFiles(join(ROOT, 'apps', workspace.name))) {
      files.push({ path: posix(relative(ROOT, file)), text: readFileSync(file, 'utf8') });
    }
  }
  const { violations } = check(files);
  if (violations.length === 0) {
    console.log(`import boundaries: ok (${files.length} files, ${RULES.length} rules, no exceptions)`);
    return;
  }
  for (const { rule, from, to } of violations) console.error(`boundary violation [${rule.id}]: ${from} -> ${to}\n  ${rule.why}`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
