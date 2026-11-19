/**
 * Deterministic memory evals (spec 010, T023 / FR-014 / SC-001). Drives every
 * fixture through the REAL post-model pipeline — memoryOpSchema validation,
 * isSecretLike (FR-018) and sensitiveCategory (FR-017) filtering — over the
 * fixture's recorded model ops via an injected mock model, so no network and
 * no gateway key is needed. Asserts SC-001: extraction accuracy and recall
 * precision each ≥ 0.9 across the 20 fixtures, plus exact per-fixture dropped
 * counts. The explicit-remember fixture stores sensitive facts with
 * `sensitive: true` (FR-017) and so keeps sensitive ops instead of dropping
 * them; secrets are still never stored (FR-018).
 *
 * Secret-bearing fixtures carry placeholders (__PIN__, __PASSWORD__) that are
 * substituted with runtime-assembled secret-shaped strings here, so the
 * fixture file itself contains no secret shapes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { extractionAccuracy, recallPrecision, type MemoryOpLike, memoryOpSchema, isSecretLike } from '@bob/ai/testing';
import { createMemoryExtractor, sensitiveCategory } from '@bob/ai';

/** Runtime secret substitutes (never present in the fixture file). */
const SECRETS: Record<string, string> = {
  __PIN__: '4821',
  __PASSWORD__: 'hunter2!',
};

interface Fixture {
  id: string;
  explicit?: boolean;
  turns: Array<{ user: string; assistant: string }>;
  recorded_ops: unknown[];
  expected_memories: Array<{ kind: string; content_contains: string }>;
  recall: Array<{ question: string; expected: string[] }>;
  expect_dropped: { secret: number; sensitive: number };
}

/** Substitutes the secret placeholders with runtime values in op content. */
function substituteSecrets(ops: unknown[]): unknown[] {
  return ops.map((op) => {
    if (typeof op !== 'object' || op === null || !('content' in op)) return op;
    let content = String((op as { content: string }).content);
    for (const [key, value] of Object.entries(SECRETS)) {
      content = content.replaceAll(key, value);
    }
    return { ...op, content };
  });
}

/**
 * The real post-model pipeline: validate each op with memoryOpSchema, then
 * filter. Secrets are always dropped (FR-018). Sensitive categories are
 * dropped on the automatic path only (FR-017) and kept on the explicit path
 * (an explicit remember stores them with `sensitive: true`). Mirrors
 * memory-extractor.ts filterOps exactly.
 */
function runPipeline(recordedOps: unknown[], explicit: boolean): {
  ops: unknown[];
  dropped: { secret: number; sensitive: number };
} {
  const valid = recordedOps
    .map((op) => memoryOpSchema.safeParse(op))
    .filter((r) => r.success)
    .map((r) => r.data);
  let secret = 0;
  let sensitive = 0;
  const kept: unknown[] = [];
  for (const op of valid) {
    const content = 'content' in op ? op.content : null;
    if (content !== null && isSecretLike(content)) {
      secret += 1;
    } else if (!explicit && content !== null && sensitiveCategory(content) !== null) {
      sensitive += 1;
    } else {
      kept.push(op);
    }
  }
  return { ops: kept, dropped: { secret, sensitive } };
}

/** A language model mock that answers the structured-output call with `ops`.
 * The strict envelope requires every property present, so any op missing the
 * generic `id`/`due_at` fields is normalised to `null` (as a strict
 * structured-output provider would emit them). Recorded adds predate
 * MEM-ECHO's `evidence`, so an add without one quotes `userText`. */
function mockExtractModel(ops: unknown[], userText: string): MockLanguageModelV4 {
  const normalized = ops.map((op) => {
    if (typeof op === 'object' && op !== null) {
      const record = op as Record<string, unknown>;
      if (!('id' in record)) record.id = null;
      if (!('due_at' in record)) record.due_at = null;
      if (!('evidence' in record)) record.evidence = record.op === 'add' ? userText : null;
    }
    return op;
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

function resolveFixturesPath(): string {
  const candidates = [
    resolve(process.cwd(), 'apps/ai/evals/data/memory-fixtures.json'),
    resolve(import.meta.dirname, '../../ai/evals/data/memory-fixtures.json'),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return candidates[0]!;
}

function loadFixtures(): Fixture[] {
  const raw = JSON.parse(readFileSync(resolveFixturesPath(), 'utf8')) as {
    version: number;
    fixtures: Fixture[];
  };
  if (raw.version !== 1) throw new Error(`Unexpected memory fixture version ${raw.version}`);
  return raw.fixtures;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Deterministic full-text ranker over a fixture's own memories (R7): retrieves
 * every expected memory whose content shares ≥ 1 token with the question.
 * Pure and deterministic, so recallPrecision is scored mechanically.
 */
function rankFixture(fixture: Fixture, question: string): string[] {
  const qTokens = new Set(tokenize(question));
  return fixture.expected_memories
    .map((m) => m.content_contains)
    .filter((content) => tokenize(content).some((t) => qTokens.has(t)));
}

describe('memory evals (deterministic) — SC-001', () => {
  const fixtures = loadFixtures();

  it('has 20 fixtures at version 1', () => {
    expect(fixtures).toHaveLength(20);
  });

  it('drops the exact expected secret/sensitive counts per fixture', async () => {
    for (const fixture of fixtures) {
      const ops = substituteSecrets(fixture.recorded_ops);
      if (fixture.explicit) {
        const result = runPipeline(ops, true);
        expect(result.dropped, fixture.id).toEqual(fixture.expect_dropped);
        expect(result.ops, fixture.id).toHaveLength(fixture.expected_memories.length);
        continue;
      }
      const extract = createMemoryExtractor(mockExtractModel(ops, fixture.turns[0]?.user ?? ''));
      const result = await extract({
        userText: fixture.turns[0]?.user ?? '',
        assistantText: fixture.turns[0]?.assistant ?? '',
        existing: [],
        now: new Date('2026-09-15T09:00:00Z'),
      });
      expect(result.dropped, fixture.id).toEqual(fixture.expect_dropped);
      expect(result.ops, fixture.id).toHaveLength(fixture.expected_memories.length);
    }
  });

  it('extraction accuracy is ≥ 0.9 across all fixtures', async () => {
    let total = 0;
    for (const fixture of fixtures) {
      const ops = substituteSecrets(fixture.recorded_ops);
      const result = fixture.explicit
        ? runPipeline(ops, true).ops
        : (
            await createMemoryExtractor(mockExtractModel(ops, fixture.turns[0]?.user ?? ''))({
              userText: fixture.turns[0]?.user ?? '',
              assistantText: fixture.turns[0]?.assistant ?? '',
              existing: [],
              now: new Date('2026-09-15T09:00:00Z'),
            })
          ).ops;
      total += extractionAccuracy(fixture.expected_memories, result as unknown as MemoryOpLike[]);
    }
    const accuracy = total / fixtures.length;
    expect(accuracy).toBeGreaterThanOrEqual(0.9);
  });

  it('recall precision is ≥ 0.9 across all fixtures', () => {
    const entries: Array<{ fixture: Fixture; q: Fixture['recall'][number] }> = [];
    for (const fixture of fixtures) {
      for (const q of fixture.recall) entries.push({ fixture, q });
    }
    let total = 0;
    for (const { fixture, q } of entries) {
      total += recallPrecision(rankFixture(fixture, q.question), q.expected);
    }
    const precision = entries.length === 0 ? 0 : total / entries.length;
    expect(precision).toBeGreaterThanOrEqual(0.9);
  });
});