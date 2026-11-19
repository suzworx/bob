import { existsSync, readFileSync } from 'node:fs';

/*
 * journal-privacy.mjs — the journal privacy scan (quickstart V11, spec 002
 * V12 / SC-010): no journal line may carry audio, a transcript, agent text, a
 * prompt or a credential. The one source of these rules: validate-non-device
 * scans its stub-turn journal with them, and the HIL runner scans the server
 * journal of every real device run.
 *
 * A finding names the line number and the rule, never the line itself, so the
 * report of a leak does not repeat the leak.
 */

/** Case-insensitive terms that must never appear in a journal line. */
export const RULES = [
  { name: 'transcript', term: 'transcript' },
  { name: 'prompt', term: 'prompt' },
  { name: 'bearer-credential', term: 'bearer' },
  { name: 'test-token', term: 'test-token' },
  { name: 'validation-user-text', term: 'hello from validation' },
  { name: 'stub-agent-text', term: 'System test response' },
  { name: 'stub-transcript-text', term: 'system test transcript' },
  { name: 'assistant-text', term: 'assistant' },
];

/**
 * Journal keys whose NAME contains a rule term but which hold no content, so
 * the name alone is not a finding. Their values are still scanned. Derived by
 * grepping the journal( calls in apps/api/src and docs/log-reference.md for
 * keys containing a rule term; keep each entry documented.
 */
export const METADATA_KEYS = new Set([
  // v2.turn_stage_agent_completed / web-chat turn done (#396/#413): which
  // system-prompt layout the turn used, the enum "cache-v1" | "legacy".
  'prompt_layout',
  // v2.turn_started and every device-turn event (assistant_name, #880): the assistant's display name the turn runs under ("bob" or "bob"),
  // a setting, never what the assistant said.
  'assistant_name',
]);

/** The texts of a parsed JSON value to scan, depth first: every string value,
 *  plus every key not in METADATA_KEYS (a key such as "transcript" or
 *  "prompt" names the payload it carries). Numbers, booleans and null cannot
 *  carry text. */
function jsonTexts(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) jsonTexts(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (!METADATA_KEYS.has(k)) out.push(k);
      jsonTexts(v, out);
    }
  }
  return out;
}

/** The texts of one journal line to scan: the keys and string values of a
 *  JSON line, or the whole line when it is not JSON. */
function scannedTexts(raw) {
  try {
    return jsonTexts(JSON.parse(raw));
  } catch {
    return [raw];
  }
}

/** Findings `{ line, rule }` (1-based line) for journal text or its lines.
 *  `extra` adds run-specific rules, e.g. the transcript a HIL run feeds in. */
export function scanJournal(text, { extra = [] } = {}) {
  const lines = Array.isArray(text) ? text : String(text).split(/\r?\n/);
  const rules = [...RULES, ...extra].map((r) => ({ name: r.name, term: r.term.toLowerCase() }));
  const findings = [];
  lines.forEach((raw, i) => {
    const texts = scannedTexts(raw).map((t) => t.toLowerCase());
    for (const rule of rules) {
      if (texts.some((t) => t.includes(rule.term))) findings.push({ line: i + 1, rule: rule.name });
    }
  });
  return findings;
}

/** scanJournal over a file. A missing journal has nothing to leak: []. */
export function scanJournalFile(path, options) {
  return existsSync(path) ? scanJournal(readFileSync(path, 'utf8'), options) : [];
}

/** One line per finding: `line N: rule R`. */
export function formatFindings(findings) {
  return findings.map((f) => `line ${f.line}: ${f.rule}`).join('\n');
}
