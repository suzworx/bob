/**
 * Deterministic gate for the extended memory eval (#402, epic #394). Drives
 * every fixture in memory-fixtures-extended.json through the REAL extractor
 * post-model pipeline (envelope parse, memoryOpSchema, secret and sensitive
 * filters) over its `recorded_ops` via MockLanguageModelV4, passing the
 * fixture's `existing` memories and earlier turns as production would. No
 * network. Asserts the group counts, falseAddRate 0 on no-op fixtures and
 * reconciliation 100 %. Groups come from the id prefix: noop_, recon_, multi_.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { extractionAccuracy, falseAddRate, reconciliationCorrect, type MemoryOpLike, isSecretLike } from '@bob/ai/testing';
import { createMemoryExtractor, type ExistingMemory, type ExtractResult } from '@bob/ai';

/** Runtime secret substitutes (never present in the fixture file). */
const SECRETS: Record<string, string> = { __PIN__: '4821', __PASSWORD__: 'hunter2!' };
const NOW = new Date('2026-09-15T09:00:00Z');

interface Fixture {
  id: string;
  turns: Array<{ user: string; assistant: string }>;
  existing?: ExistingMemory[];
  recorded_ops: unknown[];
  expected_memories: Array<{ kind: string; content_contains: string }>;
  expected_ops?: Array<{ op: string; id?: string }>;
  recall: Array<{ question: string; expected: string[] }>;
  expect_dropped: { secret: number; sensitive: number };
}

const FILE = resolve(import.meta.dirname, '../../ai/evals/data/memory-fixtures-extended.json');
const RAW_TEXT = readFileSync(FILE, 'utf8');
const RAW = JSON.parse(RAW_TEXT) as { version: number; fixtures: Fixture[] };
const fixtures = RAW.fixtures;
const group = (prefix: string): Fixture[] => fixtures.filter((f) => f.id.startsWith(prefix));

/** Substitutes the secret placeholders with runtime values in op content. */
function substituteSecrets(ops: unknown[]): unknown[] {
  return ops.map((op) => {
    if (typeof op !== 'object' || op === null || !('content' in op)) return op;
    let content = String((op as { content: string }).content);
    for (const [key, value] of Object.entries(SECRETS)) content = content.replaceAll(key, value);
    return { ...op, content };
  });
}

/** A mock answering the structured-output call with `ops`, missing envelope
 * fields as null. Recorded ops predate MEM-ECHO's `evidence`, so an add,
 * update or supersede without one quotes `userText`, as a well-behaved model
 * would (MEM-EVIDENCE: a change needs the user's words too). */
