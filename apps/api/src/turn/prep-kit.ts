/**
 * The prep kit both turns share (the device turn, voice/turn/generate.ts, and the web chat turn,
 * workflows/workflow-web-chat-turn.ts): start every prep step at once, measure each step's own ms and the
 * critical-path waits, and gate the offered tools on the anchor write so the model can start before it lands.
 * Measurement and wrapping only: no I/O.
 */
import type { Tool } from 'ai';

/** Prep step durations of one turn, in ms, keyed by journal field. A step timed twice adds up. */
export type PrepTimings = Record<string, number>;

type ToolFilter = (tools: Record<string, Tool>) => Record<string, Tool>;

/** Awaits `work` and adds its own elapsed ms (from this call to its settle) to timings[step]. Measurement
 *  only: a rejection still counts and still rejects, and a `work` that throws at once is a rejection. */
export async function timed<T>(timings: PrepTimings, step: string, work: PromiseLike<T> | (() => PromiseLike<T>)): Promise<T> {
  const at = Date.now();
  try {
    return await (typeof work === 'function' ? work() : work);
  } finally {
    timings[step] = (timings[step] ?? 0) + Date.now() - at;
  }
}

/** `start()`, marked handled now (it is awaited later, with other awaits in between); a step that throws at once is a
 *  rejected step, never a thrown turn. */
export function started<T>(start: () => PromiseLike<T>): Promise<T> {
  let promise: Promise<T>;
  try {
    promise = Promise.resolve(start());
  } catch (error) {
    promise = Promise.reject(error);
  }
  promise.catch(() => undefined);
  return promise;
}

/** Awaits `promise`, adding the ms the caller blocked on it to `waits[key]`:
 *  the prep window's critical path, so the waits (with other_ms) sum to prep_ms. */
export async function waitedFor<T>(waits: PrepTimings, key: string, promise: PromiseLike<T>): Promise<T> {
  const at = Date.now();
  try {
    return await promise;
  } finally {
    waits[key] = (waits[key] ?? 0) + Date.now() - at;
  }
}

/** `filterTools` whose returned tools each wait for `gate` before they execute, never run when it rejects, and never
 *  run once `signal` aborted. */
export function gatedTools(filterTools: ToolFilter, gate: PromiseLike<unknown>, signal?: AbortSignal): ToolFilter {
  return (tools) => Object.fromEntries(Object.entries(filterTools(tools)).map(([name, definition]) => {
    const execute = definition.execute;
    return [name, execute === undefined ? definition : {
      ...definition, execute: async (...args: Parameters<typeof execute>) => { await gate; signal?.throwIfAborted(); return execute(...args); },
    }];
  }));
}
