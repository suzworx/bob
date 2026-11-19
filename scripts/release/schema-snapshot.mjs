import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/*
 * schema-snapshot.mjs — freezes the client-message schemas of the RELEASED
 * server (test-gap class C, docs/testing/test-strategy.md §7).
 *
 *   node scripts/release/schema-snapshot.mjs --ref <deployed tag or ref>
 *
 * Reads apps/api/src/schemas.ts at the ref with `git show` (a local object, no
 * network), keeps ClientControlDtoSchema and every top-level const it needs,
 * in source order, and writes apps/api/tests/compat/released-schemas.ts.
 * apps/api/tests/voice/wire-compat.test.ts parses every firmware-emitted message
 * under it, so new firmware that production would refuse fails CI.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
export const SCHEMAS_PATH = 'apps/api/src/voice/protocol.ts';
/** Where the voice folder lived at older refs (modules/voice/ from #626 until the flatten). */
const VOICE_DIRS = ['apps/api/src/voice/', 'apps/api/src/modules/voice/'];
/** Where the wire contract lived at older refs (before the voice module, #626). */
const LEGACY_SCHEMAS_PATH = 'apps/api/src/schemas.ts';

/** Files split out of protocol.ts whose consts the wire contract reaches; absent at older refs. */
const SCHEMA_FILES = ['protocol.ts', 'protocol-base.ts', 'protocol-ota.ts'];
export const SCHEMA_PARTS = SCHEMA_FILES.map((file) => `${VOICE_DIRS[0]}${file}`);

/** The wire contract source at a commit, wherever it lived then (parts joined). */
export function schemasSourceAt(sha) {
  const show = (path) => git(['show', `${sha}:${path}`]);
  const tryShow = (path) => {
    try {
      return show(path);
    } catch {
      return null;
    }
  };
  for (const dir of VOICE_DIRS) {
    const main = tryShow(`${dir}${SCHEMA_FILES[0]}`);
    if (main === null) continue;
    const parts = SCHEMA_FILES.slice(1).map((file) => tryShow(`${dir}${file}`) ?? '');
    return [main, ...parts].join('\n');
  }
  return show(LEGACY_SCHEMAS_PATH);
}
export const OUT_PATH = 'apps/api/tests/compat/released-schemas.ts';
export const ROOTS = ['ClientControlDtoSchema'];

const DECL_RE = /^(?:export\s+)?(const|let|type|interface|function|class|enum|import)\b\s*([A-Za-z_$][\w$]*)?/;
const IDENT_RE = /[A-Za-z_$][\w$]*/g;

// Top-level statements of a module, each with the comment lines just above
// it. A statement runs until the next line that starts at column 0 with a
// declaration or a comment; closing lines (`});`, `]);`) stay with it.
export function topLevelDeclarations(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const decls = [];
  let comment = [];
  let current = null;
  for (const line of lines) {
    const match = DECL_RE.exec(line);
    const isComment = /^(\/\/|\/\*|\s\*)/.test(line);
    if (match) {
      current = { kind: match[1], name: match[2] ?? '', comment, body: [line] };
      decls.push(current);
      comment = [];
    } else if (isComment && (current === null || /^(\/\/|\/\*)/.test(line) || comment.length > 0)) {
      comment.push(line);
      current = null;
    } else if (current !== null && line.trim() !== '') {
      current.body.push(line);
    } else if (line.trim() === '') {
      current = null;
      comment = [];
    }
  }
  return decls.map((decl) => ({ ...decl, body: decl.body.join('\n'), comment: decl.comment.join('\n') }));
}

// The source of `roots` and every top-level const they reach, in source order.
// Throws when a root is missing, so a renamed schema never snapshots empty.
export function snapshotSchemas(source, { ref, sha, date, roots = ROOTS }) {
  const consts = topLevelDeclarations(source).filter((decl) => decl.kind === 'const');
  const byName = new Map(consts.map((decl) => [decl.name, decl]));
  for (const root of roots) {
    if (!byName.has(root)) throw new Error(`${root} is not a top-level const in ${SCHEMAS_PATH} at ${ref}`);
  }
  const needed = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop();
    if (needed.has(name)) continue;
    needed.add(name);
    const body = byName.get(name).body.replace(/\/\/.*$/gm, '').replace(/^[^=]*=/, '');
    for (const ident of body.match(IDENT_RE) ?? []) {
      if (byName.has(ident) && !needed.has(ident)) queue.push(ident);
    }
  }
  const blocks = consts.filter((decl) => needed.has(decl.name)).map((decl) => {
    const body = decl.body.replace(/^export\s+/, '');
    const exported = roots.includes(decl.name) ? `export ${body}` : body;
    return decl.comment ? `${decl.comment}\n${exported}` : exported;
  });
  return [
    '/**',
    ` * FROZEN client-message schemas of the RELEASED server: ${SCHEMAS_PATH} at`,
    ` * ${ref} (${sha}), snapshot taken ${date}. Generated; do not edit.`,
    ' * Refresh at each release with:',
    ' *   node scripts/release/schema-snapshot.mjs --ref <deployed tag>',
    ' * Read by tests/voice/wire-compat.test.ts (docs/testing/test-strategy.md §7).',
    ' */',
    "import { z } from 'zod';",
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n');
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export function parseArgs(argv) {
  const options = { ref: undefined, out: OUT_PATH, date: new Date().toLocaleDateString('en-CA') }; // local YYYY-MM-DD
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!['--ref', '--out', '--date'].includes(key) || argv[i + 1] === undefined) throw new Error(`unknown or incomplete argument: ${key}`);
    options[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  if (!options.ref) throw new Error('usage: schema-snapshot.mjs --ref <deployed tag or ref> [--out <path>] [--date YYYY-MM-DD]');
  return options;
}

export function main(argv) {
  const options = parseArgs(argv);
  const sha = git(['rev-parse', '--verify', `${options.ref}^{commit}`]).trim();
  const source = schemasSourceAt(sha);
  const text = snapshotSchemas(source, { ref: options.ref, sha, date: options.date });
  mkdirSync(dirname(resolve(ROOT, options.out)), { recursive: true });
  writeFileSync(resolve(ROOT, options.out), text);
  console.log(`[schema-snapshot] ${options.ref} (${sha.slice(0, 7)}) -> ${options.out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[schema-snapshot] ${error.message}`);
    process.exit(1);
  }
}