function mockExtractModel(ops: unknown[], userText: string): MockLanguageModelV4 {
  const fields = ['id', 'kind', 'content', 'confidence', 'due_at', 'evidence'];
  const normalized = ops.map((op) => {
    const record = { ...(op as Record<string, unknown>) };
    if (record.op !== 'noop' && !('evidence' in record)) record.evidence = userText;
    for (const field of fields) if (!(field in record)) record[field] = null;
    return record;
  });
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text: JSON.stringify({ ops: normalized }) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

/** Runs one fixture the way memory.eval.ts does: last turn, earlier turns, existing. */
async function run(fixture: Fixture): Promise<{ result: ExtractResult; prompt: string }> {
  const last = fixture.turns[fixture.turns.length - 1]!;
  const model = mockExtractModel(substituteSecrets(fixture.recorded_ops), last.user);
  const result = await createMemoryExtractor(model)({
    userText: last.user,
    assistantText: last.assistant,
    existing: fixture.existing ?? [],
    now: NOW,
    priorTurns: fixture.turns.slice(0, -1),
  });
  return { result, prompt: JSON.stringify(model.doGenerateCalls[0]?.prompt) };
}

describe('memory evals extended (deterministic) — #402', () => {
  it('has version 1, unique ids and the required group counts', () => {
    expect(RAW.version).toBe(1);
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
    expect(fixtures.every((f) => /^(noop|recon|multi)_/.test(f.id))).toBe(true);
    const noop = group('noop_');
    expect(noop.length).toBeGreaterThanOrEqual(20);
    expect(noop.every((f) => f.expected_memories.length === 0)).toBe(true);
    const recon = group('recon_');
    expect(recon.length).toBeGreaterThanOrEqual(10);
    for (const f of recon) {
      const ids = new Set((f.existing ?? []).map((m) => m.id));
      expect(ids.size, f.id).toBeGreaterThan(0);
      const targeted = (f.expected_ops ?? []).filter((o) => ['update', 'supersede', 'noop'].includes(o.op));
      expect(targeted.length, f.id).toBeGreaterThan(0);
      expect(targeted.every((o) => o.id !== undefined && ids.has(o.id)), f.id).toBe(true);
    }
    const multi = group('multi_');
    expect(multi.length).toBeGreaterThanOrEqual(5);
    expect(multi.every((f) => f.turns.length >= 2)).toBe(true);
  });

  it('holds secrets only as placeholders in the fixture file', () => {
    const strings = (RAW_TEXT.match(/"(?:[^"\\]|\\.)*"/g) ?? []).map((s) => s.slice(1, -1));
    const flagged = strings.filter((s) => isSecretLike(s));
    expect(flagged.filter((s) => !Object.keys(SECRETS).some((key) => s.includes(key)))).toEqual([]);
  });

  it('drops the exact expected counts and passes earlier turns to the model', async () => {
    for (const fixture of fixtures) {
      const { result, prompt } = await run(fixture);
      expect(result.dropped, fixture.id).toEqual(fixture.expect_dropped);
      const dropped = fixture.expect_dropped.secret + fixture.expect_dropped.sensitive;
      expect(result.ops, fixture.id).toHaveLength(fixture.recorded_ops.length - dropped);
      if (fixture.turns.length > 1) expect(prompt, fixture.id).toContain(fixture.turns[0]!.user);
      for (const memory of fixture.existing ?? []) expect(prompt, fixture.id).toContain(memory.id);
    }
  });

  it('falseAddRate is 0 on every fixture that expects no memories', async () => {
    const empty = fixtures.filter((f) => f.expected_memories.length === 0);
    expect(empty.length).toBeGreaterThanOrEqual(20);
    let total = 0;
    for (const fixture of empty) total += falseAddRate([], (await run(fixture)).result.ops).score;
    expect(total).toBe(0);
  });

  it('reconciliation is 100 % on every fixture with expected_ops', async () => {
    const withOps = fixtures.filter((f) => f.expected_ops !== undefined);
    expect(withOps.length).toBeGreaterThanOrEqual(10);
    for (const fixture of withOps) {
      const { result } = await run(fixture);
      expect(reconciliationCorrect(fixture.expected_ops ?? [], result.ops).score, fixture.id).toBe(1);
    }
  });

  // MEM-ECHO: the replay-memories rows (#485), recorded as the failing model
  // answered: the user only asked, the assistant repeated a live fact, and the
  // model added it. The pipeline must turn both into no add.
  const CHICKEN = { user: 'Can I have chicken tonight for dinner?', assistant: "Since you're vegetarian, how about a paneer tikka instead?" };
  const ECHO: Fixture[] = [
    {
      id: 'noop_diet_question_assistant_echo', turns: [CHICKEN],
      recorded_ops: [{ op: 'add', kind: 'fact', content: 'The user is vegetarian.', confidence: 0.9, evidence: "Since you're vegetarian" }],
      expected_memories: [], recall: [], expect_dropped: { secret: 0, sensitive: 0 },
    },
    {
      id: 'recon_diet_question_echo_duplicate_noop', turns: [CHICKEN],
      existing: [{ id: 'mem_d01', kind: 'preference', content: 'The user is a vegetarian and does not eat meat.' }],
      // Even a quote the user did say cannot add what a live memory already holds.
      recorded_ops: [{ op: 'add', kind: 'fact', content: 'The user is vegetarian.', confidence: 0.9, evidence: 'Can I have chicken tonight' }],
      expected_memories: [], expected_ops: [{ op: 'noop', id: 'mem_d01' }], recall: [], expect_dropped: { secret: 0, sensitive: 0 },
    },
  ];

  it('MEM-ECHO: the assistant-echo rows add nothing and reconcile to the live memory', async () => {
    for (const fixture of ECHO) {
      const { result } = await run(fixture);
      expect(result.ops.filter((op) => op.op === 'add'), fixture.id).toEqual([]);
      expect(falseAddRate([], result.ops).score, fixture.id).toBe(0);
      if (fixture.expected_ops) expect(reconciliationCorrect(fixture.expected_ops, result.ops).score, fixture.id).toBe(1);
    }
  });

  it('extraction accuracy is 1 across all fixtures', async () => {
    let total = 0;
    for (const fixture of fixtures) {
      const ops = (await run(fixture)).result.ops as unknown as MemoryOpLike[];
      total += extractionAccuracy(fixture.expected_memories, ops);
    }
    expect(total / fixtures.length).toBe(1);
  });
});
