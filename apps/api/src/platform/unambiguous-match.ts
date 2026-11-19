/**
 * Ambiguity rule for targeting a row by query (#401): shared by the memory store and the action-items
 * store, so it lives below both modules (moved out of the memory store for the module split, #622).
 */

/** The targeting margin (#401, 05 option F2): a query-picked row is acted on
 *  only when its score is at least this multiple of the runner-up's. */
export const DEFAULT_MATCH_MARGIN = 1.5;
const MARGIN_EPSILON = 1e-9;

/**
 * Picks an unambiguous winner from score-DESC ordered matches: `{ match }` only
 * when the best score is strictly above the floor AND it is the only hit or
 * beats the runner-up by the margin (best >= margin * runnerUp); otherwise
 * `{ candidates }` (the top 3, possibly empty). margin = 1 disables the rule.
 */
export function pickUnambiguous<T extends { score: number }>(
  matches: readonly T[],
  floor: number,
  margin: number,
): { match: T } | { candidates: T[] } {
  const best = matches[0];
  const runnerUp = matches[1];
  // MARGIN_EPSILON absorbs float rounding so exactly `margin x runnerUp` acts.
  if (
    best &&
    best.score > floor &&
    (!runnerUp || best.score >= margin * runnerUp.score - MARGIN_EPSILON)
  ) {
    return { match: best };
  }
  return { candidates: matches.slice(0, 3) };
}
