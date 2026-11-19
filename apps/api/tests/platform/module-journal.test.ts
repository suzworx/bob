// Module guard: every file under apps/api/src/<module>/ journals through its own
// `moduleJournal('<module>')`, so each log line carries the module that wrote it.
// Top-level files (server.ts, startup.ts, ...) are the `server` module.
// Workflow files (workflows/workflow-*.ts) journal as the feature they orchestrate, and the shared turn code (turn/*.ts)
// as the surface it serves (voice or conversations), so their tag may be any existing module.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../../src');
const LOGGER_FILE = 'platform/logger.ts';
const LOGGER_IMPORT = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'[^']*\/logger(?:\.ts)?';/g;
const MODULE_CALL = /\bmoduleJournal\(\s*(['"`])([^'"`]*)\1(?:\s*,\s*(['"`])([^'"`]*)\3)?/g;
/** Source-scoped journals (device events, browser telemetry) name the module their source maps to, not the file's folder. */
const SOURCE_SCOPED = new Set(['device', 'web']);
/** Every module a workflow file may journal as: each top-level folder under src, plus `server`. */
const MODULES = new Set([
  ...readdirSync(SRC, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  'server',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** The module a file belongs to: its first folder under src, or `server` at the top level. */
function moduleOf(file: string): string {
  const parts = file.split('/');
  return parts.length === 1 ? 'server' : (parts[0] ?? 'server');
}

/** Problems with how `text` (the file at src-relative `file`) uses the journal. */
function violations(file: string, text: string): string[] {
  if (file === LOGGER_FILE) return [];
  const problems: string[] = [];
  for (const [, names = ''] of text.matchAll(LOGGER_IMPORT)) {
    if (names.split(',').some((name) => /^\s*journal(\s+as\s+\w+)?\s*$/.test(name))) {
      problems.push(`${file}: imports the bare journal; use const journal = moduleJournal('${moduleOf(file)}')`);
    }
  }
  for (const [, , name = '', , source] of text.matchAll(MODULE_CALL)) {
    const ownModule = name === moduleOf(file);
    const workflowTag = (file.startsWith('workflows/') || file.startsWith('turn/')) && MODULES.has(name);
    if (!ownModule && !workflowTag && !(source !== undefined && SOURCE_SCOPED.has(source))) {
      problems.push(`${file}: moduleJournal('${name}') is not this file's module '${moduleOf(file)}'`);
    }
  }
  return problems;
}

describe('per-module journal tags', () => {
  const files = sourceFiles(SRC).map((path) => ({
    file: relative(SRC, path).split(sep).join('/'),
    text: readFileSync(path, 'utf8'),
  }));

  it('scans a realistic number of files', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter(({ text }) => text.includes('moduleJournal(')).length).toBeGreaterThan(50);
  });

  it('keeps every module file on its own moduleJournal', () => {
    expect(files.flatMap(({ file, text }) => violations(file, text))).toEqual([]);
  });

  it('fails a module file that imports the bare journal', () => {
    expect(violations('voice/x.ts', "import { journal } from '../platform/logger.ts';")).toHaveLength(1);
    expect(violations('server.ts', "import { journal as log, moduleJournal } from './platform/logger.ts';")).toHaveLength(1);
    expect(violations('voice/x.ts', "import { moduleJournal } from '../platform/logger.ts';\nconst journal = moduleJournal('voice');")).toEqual([]);
  });

  it('fails a module name that is not the file\'s own folder', () => {
    expect(violations('voice/x.ts', "const journal = moduleJournal('timers');")).toHaveLength(1);
    expect(violations('startup.ts', "const journal = moduleJournal('server');")).toEqual([]);
    expect(violations('startup.ts', "const journal = moduleJournal('platform');")).toHaveLength(1);
    expect(violations('voice/x.ts', "const device = moduleJournal('devices', 'device');")).toEqual([]);
  });

  it('lets a workflow file journal as an existing module it orchestrates', () => {
    expect(violations('workflows/workflow-x.ts', "const journal = moduleJournal('reminders');")).toEqual([]);
    expect(violations('workflows/workflow-x.ts', "const journal = moduleJournal('server');")).toEqual([]);
    expect(violations('workflows/workflow-x.ts', "const journal = moduleJournal('nope');")).toHaveLength(1);
    expect(violations('reminders/fanout.ts', "const journal = moduleJournal('workflows');")).toHaveLength(1);
  });
});
