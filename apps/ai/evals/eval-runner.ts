/**
 * Local eval runner: the single backend seam for the tsx eval suites in this
 * directory. Every run executes in-process and prints its scores; nothing is
 * uploaded.
 *
 * The suite shape ({ experimentName, data, task, scores, maxConcurrency })
 * deliberately mirrors the Braintrust `Eval('bob', {...})` call, so a suite
 * keeps its data/task/scores bodies byte-identical across runners.
 *
 * Null-drop rule: a scorer may return null (or an array containing null
 * scores) to mean "does not apply to this fixture". Null scores are dropped
 * -- never coerced to 0, which would drag the mean down.
 */
import { refuseProductionKey } from '../src/key-guard.ts';

/** One eval fixture row: the task input plus optional ground truth. */
export interface SuiteCase<I, E> {
  input: I;
  expected?: E;
  metadata?: Record<string, string>;
}

/** One scorer verdict; `score: null` means "does not apply", dropped downstream. */
export interface SuiteScorerResult {
  name: string;
  score: number | null;
  metadata?: Record<string, unknown>;
}

/** A Braintrust-shaped scorer: sync or async, single result, array, or null. */
export type SuiteScorer<I, O, E> = (args: {
  input: I;
  output: O;
  expected?: E;
  metadata?: Record<string, string>;
}) => SuiteScorerResult | SuiteScorerResult[] | null | Promise<SuiteScorerResult | SuiteScorerResult[] | null>;

/** A Braintrust-shaped eval suite: named experiment over fixture rows. */
export interface EvalSuite<I, O, E> {
  experimentName: string;
  data: SuiteCase<I, E>[];
  task: (input: I) => Promise<O>;
  scores: SuiteScorer<I, O, E>[];
  maxConcurrency?: number;
}

/** Runs every row and scorer in-process (no upload) and prints one line per score plus the means. */
export async function runEvalSuite<I, O, E>(suite: EvalSuite<I, O, E>): Promise<void> {
  // #1041: an eval never spends the production key's budget.
  refuseProductionKey();
  const totals = new Map<string, { sum: number; count: number }>();
  const limit = Math.max(1, suite.maxConcurrency ?? 1);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < suite.data.length; index = next++) {
      const row = suite.data[index]!;
      const output = await suite.task(row.input);
      for (const scorer of suite.scores) {
        const scored = await scorer({
          input: row.input,
          output,
          ...(row.expected !== undefined ? { expected: row.expected } : {}),
          ...(row.metadata !== undefined ? { metadata: row.metadata } : {}),
        });
        for (const result of scored === null ? [] : Array.isArray(scored) ? scored : [scored]) {
          if (result.score === null) continue;
          const total = totals.get(result.name) ?? { sum: 0, count: 0 };
          totals.set(result.name, { sum: total.sum + result.score, count: total.count + 1 });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  console.log(`experiment ${suite.experimentName} (local, not uploaded): ${suite.data.length} items`);
  for (const [name, { sum, count }] of totals) console.log(`  ${name}: mean ${(sum / count).toFixed(3)} over ${count}`);
}
