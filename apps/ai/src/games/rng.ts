/**
 * Seeded randomness for games (tool-contracts.md section 1). Every reducer
 * draws from an Rng built by mulberry32(seed), and the seed is stored in the
 * session row, so replaying the same seed and the same actions reproduces the
 * game exactly. Nothing here touches Math.random.
 *
 * An Rng is stateful by design (each draw advances it); a reducer that needs a
 * pure step builds one from `seed` plus the step count with rngAt().
 */

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** A shuffled copy; the input is never mutated. */
  shuffle<T>(items: readonly T[]): T[];
}

/** Normalises any number to an unsigned 32-bit seed. */
function toSeed(value: number): number {
  return Math.trunc(value) >>> 0;
}

/** mulberry32: a small, fast 32-bit generator with a full 2^32 period. */
export function mulberry32(seed: number): Rng {
  let a = toSeed(seed);
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`rng.int: bad range [${min}, ${max}]`);
    }
    return min + Math.floor(next() * (max - min + 1));
  };
  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new RangeError('rng.pick: empty list');
    return items[int(0, items.length - 1)] as T;
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  };
  return { next, int, pick, shuffle };
}

/** A fresh Rng for step `step` of a game seeded with `seed`, so a reducer can
 *  stay pure without carrying generator state between turns. */
export function rngAt(seed: number, step: number): Rng {
  return mulberry32(toSeed(Math.imul(toSeed(seed) ^ 0x9e3779b9, 0x85ebca6b) + toSeed(step)));
}
