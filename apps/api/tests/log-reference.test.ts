// Journal drift gate (#521): every `v2.*` event the api journals must have a
// row in docs/log-reference.md, and every documented row must still be
// journaled somewhere, so the operator's reference cannot silently rot.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const SRC = join(ROOT, 'apps/api/src');
const DOC = join(ROOT, 'docs/log-reference.md');

// A journal call is `journal(...)` or an injected `log(...)` sink (memory
// callbacks, memory retrieval, the outbox worker), with optional chaining, or a
// source-scoped journal (`deviceJournal(...)`, `webJournal(event)(...)`).
const SINK = '(?:journal|log|deviceJournal|webJournal(?:\\([^)]*\\))?)';
const LITERAL_CALL = new RegExp(`\\b${SINK}\\??\\.?\\(\\s*(['"\\x60])(v2\\.[a-z0-9_.]+)\\1`, 'g');
const TEMPLATE_CALL = new RegExp(`\\b${SINK}\\??\\.?\\(\\s*\\x60(v2\\.[^\\x60]*\\$\\{[^\\x60]*)\\x60`, 'g');

// Dynamic event names, expanded by hand. `journalTurnStage` names each event
// after its TurnStage and TurnOutcome; these are the pairs actually emitted
// (`input` only completes empty or fails, it never journals `started`).
const DYNAMIC_EVENTS: Record<string, string[]> = {
  'v2.turn_stage_${event.stage}_${event.outcome}': [
    'v2.turn_stage_input_completed',
    'v2.turn_stage_input_failed',
    // `prep` brackets a device turn's agent prep; it never fails (#1331).
    'v2.turn_stage_prep_started',
    'v2.turn_stage_prep_completed',
    ...['stt', 'agent', 'tts'].flatMap((stage) =>
      ['started', 'completed', 'failed'].map((outcome) => `v2.turn_stage_${stage}_${outcome}`)),
  ],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/**
 * Drops whole comment lines so a docstring that names an event is not a call
 * site. Only whole lines: a string like '/api/*' would fool a block-comment
 * regex into swallowing real code.
 */
function stripComments(source: string): string {
  return source.replace(/^\s*(?:\/\/|\/\*|\*).*$/gm, '');
}

/** Every event name journaled in `sources`, mapped to the files that emit it. */
function emittedEvents(sources: Array<{ file: string; text: string }>): Map<string, Set<string>> {
  const events = new Map<string, Set<string>>();
  const add = (name: string, file: string): void => {
    const files = events.get(name) ?? new Set<string>();
    files.add(file);
    events.set(name, files);
  };
  for (const { file, text } of sources) {
    const code = stripComments(text);
    for (const [, , name = ''] of code.matchAll(LITERAL_CALL)) add(name, file);
    for (const [, template = ''] of code.matchAll(TEMPLATE_CALL)) {
      const expanded = DYNAMIC_EVENTS[template];
      if (expanded === undefined) {
        throw new Error(`${file}: dynamic journal event \`${template}\` has no DYNAMIC_EVENTS entry`);
      }
      for (const name of expanded) add(name, file);
    }
  }
  return events;
}

/** Event names in the first cell of each table row of the server journal sections. */
function documentedEvents(doc: string): Set<string> {
  const start = doc.indexOf('## Server journal');
  const end = doc.indexOf('## Device serial');
  const section = doc.slice(start, end);
  const names = new Set<string>();
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const firstCell = line.split('|')[1] ?? '';
    for (const [, name = ''] of firstCell.matchAll(/`(v2\.[a-z0-9_.]+)`/g)) names.add(name);
  }
  return names;
}

function loadSources(): Array<{ file: string; text: string }> {
  return sourceFiles(SRC).map((path) => ({
    file: relative(ROOT, path).replaceAll('\\', '/'),
    text: readFileSync(path, 'utf8'),
  }));
}

describe('docs/log-reference.md covers the journal', () => {
  const doc = readFileSync(DOC, 'utf8');
  const documented = documentedEvents(doc);
  const emitted = emittedEvents(loadSources());

  it('finds the journal sections and a realistic number of events', () => {
    expect(doc.indexOf('## Server journal')).toBeGreaterThan(-1);
    expect(doc.indexOf('## Device serial')).toBeGreaterThan(doc.indexOf('## Server journal'));
    expect(emitted.size).toBeGreaterThan(150);
    expect(documented.size).toBeGreaterThan(150);
  });

  it('documents every journaled event', () => {
    const undocumented = [...emitted.keys()]
      .filter((name) => !documented.has(name))
      .sort()
      .map((name) => `${name} (${[...(emitted.get(name) ?? [])].join(', ')})`);
    expect(undocumented, 'journal events missing from docs/log-reference.md').toEqual([]);
  });

  it('documents no event that is no longer journaled', () => {
    const stale = [...documented].filter((name) => !emitted.has(name)).sort();
    expect(stale, 'docs/log-reference.md rows for events nothing journals').toEqual([]);
  });

  it('fails naming a newly added undocumented event', () => {
    const fake = [{ file: 'apps/api/src/fake.ts', text: "journal('v2.fake_event', {});" }];
    const names = [...emittedEvents(fake).keys()];
    expect(names).toEqual(['v2.fake_event']);
    expect(documented.has('v2.fake_event')).toBe(false);
  });

  it('refuses a dynamic event name without an allowlist entry', () => {
    const fake = [{ file: 'apps/api/src/fake.ts', text: 'journal(`v2.fake_${kind}`, {});' }];
    expect(() => emittedEvents(fake)).toThrow('v2.fake_${kind}');
  });
});
