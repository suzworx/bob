import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUT_PATH, parseArgs, SCHEMA_PARTS, schemasSourceAt, snapshotSchemas, topLevelDeclarations } from './schema-snapshot.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const META = { ref: 'v9.9.9', sha: 'abc123', date: '2026-01-02' };

const SOURCE = [
  "import { z } from 'zod';",
  'export const V = 1 as const;',
  'export const Unused = 7;',
  '// Ids are opaque.',
  'const IdSchema = z.string();',
  '/** The hello. */',
  'const HelloSchema = z.object({',
  '  v: z.literal(V),',
  '  id: IdSchema, // not Unused',
  '}).strict();',
  'export type Hello = z.infer<typeof HelloSchema>;',
  'export function helper(): number { return Unused; }',
  "export const ClientControlDtoSchema = z.discriminatedUnion('type', [",
  '  HelloSchema,',
  ']);',
  '',
].join('\n');

describe('schema-snapshot: the closure of ClientControlDtoSchema', () => {
  it('splits top-level declarations with their comments and closing lines', () => {
    const decls = topLevelDeclarations(SOURCE);
    expect(decls.map((decl) => `${decl.kind}:${decl.name}`)).toEqual([
      'import:', 'const:V', 'const:Unused', 'const:IdSchema', 'const:HelloSchema', 'type:Hello',
      'function:helper', 'const:ClientControlDtoSchema',
    ]);
    expect(decls[4].comment).toBe('/** The hello. */');
    expect(decls[4].body.endsWith('}).strict();')).toBe(true);
    expect(decls[7].body.endsWith(']);')).toBe(true);
  });

  it('keeps only the consts the root reaches, in source order, exporting the root alone', () => {
    const text = snapshotSchemas(SOURCE, META);
    const body = text.slice(text.indexOf("import { z } from 'zod';"));
    expect(body).toBe([
      "import { z } from 'zod';",
      '',
      'const V = 1 as const;',
      '',
      '// Ids are opaque.',
      'const IdSchema = z.string();',
      '',
      '/** The hello. */',
      'const HelloSchema = z.object({',
      '  v: z.literal(V),',
      '  id: IdSchema, // not Unused',
      '}).strict();',
      '',
      "export const ClientControlDtoSchema = z.discriminatedUnion('type', [",
      '  HelloSchema,',
      ']);',
      '',
    ].join('\n'));
  });

  it('names the ref, sha and date in the header', () => {
    const text = snapshotSchemas(SOURCE, META);
    expect(text).toContain('v9.9.9 (abc123), snapshot taken 2026-01-02');
    expect(text).toContain('node scripts/release/schema-snapshot.mjs --ref <deployed tag>');
  });

  it('throws when the root schema is missing, never writing an empty snapshot', () => {
    expect(() => snapshotSchemas('const A = 1;\n', META)).toThrow(/ClientControlDtoSchema is not a top-level const/);
  });

  it('reads CRLF sources the same as LF', () => {
    expect(snapshotSchemas(SOURCE.replace(/\n/g, '\r\n'), META)).toBe(snapshotSchemas(SOURCE, META));
  });

  it('snapshots the current schemas.ts, hello version fields included', () => {
    const text = snapshotSchemas(SCHEMA_PARTS.map((part) => readFileSync(resolve(ROOT, part), 'utf8')).join('\n'), META);
    for (const name of ['HelloDtoSchema', 'FirmwareVersionSchema', 'INVALID_FW_VERSION', 'PairRequestDtoSchema']) {
      expect(text).toMatch(new RegExp(`^const ${name} =`, 'm'));
    }
    expect(text).not.toMatch(/ServerControlDtoSchema/);
  });
});

describe('schema-snapshot: arguments', () => {
  it('requires --ref', () => {
    expect(() => parseArgs([])).toThrow(/usage/);
  });

  it('rejects unknown or incomplete flags', () => {
    expect(() => parseArgs(['--ref', 'v1', '--bogus', 'x'])).toThrow(/unknown/);
    expect(() => parseArgs(['--ref'])).toThrow(/incomplete/);
  });

  it('takes --ref, --out and --date', () => {
    expect(parseArgs(['--ref', 'v1.2.3', '--out', 'x.ts', '--date', '2026-09-27']))
      .toEqual({ ref: 'v1.2.3', out: 'x.ts', date: '2026-09-27' });
  });
});

describe('schema-snapshot: the committed snapshot', () => {
  const committed = readFileSync(resolve(ROOT, OUT_PATH), 'utf8');
  const header = /^ \* (\S+) \(([0-9a-f]{40})\), snapshot taken (\d{4}-\d{2}-\d{2})\./m.exec(committed);
  const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024 });
  const available = header !== null && git(['cat-file', '-e', `${header[2]}^{commit}`]).status === 0;

  it('names a ref, a full sha and a date', () => {
    expect(header).not.toBeNull();
  });

  // Skipped only in a shallow clone that lacks the released commit.
  it.skipIf(!available)('is exactly what the script generates from that commit', () => {
    const [, ref, sha, date] = header;
    const source = schemasSourceAt(sha);
    expect(snapshotSchemas(source, { ref, sha, date }).replace(/\r\n/g, '\n')).toBe(committed.replace(/\r\n/g, '\n'));
  });
});
