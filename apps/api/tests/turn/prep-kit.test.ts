// SIMPLIFY-U2B: the prep kit both turns share (device generate.ts, web chat workflow).
import { describe, expect, it } from 'vitest';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { gatedTools, timed, waitedFor } from '../../src/turn/prep-kit.ts';

function probe(runs: string[]): Record<string, Tool> {
  return { probe: tool({ description: 'probe', inputSchema: z.object({}), execute: async () => { runs.push('ran'); return 'ok'; } }) };
}
const options = { toolCallId: 'c1', messages: [], context: {} };

describe('gatedTools', () => {
  it('runs a tool only after the gate resolves', async () => {
    const runs: string[] = [];
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const tools = gatedTools((offered) => offered, gate)(probe(runs));
    const pending = tools.probe!.execute!({}, options);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runs).toEqual([]);
    open();
    await expect(pending).resolves.toBe('ok');
    expect(runs).toEqual(['ran']);
  });

  it('never runs a tool when the gate rejects', async () => {
    const runs: string[] = [];
    const gate = Promise.reject(new Error('store_failed'));
    gate.catch(() => undefined);
    const tools = gatedTools((offered) => offered, gate)(probe(runs));
    await expect(tools.probe!.execute!({}, options)).rejects.toThrow('store_failed');
    expect(runs).toEqual([]);
  });

  it('never runs a tool once the turn is cancelled', async () => {
    const runs: string[] = [];
    const stop = new AbortController();
    stop.abort();
    const tools = gatedTools((offered) => offered, Promise.resolve(), stop.signal)(probe(runs));
    await expect(tools.probe!.execute!({}, options)).rejects.toThrow();
    expect(runs).toEqual([]);
  });

  it('keeps the filter: a tool the policy drops is not offered', () => {
    const tools = gatedTools(() => ({}), Promise.resolve())(probe([]));
    expect(Object.keys(tools)).toEqual([]);
  });
});

describe('waitedFor and timed', () => {
  it('waitedFor adds the blocked ms to the named wait', async () => {
    const waits: Record<string, number> = { history_wait_ms: 7 };
    const value = await waitedFor(waits, 'history_wait_ms', new Promise((resolve) => setTimeout(() => resolve('done'), 20)));
    expect(value).toBe('done');
    expect(waits.history_wait_ms).toBeGreaterThanOrEqual(7 + 15);
  });

  it('timed records a step that rejects and still rejects', async () => {
    const timings: Record<string, number> = {};
    await expect(timed(timings, 'policy_ms', () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(Number.isInteger(timings.policy_ms)).toBe(true);
  });
});
