// Mechanical component registry for apps/ui-v2 (Babel parser; the repo's TypeScript 7 has no JS API).
// For every React component (capitalised function/const that returns JSX) records file:line, size,
// the Astryx and local components it renders, and who renders it. Also lists every Astryx module
// in the installed @astryxdesign/core and where it is used. Output is deterministic (no timestamps, sorted).
// Usage: node scripts/ui-catalog/registry.mjs [--write]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;

export const REGISTRY_FILE = path.join(ROOT, 'docs/ui-v2/ux-catalog/registry.json');
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (xs) => [...new Set(xs)].sort(byText);
const tagName = (n) => (n.type === 'JSXIdentifier' ? n.name : n.type === 'JSXMemberExpression' ? n.object.name : null);

// One file's imports, capitalised JSX tag counts and top-level components. `file` is relative to apps/ui-v2.
export function parseSource(file, code) {
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const imports = {};
  const tagCounts = {};
  const comps = [];
  traverse(ast, {
    ImportDeclaration(p) {
      const spec = p.node.source.value;
      const kind = spec.startsWith('@astryxdesign/core') ? 'astryx' : spec.startsWith('.') || spec.startsWith('@/') ? 'local' : 'other';
      const mod = kind === 'astryx' ? spec.replace('@astryxdesign/core/', '').split('/')[0] : spec;
      for (const s of p.node.specifiers) {
        const imported = s.type === 'ImportSpecifier' ? (s.imported.name ?? s.imported.value) : 'default';
        imports[s.local.name] = { kind, mod, imported, spec };
      }
    },
    JSXOpeningElement(p) {
      const t = tagName(p.node.name);
      if (t && /^[A-Z]/.test(t)) tagCounts[t] = (tagCounts[t] || 0) + 1;
    },
  });
  for (const st of ast.program.body) {
    const decl = st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration' ? st.declaration : st;
    const exported = st !== decl;
    for (const [name, node] of namedDeclarations(decl)) {
      if (!/^[A-Z]/.test(name)) continue;
      const { hasJsx, tags } = jsxTags(node);
      if (hasJsx) comps.push({ name, file, line: node.loc.start.line, lines: node.loc.end.line - node.loc.start.line + 1, exported, tags });
    }
  }
  return { imports, tagCounts, comps };
}

// [name, node] for a top-level function or each const initialiser.
function namedDeclarations(decl) {
  if (decl?.type === 'FunctionDeclaration' && decl.id) return [[decl.id.name, decl]];
  if (decl?.type !== 'VariableDeclaration') return [];
  return decl.declarations.filter((d) => d.id.type === 'Identifier' && d.init).map((d) => [d.id.name, d.init]);
}

// Whether a node contains JSX, and the capitalised tags it opens (in order, repeats kept).
function jsxTags(node) {
  const tags = [];
  let hasJsx = false;
  traverse(node, {
    noScope: true,
    JSXElement() { hasJsx = true; },
    JSXFragment() { hasJsx = true; },
    JSXOpeningElement(p) {
      const t = tagName(p.node.name);
      if (t && /^[A-Z]/.test(t)) tags.push(t);
    },
  }, null, {});
  return { hasJsx, tags };
}

// Adds one file's Astryx imports and JSX uses to the per-module tally.
function tallyAstryx(astryx, file, imports, tagCounts) {
  for (const imp of Object.values(imports)) if (imp.kind === 'astryx' && astryx[imp.mod]) astryx[imp.mod].files.push(file);
  for (const [t, n] of Object.entries(tagCounts)) {
    const imp = imports[t];
    if (imp?.kind !== 'astryx' || !astryx[imp.mod]) continue;
    astryx[imp.mod].jsx += n;
    astryx[imp.mod].names.push(imp.imported === 'default' ? t : imp.imported);
  }
}

const compKey = (f, n) => `${f}#${n}`;

// The component a local import names, trying the usual extension and index forms.
function resolveImport(byKey, fromFile, imp) {
  const base = imp.spec.startsWith('@/') ? path.posix.join('src', imp.spec.slice(2)) : path.posix.join(path.posix.dirname(fromFile), imp.spec);
  for (const cand of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
    const hit = byKey[compKey(cand, imp.imported)];
    if (hit) return hit;
  }
  return null;
}

// Marks every component that `c` renders as rendered by it (local imports and same-file components).
function linkRendered(byKey, imports, c) {
  for (const t of new Set(c.tags)) {
    const imp = imports[t];
    let target = null;
    if (imp?.kind === 'local') target = resolveImport(byKey, c.file, imp);
    else if (!imp) target = byKey[compKey(c.file, t)];
    if (target && target !== c) target.renderedBy.add(`${c.name} (${c.file})`);
  }
}

