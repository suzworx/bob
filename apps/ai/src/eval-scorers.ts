/**
 * Deterministic eval scorers for the Bob voice-reply rules (spec 009, D4).
 *
 * Each function returns the Braintrust scorer shape `{ name, score }` with
 * `score` in 0..1, and is also usable directly as a plain score function.
 * These are pure functions: no I/O and no config imports, so the voice-reply
 * suite (apps/ai/evals/voice-reply.eval.ts) can score fixtures anywhere.
 */

export interface ScorerResult {
  name: string;
  score: number;
}

/**
 * The voice-reply character cap, mirroring the production rule
 * `MAX_TTS_INPUT_CHARS` (default 700) and `capSpeechInput`'s inclusive
 * `text.length <= limit` counting (apps/ai/src/tools.ts).
 */
export const VOICE_REPLY_MAX_CHARS = 700;

const SENTENCE_ENDERS = new Set(['.', '!', '?']);
/** ASCII and typographic closing quotes, which may follow a sentence ender. */
const CLOSING_QUOTES = new Set(['"', "'", '\u201D', '\u2019']);
/** Common English stopwords used by the isEnglish heuristic. */
const ENGLISH_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'is', 'it', 'you',
  'that', 'with', 'for', 'on', 'at', 'this', 'are', 'be', 'have', 'has',
  'was', 'were', 'not', 'as', 'by', 'from', 'we', 'he', 'she', 'they', 'do',
  'does', 'did', 'will', 'can', 'your', 'my', 'our', 'so', 'if', 'then',
  'there', 'here', 'all', 'one', 'what', 'when', 'where', 'which', 'how',
]);

/** True when `output`'s last non-space character is a sentence ender. */
function endsAtSentenceBoundary(output: string): boolean {
  const trimmed = output.trimEnd();
  const last = trimmed.at(-1);
  if (last === undefined) return false;
  if (SENTENCE_ENDERS.has(last)) return true;
  if (!CLOSING_QUOTES.has(last)) return false;
  const before = trimmed.at(-2);
  return before !== undefined && SENTENCE_ENDERS.has(before);
}

/** True when `output` contains any markdown syntax the voice rules forbid. */
function containsMarkdown(output: string): boolean {
  const headingRe = /^\s*#/m;
  const bulletRe = /^\s*(?:[-*] |\d+\. )/m;
  const linkRe = /\[[^\]]*\]\([^)]*\)/;
  return (
    output.includes('**') ||
    output.includes('__') ||
    output.includes('`') ||
    headingRe.test(output) ||
    bulletRe.test(output) ||
    linkRe.test(output)
  );
}

/** 1 when the reply fits the voice cap (≤ 700 chars), else 0. */
export function lengthCap700(output: string): ScorerResult {
  return { name: 'lengthCap700', score: output.length <= VOICE_REPLY_MAX_CHARS ? 1 : 0 };
}

/** 1 when the reply ends at a sentence boundary (. ! ? or a closing quote after one), else 0. */
export function endsAtSentence(output: string): ScorerResult {
  return { name: 'endsAtSentence', score: endsAtSentenceBoundary(output) ? 1 : 0 };
}

