/**
 * Live memory eval suite (spec 010, T023 / FR-014; #402): runs the REAL
 * extractor (memory-extractor.ts) over the 20 core fixtures that the
 * deterministic gate (apps/api/tests/memory-evals.test.ts) exercises plus the
 * extended no-op, reconciliation and multi-turn fixtures
 * (apps/api/tests/memory-evals-extended.test.ts). Each fixture's `existing`
 * memories and earlier turns (`priorTurns`) are passed as production would.
 * Scores extractionAccuracy, falseAddRate (no-memory fixtures only),
 * reconciliationCorrect (fixtures with expected_ops only), parseFailure and
 * recallPrecision; each is also recorded per group as `<scorer>.<group>`, a
 * null score outside that group, so the local summary carries per-group
 * means (the runner drops null scores instead of coercing them to 0).
 * Local reporting via eval-runner.ts (task outputs carry ops and counts
 * only, never reply text or secrets). Needs AI_GATEWAY_API_KEY and is NOT part of the validate gate:
 * run it on demand with `npm run eval:memory`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NoObjectGeneratedError } from 'ai';
import { runEvalSuite } from './eval-runner.ts';
import {
  extractionAccuracy,
  falseAddRate,
  recallPrecision,
  reconciliationCorrect,
  type OptionalScorerResult,
} from '../src/eval-scorers.ts';
import { createMemoryExtractor, type ExistingMemory, type MemoryOp } from '../src/memory-extractor.ts';
import { assertEvalPreconditions } from './fixtures.ts';

assertEvalPreconditions();

type Group = 'core' | 'noop' | 'reconciliation' | 'multi_turn';
const GROUPS: Group[] = ['core', 'noop', 'reconciliation', 'multi_turn'];

interface MemoryFixture {
  id: string;
  explicit?: boolean;
  turns: Array<{ user: string; assistant: string }>;
  existing?: ExistingMemory[];
  recorded_ops: unknown[];
  expected_memories: Array<{ kind: string; content_contains: string }>;
  expected_ops?: Array<{ op: string; id?: string }>;
  recall: Array<{ question: string; expected: string[] }>;
  expect_dropped: { secret: number; sensitive: number };
}

/** What the task records: ops and counts only, never reply text. */
interface MemoryEvalOutput {
  ops: MemoryOp[];
  dropped: { secret: number; sensitive: number };
  parseFailure: boolean;
}

/** Resolves a versioned memory fixture file (repo-root then cwd fallbacks). */
function loadMemoryFixtures(name: string): MemoryFixture[] {
  const candidates = [
    resolve(process.cwd(), 'apps/ai/evals/data', name),
    ...(typeof __dirname === 'undefined' ? [] : [resolve(__dirname, 'data', name)]),
    resolve(process.cwd(), 'data', name),
  ];
  const file = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { version: number; fixtures: MemoryFixture[] };
  if (raw.version !== 1) throw new Error(`Unexpected memory fixture version ${raw.version} in ${name}`);
  return raw.fixtures;
}

/** The extended file groups fixtures by id prefix; the core file is one group. */
function groupOf(fixture: MemoryFixture, core: boolean): Group {
  if (core) return 'core';
  if (fixture.id.startsWith('noop_')) return 'noop';
  if (fixture.id.startsWith('recon_')) return 'reconciliation';
  if (fixture.id.startsWith('multi_')) return 'multi_turn';
  throw new Error(`Extended memory fixture ${fixture.id} has no group prefix`);
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Deterministic full-text ranker over a set of stored memory contents. */
function rankOver(contents: string[], question: string): string[] {
  const qTokens = new Set(tokenize(question));
  return contents.filter((content) => tokenize(content).some((t) => qTokens.has(t)));
}

const data = [
  ...loadMemoryFixtures('memory-fixtures.json').map((f) => ({ fixture: f, group: groupOf(f, true) })),
  ...loadMemoryFixtures('memory-fixtures-extended.json').map((f) => ({ fixture: f, group: groupOf(f, false) })),
].map(({ fixture, group }) => ({ input: fixture, expected: fixture, metadata: { id: fixture.id, group } }));
const groupById = new Map(data.map((item) => [item.input.id, item.metadata.group]));
const extract = createMemoryExtractor();

/** Scores one fixture with every scorer; null where a scorer does not apply. */
function scoreFixture(fixture: MemoryFixture, output: MemoryEvalOutput): OptionalScorerResult[] {
  const parse: OptionalScorerResult = { name: 'parseFailure', score: output.parseFailure ? 1 : 0 };
  if (output.parseFailure) {
    // A parse failure made no reconciliation decision, so it scores 0 there rather than flattering the model.
    return [
      parse,
      ...['extractionAccuracy', 'falseAddRate', 'recallPrecision'].map((name) => ({ name, score: null })),
      { name: 'reconciliationCorrect', score: fixture.expected_ops === undefined ? null : 0 },
    ];
  }
  const contents = output.ops.flatMap((op) => ('content' in op ? [op.content] : []));
  const recall = fixture.recall.length === 0
    ? null
    : fixture.recall.reduce((sum, q) => sum + recallPrecision(rankOver(contents, q.question), q.expected), 0)
      / fixture.recall.length;
  return [
    parse,
    { name: 'extractionAccuracy', score: extractionAccuracy(fixture.expected_memories, output.ops.filter((op) => op.op === 'add')) },
    fixture.expected_memories.length === 0 ? falseAddRate([], output.ops) : { name: 'falseAddRate', score: null },
    fixture.expected_ops === undefined
      ? { name: 'reconciliationCorrect', score: null }
      : reconciliationCorrect(fixture.expected_ops, output.ops),
    { name: 'recallPrecision', score: recall },
  ];
}

/** The overall score plus one `<name>.<group>` score per group (null elsewhere).
 * The 25-row fan-out per fixture (5 scorers x overall + 4 groups) is kept
 * intentionally for per-group means; the runner drops the null scores. */
function withGroups(results: OptionalScorerResult[], group: Group): OptionalScorerResult[] {
  return results.flatMap((result) => [
    result,
    ...GROUPS.map((g) => ({ name: `${result.name}.${g}`, score: g === group ? result.score : null })),
  ]);
}

await runEvalSuite({
  experimentName: 'memory',
  data,
  task: async (fixture: MemoryFixture): Promise<MemoryEvalOutput> => {
    const last = fixture.turns[fixture.turns.length - 1]!;
    try {
      const result = await extract({
        userText: last.user,
        assistantText: last.assistant ?? '',
        existing: fixture.existing ?? [],
        now: new Date(),
        ...(fixture.turns.length > 1 ? { priorTurns: fixture.turns.slice(0, -1) } : {}),
      });
      return { ops: result.ops, dropped: result.dropped, parseFailure: false };
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error)) throw error;
      return { ops: [], dropped: { secret: 0, sensitive: 0 }, parseFailure: true };
    }
  },
  scores: [
    ({ input, output }): OptionalScorerResult[] => withGroups(scoreFixture(input, output), groupById.get(input.id) ?? 'core'),
  ],
});