function linkValues(byKey, file, imports, code) {
  const body = code.replace(/^import[\s\S]*?;$/gm, '');
  for (const [localName, imp] of Object.entries(imports)) {
    if (imp.kind !== 'local') continue;
    const target = resolveImport(byKey, file, imp);
    if (target && new RegExp(`\\b${localName}\\b(?!\\s*[=:]?\\s*>)`).test(body.replace(new RegExp(`<\\/?${localName}\\b`, 'g'), ''))) target.renderedBy.add(`${file} (as value)`);
  }
}

// Pure: sources is { 'src/…/x.tsx': code }, astryxModules the installed module names.
export function buildRegistry(sources, { astryxModules = [], astryxVersion = 'unknown' } = {}) {
  const astryx = Object.fromEntries(astryxModules.map((m) => [m, { files: [], jsx: 0, names: [] }]));
  const info = Object.fromEntries(Object.entries(sources).map(([file, code]) => [file, { ...parseSource(file, code), code }]));
  for (const [file, { imports, tagCounts }] of Object.entries(info)) tallyAstryx(astryx, file, imports, tagCounts);

  // Who renders whom.
  const byKey = {};
  for (const { comps } of Object.values(info)) for (const c of comps) byKey[compKey(c.file, c.name)] = { ...c, renderedBy: new Set() };
  for (const c of Object.values(byKey)) linkRendered(byKey, info[c.file].imports, c);
  // Values passed around (lazy pages, render props): a local import used outside JSX.
  for (const [file, { imports, code }] of Object.entries(info)) linkValues(byKey, file, imports, code);

  return {
    astryxVersion,
    astryx: Object.fromEntries(Object.keys(astryx).sort(byText).map((m) => [m, { files: sorted(astryx[m].files), jsx: astryx[m].jsx, names: sorted(astryx[m].names) }])),
    bob: Object.values(byKey).map((c) => {
      const imps = info[c.file].imports;
      return {
        name: c.name, file: c.file, line: c.line, lines: c.lines, exported: c.exported,
        astryx: sorted(c.tags.filter((t) => imps[t]?.kind === 'astryx').map((t) => imps[t].mod)),
        local: sorted(c.tags.filter((t) => !imps[t] || imps[t].kind === 'local')),
        renderedBy: sorted(c.renderedBy),
      };
    }).sort((a, b) => byText(a.file, b.file) || a.line - b.line),
  };
}

// An installed package's folder, found the way Node resolves it (nearest node_modules upward).
export function packageDir(name, from = ROOT) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const cand = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(cand, 'package.json'))) return cand;
    if (path.dirname(dir) === dir) throw new Error(`${name} is not installed; run npm ci`);
  }
}

// Reads apps/ui-v2/src (tests excluded) and the installed @astryxdesign/core, then builds.
export function loadRegistry(root = ROOT) {
  const uiRoot = path.join(root, 'apps/ui-v2');
  const coreDir = packageDir('@astryxdesign/core', root);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : /\.tsx?$/.test(d.name) ? [p] : [];
  });
  const sources = {};
  for (const f of walk(path.join(uiRoot, 'src'))) {
    const rel = path.relative(uiRoot, f).replace(/\\/g, '/');
    // LF everywhere, so a CRLF checkout builds the same registry as CI.
    if (!/\.test\.|\/test\/|__tests__/.test(rel)) sources[rel] = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  }
  const dist = path.join(coreDir, 'dist');
  const astryxModules = fs.readdirSync(dist).filter((n) => /^[A-Z]/.test(n) && fs.statSync(path.join(dist, n)).isDirectory());
  const astryxVersion = JSON.parse(fs.readFileSync(path.join(coreDir, 'package.json'), 'utf8')).version;
  return buildRegistry(sources, { astryxModules, astryxVersion });
}

export const serialize = (registry) => `${JSON.stringify(registry, null, 2)}\n`;

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const registry = loadRegistry();
  const used = Object.values(registry.astryx).filter((v) => v.files.length).length;
  if (process.argv.includes('--write')) fs.writeFileSync(REGISTRY_FILE, serialize(registry));
  console.log(`astryx ${registry.astryxVersion}: ${Object.keys(registry.astryx).length} modules, ${used} used`);
  console.log(`bob: ${registry.bob.length} components (${registry.bob.filter((c) => c.exported).length} exported)`);
}