/** Refusal phrasing: "I can't tell you…", "I don't have access…", "I can only…". */
const REFUSAL_RE = /\b(?:I\s+(?:can(?:'|\u2019|no)t|cannot|am unable to|'m unable to|am not able to|'m not able to|can only)|I\s+(?:do not|don(?:'|\u2019)t) have access)\b/i;
/** Offering a tool in place of an answer:"…but I can help you set a reminder". */
const TOOL_OFFER_RE = /\b(?:I can|I could|I'll|want me to|shall I)\b[^.?!]*\b(?:set|create|add)\s+(?:a|an)\s+(?:reminder|timer|alarm|task|note)\b/i;

/** 1 when an advice reply answers directly, 0 when it refuses or only offers a reminder, timer, task or note. */
export function answersDirectly(output: string): ScorerResult {
  const refuses = REFUSAL_RE.test(output) || TOOL_OFFER_RE.test(output);
  return { name: 'answersDirectly', score: refuses ? 0 : 1 };
}

/** 1 when the reply contains no markdown (bold, code, headings, bullets, links), else 0. */
export function noMarkdown(output: string): ScorerResult {
  return { name: 'noMarkdown', score: containsMarkdown(output) ? 0 : 1 };
}

const LIST_LINE_RE = /^\s*(?:[-*] |\d+\. )/;
const FENCED_BLOCK_RE = /```[\s\S]*?```/;

/** True when `output` has a markdown list (2+ list-marker lines) or a fenced code block. */
function hasStructure(output: string): boolean {
  if (FENCED_BLOCK_RE.test(output)) return true;
  const listLines = output.split('\n').filter((line) => LIST_LINE_RE.test(line)).length;
  return listLines >= 2;
}

/** 1 when the reply has markdown structure (a 2+ line list or a fenced block) exactly when `expectsStructure`, else 0. */
export function usesStructure(output: string, expectsStructure: boolean): ScorerResult {
  const structured = hasStructure(output);
  return { name: 'usesStructure', score: structured === expectsStructure ? 1 : 0 };
}

/** Phrasing that leaks the underlying model's identity instead of staying in character as Bob. */
const IDENTITY_LEAK_RE = /language model|\bLLM\b|google|gemini|trained by/i;

/** 0 when the reply leaks the underlying model's identity, else 1. */
export function noIdentityLeak(output: string): ScorerResult {
  return { name: 'noIdentityLeak', score: IDENTITY_LEAK_RE.test(output) ? 0 : 1 };
}

/** Real Bob abilities a capability reply should name, grouped so a plural or a close synonym still counts once. */
const ABILITY_CATEGORY_RES: RegExp[] = [
  /\breminders?\b/i,
  /\btimers?\b/i,
  /\btasks?\b/i,
  /\bnotes?\b/i,
  /\b(?:calendar|agenda)s?\b/i,
  /\bmemor(?:y|ies)\b|\bremember(?:ing)?\b/i,
  /\bgames?\b/i,
  /\b(?:space|spaces|family|families)\b/i,
  /\bvolume\b/i,
];
/** Generic-LLM capability claims a real capability reply should not make. */
const GENERIC_LLM_CLAIM_RE = /vast knowledge|translate|poem|creative content/i;

/** 1 when the reply names 2 or more real abilities and makes none of the generic-LLM claims above, else 0. */
export function namesRealAbilities(output: string): ScorerResult {
  const realAbilityHits = ABILITY_CATEGORY_RES.filter((re) => re.test(output)).length;
  const genericClaim = GENERIC_LLM_CLAIM_RE.test(output);
  return { name: 'namesRealAbilities', score: realAbilityHits >= 2 && !genericClaim ? 1 : 0 };
}

/**
 * Dependency-free English heuristic: passes when at least 90% of the letters
 * are ASCII AND at least 15% of the words are common English stopwords.
 * Both signals together separate English from near-alphabetic text such as
 * Spanish or French, which mostly share the ASCII alphabet but not the
 * stopword distribution.
 */
export function isEnglish(output: string): ScorerResult {
  const asciiLetters = (output.match(/[a-zA-Z]/g) ?? []).length;
  const letters = (output.match(/\p{L}/gu) ?? []).length;
  const words = output.toLowerCase().split(/[^\p{L}]+/u).filter((word) => word.length > 0);
  const asciiRatio = letters === 0 ? 0 : asciiLetters / letters;
  const stopwordHits = words.filter((word) => ENGLISH_STOPWORDS.has(word)).length;
  const stopwordRate = words.length === 0 ? 0 : stopwordHits / words.length;
  const score = asciiRatio >= 0.9 && stopwordRate >= 0.15 ? 1 : 0;
  return { name: 'isEnglish', score };
}

/** Fraction of expected tool names present in the actual call; 1 when nothing is expected. */
export function toolNameMatch(expected: string[], actual: string[]): ScorerResult {
  const matched = expected.filter((name) => actual.includes(name)).length;
  const score = expected.length === 0 ? 1 : matched / expected.length;
  return { name: 'toolNameMatch', score };
}

/**
 * A Braintrust scorer result whose score may be null: Braintrust skips a null
 * score, so a scorer that does not apply to a fixture leaves the mean alone.
 */
export interface OptionalScorerResult {
  name: string;
  score: number | null;
}

/** One tool call as the tool-selection scorers read it. */
export interface ToolCallLike {
  toolName: string;
  input: unknown;
}

/**
 * 1 when the first tool called equals `expected[0]`, or when nothing is
 * expected and nothing was called; else 0. Pass the first step's calls only.
 */
export function firstToolMatch(expected: string[], calls: string[]): ScorerResult {
  const first = expected[0];
  const score = first === undefined ? (calls.length === 0 ? 1 : 0) : (calls[0] === first ? 1 : 0);
  return { name: 'firstToolMatch', score };
}

/** On a no-tool fixture: 1 when nothing was called, 0 on any call. Null when a tool is expected. */
export function noToolFalseCall(expected: string[], calls: string[]): OptionalScorerResult {
  const score = expected.length > 0 ? null : (calls.length === 0 ? 1 : 0);
  return { name: 'noToolFalseCall', score };
}

/** Normalises a scalar for comparison: trimmed lower-case strings, numeric strings as numbers. */
function normaliseArg(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim().toLowerCase();
  return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : text;
}

/** Deep equality over normalised scalars, arrays and plain objects. */
function argEquals(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length
      && expected.every((item, i) => argEquals(item, actual[i]));
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
    const record = actual as Record<string, unknown>;
    return Object.entries(expected).every(([key, value]) => argEquals(value, record[key]));
  }
  return normaliseArg(expected) === normaliseArg(actual);
}

