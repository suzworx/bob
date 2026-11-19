import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { matchesGlob, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/*
 * check-agents.mjs — fail when .claude/domains.json stops giving every source
 * file exactly one owning domain agent.
 *
 * Each domain names its owns/tests globs (repo-relative, forward slashes,
 * matched with path.matchesGlob), skills, MCP servers, docs and gates. Parallel
 * units of work collide when owns overlap, so every tracked source file under
 * SOURCE_DIRS must match exactly one domain's owns.
 *
 * The check functions are pure and exported for the scripts Vitest suite
 * (`npm run test:scripts`); the CLI runs only when this file is the entry point.
 * `--manifest-only` runs the manifest and coverage checks alone.
 */

const ROOT = resolve(import.meta.dirname, '..');
const MANIFEST = '.claude/domains.json';
const SOURCE_DIRS = ['apps/ai/src', 'apps/api/src', 'apps/ui-v2/src', 'apps/cardputer/src', 'apps/cardputer/include', 'libs/bob-device'];
const EXCLUDED = [/\.test\.tsx?$/, /^apps\/cardputer\/include\/secrets\.h$/];
const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const STRING_FIELDS = ['name', 'summary'];
const LIST_FIELDS = ['owns', 'tests', 'skills', 'mcp', 'docs', 'gates'];

// Every field present with the right type.
function checkDomainFields(domain, at) {
  const problems = [];
  for (const field of STRING_FIELDS) {
    if (typeof domain?.[field] !== 'string') problems.push(`${at}: ${field} must be a string`);
  }
  for (const field of LIST_FIELDS) {
    const value = domain?.[field];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      problems.push(`${at}: ${field} must be an array of strings`);
    }
  }
  return problems;
}

// Names unique kebab-case; every field present with the right type.
export function checkManifest(manifest) {
  if (!Array.isArray(manifest?.domains)) return ['domains: must be an array'];
  const seen = new Set();
  return manifest.domains.flatMap((domain, index) => {
    const at = `domains[${index}]`;
    const problems = checkDomainFields(domain, at);
    const { name } = domain ?? {};
    if (typeof name === 'string') {
      if (!KEBAB.test(name)) problems.unshift(`${at}: name "${name}" is not kebab-case`);
      else if (seen.has(name)) problems.unshift(`${at}: name "${name}" is used more than once`);
      seen.add(name);
    }
    return problems;
  });
}

// Every file must match exactly one domain's owns globs.
export function checkCoverage(manifest, files) {
  const unowned = [];
  const doubleOwned = [];
  for (const file of files) {
    const owners = manifest.domains
      .filter((domain) => domain.owns.some((glob) => matchesGlob(file, glob)))
      .map((domain) => domain.name);
    if (owners.length === 0) unowned.push(file);
    else if (owners.length > 1) doubleOwned.push({ file, owners });
  }
  return { unowned, doubleOwned };
}

// installed: names of folders holding a SKILL.md.
export function checkSkills(manifest, installed) {
  const have = new Set(installed);
  return manifest.domains.flatMap((domain) => domain.skills
    .filter((skill) => !have.has(skill))
    .map((skill) => `${domain.name}: skill "${skill}" is not installed`));
}

// mcpJson: the parsed .mcp.json.
export function checkMcp(manifest, mcpJson) {
  const servers = mcpJson?.mcpServers ?? {};
  return manifest.domains.flatMap((domain) => domain.mcp
    .filter((server) => !Object.hasOwn(servers, server))
    .map((server) => `${domain.name}: mcp server "${server}" is not in .mcp.json`));
}

export function sourceFiles(root = ROOT) {
  const listed = spawnSync('git', ['ls-files', '-z', '--', ...SOURCE_DIRS], { cwd: root, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  return listed.stdout.split('\0').filter((file) => file && !EXCLUDED.some((pattern) => pattern.test(file)));
}

// Manifest + coverage on the tree; failures are "path: reason" lines.
export function checkRepo(root = ROOT) {
  const manifest = JSON.parse(readFileSync(resolve(root, MANIFEST), 'utf8'));
  const problems = checkManifest(manifest);
  if (problems.length > 0) return { domains: 0, files: 0, failures: problems.map((p) => `${MANIFEST}: ${p}`), manifest };
  const files = sourceFiles(root);
  const { unowned, doubleOwned } = checkCoverage(manifest, files);
  const failures = [
    ...unowned.map((file) => `${file}: owned by no domain`),
    ...doubleOwned.map(({ file, owners }) => `${file}: owned by more than one domain (${owners.join(', ')})`),
  ];
  return { domains: manifest.domains.length, files: files.length, failures, manifest };
}

// .claude/agents/ must hold exactly what scripts/gen-agents.mjs renders for every domain and role.
export async function checkAgents(manifest, agentsDir = resolve(ROOT, '.claude/agents')) {
  let generator;
  try {
    generator = await import(pathToFileURL(resolve(ROOT, 'scripts/gen-agents.mjs')).href);
  } catch {
    console.log('agents: generator not present, skipped');
    return [];
  }
  const { diffAgents, renderAll } = generator;
  const files = renderAll(manifest);
  // A CRLF checkout (core.autocrlf) differs only by CR: name that cause, not generic drift.
  const crOnly = (file) => readFileSync(resolve(agentsDir, file), 'utf8').replace(/\r/g, '') === files.get(file);
  return diffAgents(files, agentsDir).map((problem) => {
    const file = problem.slice(0, problem.indexOf(': '));
    if (problem.endsWith(': missing')) return `.claude/agents/${problem} (run npm run gen:agents)`;
    if (crOnly(file)) return `.claude/agents/${file}: contains CR characters (LF expected; see .gitattributes)`;
    return `.claude/agents/${problem}`;
  });
}

const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  const { domains, files, failures, manifest } = checkRepo();
  if (!process.argv.includes('--manifest-only') && domains > 0) {
    const skillsRoot = resolve(homedir(), '.claude/skills');
    if (existsSync(skillsRoot)) {
      const installed = readdirSync(skillsRoot).filter((name) => existsSync(resolve(skillsRoot, name, 'SKILL.md')));
      failures.push(...checkSkills(manifest, installed).map((p) => `${MANIFEST}: ${p}`));
    } else console.log('agents: ~/.claude/skills not present, skill check skipped');
    const mcpPath = resolve(ROOT, '.mcp.json');
    if (existsSync(mcpPath)) {
      failures.push(...checkMcp(manifest, JSON.parse(readFileSync(mcpPath, 'utf8'))).map((p) => `${MANIFEST}: ${p}`));
    } else console.log('agents: .mcp.json not present, mcp check skipped');
    failures.push(...await checkAgents(manifest));
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log(`agents: ok (${domains} domains, ${files} files)`);
}