/** True when `expected` is `{ anyOf: [...] }`: any one listed value passes. */
function isAnyOf(expected: unknown): expected is { anyOf: unknown[] } {
  return typeof expected === 'object' && expected !== null && !Array.isArray(expected)
    && Object.keys(expected).length === 1 && Array.isArray((expected as { anyOf?: unknown }).anyOf);
}

/**
 * Fraction of the listed args matched by the first call of each listed tool.
 * Only the listed parameters are checked; a value `{ anyOf: [...] }` accepts
 * any one of its entries. A listed tool that was not called scores its keys 0.
 * Null when the fixture lists no args.
 */
export function toolArgsMatch(
  expectedArgs: Record<string, Record<string, unknown>> | undefined,
  calls: ToolCallLike[],
): OptionalScorerResult {
  let total = 0;
  let matched = 0;
  for (const [toolName, params] of Object.entries(expectedArgs ?? {})) {
    const call = calls.find((c) => c.toolName === toolName);
    const input = typeof call?.input === 'object' && call.input !== null ? call.input as Record<string, unknown> : {};
    for (const [key, want] of Object.entries(params)) {
      total += 1;
      if (call === undefined) continue;
      const ok = isAnyOf(want) ? want.anyOf.some((v) => argEquals(v, input[key])) : argEquals(want, input[key]);
      if (ok) matched += 1;
    }
  }
  return { name: 'toolArgsMatch', score: total === 0 ? null : matched / total };
}

/** 0 when any `create_*` tool is called more than once in the turn (all steps), else 1. */
export function overCall(calls: string[]): ScorerResult {
  const creates = calls.filter((name) => name.startsWith('create_'));
  return { name: 'overCall', score: new Set(creates).size === creates.length ? 1 : 0 };
}

/**
 * An expected stored memory in a fixture: a `kind` and a case-insensitive
 * substring the extracted content must contain (spec 010, FR-014 / SC-001).
 */
interface ExpectedMemory {
  kind: string;
  content_contains: string;
}

/** A content-bearing memory op as a scorer input (kind + content); noop has
 *  no content and is ignored by extraction accuracy. Kept local so
 *  eval-scorers.ts stays free of config imports (agents.ts / memory-extractor). */
interface MemoryOpLike {
  kind: string;
  content: string;
}
export type { MemoryOpLike };

/** Narrowing guard: an op counts as a memory when it carries content. */
function isMemoryOp(op: unknown): op is MemoryOpLike {
  return typeof op === 'object' && op !== null && 'kind' in op && 'content' in op;
}

/**
 * Extraction accuracy (spec 010, R7 / SC-001): F1 in 0..1 over `kind` and
 * `content_contains` between the ground-truth `expected` memories and the
 * memories produced by the extractor's `actual` ops. A predicted memory is a
 * true positive when it shares `kind` with an expected memory AND its content
 * contains that expected memory's `content_contains` substring (case-
 * insensitive). Ops without content (noop) are ignored. When nothing is
 * expected and nothing was stored the result is perfect (1); a spurious store
 * or a missed memory drives F1 toward 0. Pure and deterministic.
 */
export function extractionAccuracy(expected: ExpectedMemory[], actual: MemoryOpLike[]): number {
  const predicted = actual.filter(isMemoryOp);
  const matchedExpected = new Set<number>();
  const matchedPredicted = new Set<number>();
  for (let p = 0; p < predicted.length; p += 1) {
    const item = predicted[p];
    if (item === undefined) continue;
    const content = item.content.toLowerCase();
    for (let e = 0; e < expected.length; e += 1) {
      const mem = expected[e];
      if (mem === undefined || matchedExpected.has(e) || matchedPredicted.has(p)) continue;
      if (item.kind === mem.kind && content.includes(mem.content_contains.toLowerCase())) {
        matchedExpected.add(e);
        matchedPredicted.add(p);
      }
    }
  }
  const tp = matchedPredicted.size;
  if (expected.length === 0 && predicted.length === 0) return 1;
  const precision = predicted.length === 0 ? 0 : tp / predicted.length;
  const recall = expected.length === 0 ? 0 : tp / expected.length;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/** An op as the reconciliation scorers read it: the op type and, except for add, the target memory id. */
interface MemoryOpRef {
  op: string;
  id?: string | undefined;
}

/**
 * False add: on a fixture that expects no memories, 1 when the ops contain any `add`, else 0.
 * Lower is better; the mean over the no-op group is the false-add rate.
 */
export function falseAddRate(expectedMemories: ExpectedMemory[], ops: MemoryOpRef[]): ScorerResult {
  const falseAdd = expectedMemories.length === 0 && ops.some((op) => op.op === 'add');
  return { name: 'falseAddRate', score: falseAdd ? 1 : 0 };
}

/**
 * Reconciliation correctness: 1 when the op types and target ids match
 * `expectedOps`, else 0. An expected update or supersede needs an op of that
 * type on that id. An expected noop is met by an explicit noop or by leaving
 * the id untouched. Fails when an id gets a different op than expected, when
 * an update or supersede hits an id nothing expects, or when the number of
 * adds differs from expected (e.g. a duplicate add instead of reconciling).
 */
export function reconciliationCorrect(expectedOps: MemoryOpRef[], ops: MemoryOpRef[]): ScorerResult {
  const expectedById = new Map<string, string>();
  for (const want of expectedOps) {
    if (want.id !== undefined) expectedById.set(want.id, want.op);
  }
  const expectedAdds = expectedOps.filter((want) => want.op === 'add').length;
  const actualAdds = ops.filter((op) => op.op === 'add').length;
  let ok = actualAdds === expectedAdds;
  for (const [id, wantOp] of expectedById) {
    const onId = ops.filter((op) => op.op !== 'add' && op.id === id);
    if (wantOp === 'noop') {
      ok &&= onId.every((op) => op.op === 'noop');
    } else {
      ok &&= onId.length > 0 && onId.every((op) => op.op === wantOp);
    }
  }
  for (const op of ops) {
    if ((op.op === 'update' || op.op === 'supersede') && (op.id === undefined || !expectedById.has(op.id))) {
      ok = false;
    }
  }
  return { name: 'reconciliationCorrect', score: ok ? 1 : 0 };
}

/**
 * Recall precision (spec 010, R7 / SC-001): the fraction of retrieved memory
 * contents that are judged relevant — a retrieved item is relevant when its
 * content contains (case-insensitively) at least one of `expectedContains`.
 * Pure and deterministic; 0 when nothing was retrieved.
 */
export function recallPrecision(retrievedContents: string[], expectedContains: string[]): number {
  if (retrievedContents.length === 0) return 0;
  const needles = expectedContains.map((n) => n.toLowerCase());
  const relevant = retrievedContents.filter((content) => {
    const lower = content.toLowerCase();
    return needles.some((needle) => lower.includes(needle));
  }).length;
  return relevant / retrievedContents.length;
}
/** A bounded brevity signal, not a substitute for judging usefulness or correctness. */
export function withinWordBudget(output: string, maxWords: number): ScorerResult {
  const text = output.trim();
  const words = text === '' ? 0 : text.split(/\s+/).length;
  return { name: 'withinWordBudget', score: words > 0 && words <= maxWords ? 1 : 0 };
}
