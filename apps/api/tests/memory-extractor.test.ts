/**
 * Unit tests for the memory extraction model call and embedder (spec 010,
 * T010 apps/ai half). No network: the SDK calls run against MockLanguageModelV4
 * and MockEmbeddingModelV4 from `ai/test`.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockEmbeddingModelV4, MockLanguageModelV4 } from 'ai/test';
import { createMemoryExtractor, findDuplicate, createEmbedder } from '@bob/ai';
import { DUPLICATE_MIN_CONTAINMENT, EVIDENCE_MIN_COVERAGE, MEMORY_EXTRACT_SYSTEM_PROMPT, buildPrompt, groundedInUser, extractionEnvelopeSchema, memoryExtractionSchema, memoryOpSchema, narrowsMemory, EMBEDDING_DIM, EMBEDDING_MODEL_ID } from '@bob/ai/testing';

/** A language model mock that answers the structured-output call with `ops`.
 * The strict envelope requires every property present, so any op missing the
 * generic `id`/`due_at` fields is normalised to `null` (as a strict
 * structured-output provider would). An add, update or supersede without
 * `evidence` quotes `evidence` (default 't', the userText most tests send);
 * a noop gets null. */
function mockExtractModel(ops: unknown[], evidence = 't'): MockLanguageModelV4 {
  const normalized = ops.map((op) => {
    if (typeof op === 'object' && op !== null) {
      const record = op as Record<string, unknown>;
      if (!('id' in record)) record.id = null;
      if (!('due_at' in record)) record.due_at = null;
      if (!('kind' in record)) record.kind = null;
      if (!('evidence' in record)) record.evidence = record.op === 'noop' ? null : evidence;
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

const NOW = new Date('2026-09-15T09:00:00Z');

describe('memory op schema', () => {
  it('serialises the extraction envelope to a strict JSON Schema the provider accepts', () => {
    const schema = z.toJSONSchema(extractionEnvelopeSchema) as {
      properties?: Record<
        string,
        { items?: { type?: string; properties?: Record<string, unknown>; required?: string[] } }
      >;
    };
    const items = schema.properties?.ops?.items;
    expect(items?.type).toBe('object');
    for (const [name, prop] of Object.entries(items?.properties ?? {})) {
      expect(prop, `sub-schema for "${name}" must not be an empty object`).not.toEqual({});
      expect(prop, `sub-schema for "${name}" must be typed`).toSatisfy((p) => {
        const record = p as Record<string, unknown>;
        return 'type' in record || 'anyOf' in record || 'enum' in record;
      });
    }
    expect(items?.required).toEqual(
      expect.arrayContaining(['op', 'id', 'kind', 'content', 'confidence']),
    );
    // #447: a memory is timeless, so the model-facing envelope has no due time.
    expect(Object.keys(items?.properties ?? {})).not.toContain('due_at');
  });

  it('parses well-formed ops of every kind', () => {
    const parsed = memoryExtractionSchema.safeParse({
      ops: [
        { op: 'add', kind: 'fact', content: 'Works from home on Fridays.', confidence: 0.88 },
        { op: 'add', kind: 'action_item', content: 'Email Dana by Friday.', confidence: 0.95, due_at: '2026-09-18T00:00:00Z' },
        { op: 'update', id: 'mem_1', content: 'Prefers chai.', confidence: 0.8 },
        { op: 'supersede', id: 'mem_2', content: 'Loves steak.', confidence: 0.85 },
        { op: 'noop', id: 'mem_3' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a bad kind, empty content, out-of-range confidence, and due_at on a non-action', () => {
    expect(memoryOpSchema.safeParse({ op: 'add', kind: 'opinion', content: 'x', confidence: 0.5 }).success).toBe(false);
    expect(memoryOpSchema.safeParse({ op: 'add', kind: 'fact', content: '   ', confidence: 0.5 }).success).toBe(false);
    expect(memoryOpSchema.safeParse({ op: 'add', kind: 'fact', content: 'x', confidence: 1.2 }).success).toBe(false);
    expect(
      memoryOpSchema.safeParse({ op: 'add', kind: 'fact', content: 'x', confidence: 0.5, due_at: '2026-09-18T00:00:00Z' })
        .success,
    ).toBe(false);
  });
});

describe('createMemoryExtractor', () => {
  it('returns the ops the model produced for a well-formed turn', async () => {
    const extract = createMemoryExtractor(
      mockExtractModel([{ op: 'add', kind: 'preference', content: 'Likes dark roast.', confidence: 0.8 }], 'I like dark roast'),
    );
    const result = await extract({ userText: 'I like dark roast.', assistantText: '', existing: [], now: NOW });
    expect(result.ops).toEqual([{ op: 'add', kind: 'preference', content: 'Likes dark roast.', confidence: 0.8 }]);
    expect(result.dropped).toEqual({ secret: 0, sensitive: 0 });
  });

  it('#396: reports the call usage and the answering model id', async () => {
    const extract = createMemoryExtractor(mockExtractModel([]));
    const result = await extract({ userText: 'Thanks', assistantText: 'You are welcome.', existing: [], now: NOW });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.modelId).toEqual(expect.any(String));
    expect(result.modelId).not.toBe('');
  });

  it('drops invalid ops instead of failing the whole extraction', async () => {
    const extract = createMemoryExtractor(
      mockExtractModel([
        { op: 'add', kind: 'fact', content: '   ', confidence: 0.5 },
        { op: 'add', kind: 'fact', content: 'Keeps good ops.', confidence: 0.9 },
      ]),
    );
    const result = await extract({ userText: 't', assistantText: '', existing: [], now: NOW });
    expect(result.ops).toEqual([{ op: 'add', kind: 'fact', content: 'Keeps good ops.', confidence: 0.9 }]);
    expect(result.dropped).toEqual({ secret: 0, sensitive: 0 });
  });

  it('maps a null-filled op returned by the model, keeping valid ones', async () => {
    const extract = createMemoryExtractor(
      mockExtractModel([
        { op: 'noop', id: 'mem_1', kind: null, content: null, confidence: null, due_at: null },
        { op: 'add', kind: 'fact', content: 'Likes light roast.', confidence: 0.7, id: null, due_at: null },
      ]),
    );
    const result = await extract({ userText: 't', assistantText: '', existing: [], now: NOW });
    expect(result.ops).toEqual([
      { op: 'noop', id: 'mem_1' },
      { op: 'add', kind: 'fact', content: 'Likes light roast.', confidence: 0.7 },
    ]);
    expect(result.dropped).toEqual({ secret: 0, sensitive: 0 });
  });

  it('drops per-item ops that pass the envelope but fail the op schema', async () => {
    const extract = createMemoryExtractor(
      mockExtractModel([
        { op: 'add', kind: 'fact', content: '', confidence: 0.9, id: null, due_at: null },
        { op: 'noop', id: 'mem_9', kind: null, content: null, confidence: null, due_at: null },
      ]),
    );
    const result = await extract({ userText: 't', assistantText: '', existing: [], now: NOW });
    expect(result.ops).toEqual([{ op: 'noop', id: 'mem_9' }]);
    expect(result.dropped).toEqual({ secret: 0, sensitive: 0 });
  });

  it('drops and counts a secret-shaped op, keeping the rest', async () => {
    const apiKey = 'sk-' + 'A1b2'.repeat(8);
    const extract = createMemoryExtractor(
      mockExtractModel([
        { op: 'add', kind: 'fact', content: `my api key is ${apiKey}`, confidence: 0.9 },
        { op: 'add', kind: 'preference', content: 'Likes dark roast.', confidence: 0.8 },
      ]),
    );
    const result = await extract({ userText: 't', assistantText: '', existing: [], now: NOW });
    expect(result.ops).toEqual([{ op: 'add', kind: 'preference', content: 'Likes dark roast.', confidence: 0.8 }]);
    expect(result.dropped.secret).toBe(1);
    expect(result.dropped.sensitive).toBe(0);
  });

  it('#458: the schema sent to the provider offers only the durable kinds and requires every key', () => {
    // io 'input' is the side the SDK sends; strict providers reject an optional key.
    const schema = z.toJSONSchema(extractionEnvelopeSchema, { io: 'input' }) as unknown as {
      properties: { ops: { items: { required: string[]; properties: Record<string, unknown> } } };
    };
    const items = schema.properties.ops.items;
    expect(items.required).toEqual(expect.arrayContaining(Object.keys(items.properties)));
    const kind = JSON.stringify(items.properties.kind);
    expect(kind).toContain('"fact"');
    expect(kind).toContain('"preference"');
    expect(kind).not.toContain('intent');
    expect(kind).not.toContain('action_item');
  });

  it('#458: the envelope rejects an intent or action_item add; supersede and durable adds pass', async () => {
    for (const kind of ['intent', 'action_item']) {
      const op = { op: 'add', id: null, kind, content: 'Wants chicken tonight.', confidence: 0.8 };
      expect(extractionEnvelopeSchema.safeParse({ ops: [op] }).success, kind).toBe(false);
    }
    const extract = createMemoryExtractor(
      mockExtractModel([
        { op: 'supersede', id: 'mem_1', kind: null, content: 'Eats chicken and fish again.', confidence: 0.9 },
        { op: 'add', kind: 'preference', content: 'Is vegetarian.', confidence: 0.9 },
      ]),
    );
    const result = await extract({ userText: 't', assistantText: '', existing: [], now: NOW });
    expect(result.ops).toEqual([
      { op: 'supersede', id: 'mem_1', content: 'Eats chicken and fish again.', confidence: 0.9 },
      { op: 'add', kind: 'preference', content: 'Is vegetarian.', confidence: 0.9 },
    ]);
  });

  it('#458: stored rows of every kind still parse', () => {
    for (const kind of ['fact', 'preference', 'intent', 'action_item']) {
      expect(memoryOpSchema.safeParse({ op: 'add', kind, content: 'x', confidence: 0.5 }).success, kind).toBe(true);
    }
  });

  it('drops and counts a sensitive-category op', async () => {
    const extract = createMemoryExtractor(
      mockExtractModel([{ op: 'add', kind: 'fact', content: 'My salary is 90000 per year.', confidence: 0.9 }]),
    );
    const result = await extract({ userText: 't', assistantText: '', existing: [], now: NOW });
    expect(result.ops).toEqual([]);
    expect(result.dropped.sensitive).toBe(1);
    expect(result.dropped.secret).toBe(0);
  });
});

describe('MEM-ECHO: memories come only from the user, never duplicate a live one', () => {
  const VEG = { id: 'mem_veg', kind: 'preference' as const, content: 'The user is a vegetarian and does not eat meat.' };
  const turnInput = { userText: 'Can I have chicken tonight?', assistantText: "Since you're vegetarian, how about paneer?", now: NOW };

  it('echo: an add quoting the assistant, when the user only asked, is dropped', async () => {
    const model = mockExtractModel(
      [{ op: 'add', kind: 'fact', content: 'The user is vegetarian.', confidence: 0.9 }],
      "Since you're vegetarian",
    );
    const result = await createMemoryExtractor(model)({ ...turnInput, existing: [] });
    expect(result.ops).toEqual([]);
    expect(result.rejected).toEqual({ ungrounded: 1, duplicate: 0, changesUngrounded: 0, narrowed: 0 });
  });

  it('echo: an add with no evidence at all is dropped', async () => {
    const model = mockExtractModel([{ op: 'add', kind: 'fact', content: 'The user is vegetarian.', confidence: 0.9, evidence: null }]);
    expect((await createMemoryExtractor(model)({ ...turnInput, existing: [] })).ops).toEqual([]);
  });

  it('duplicate: a grounded add that restates a live memory becomes a noop on it', async () => {
    const model = mockExtractModel(
      [{ op: 'add', kind: 'fact', content: 'The user is vegetarian.', confidence: 0.9 }],
      "I'm vegetarian",
    );
    const result = await createMemoryExtractor(model)({ ...turnInput, userText: "I'm vegetarian, remember?", existing: [VEG] });
    expect(result.ops).toEqual([{ op: 'noop', id: 'mem_veg' }]);
    expect(result.rejected).toEqual({ ungrounded: 0, duplicate: 1, changesUngrounded: 0, narrowed: 0 });
  });

  it('a real new user statement still adds', async () => {
    const model = mockExtractModel(
      [{ op: 'add', kind: 'fact', content: "The user's sister Priya lives in Munich.", confidence: 0.9 }],
      'My sister Priya lives in Munich',
    );
    const result = await createMemoryExtractor(model)({
      userText: 'My sister Priya lives in Munich.', assistantText: 'Noted.', now: NOW, existing: [VEG],
    });
    expect(result.ops).toEqual([{ op: 'add', kind: 'fact', content: "The user's sister Priya lives in Munich.", confidence: 0.9 }]);
  });

  it('evidence from an earlier user turn is the user\'s words (a "yes" to a question)', () => {
    expect(groundedInUser('my dog is called Biscuit', ['Yes', 'My dog is called Biscuit.'])).toBe(true);
    expect(groundedInUser('Yes', ['yes!'])).toBe(true);
  });

  it(`grounding needs ${EVIDENCE_MIN_COVERAGE * 100} % of the quoted words in the user's words`, () => {
    expect(EVIDENCE_MIN_COVERAGE).toBe(0.8);
    expect(groundedInUser('I do not eat meat at all', ["I don't eat meat at all"])).toBe(true);
    expect(groundedInUser('you are a vegetarian', ['Can I have chicken tonight?'])).toBe(false);
    expect(groundedInUser('', ['anything'])).toBe(false);
  });

  it(`a duplicate holds ${DUPLICATE_MIN_CONTAINMENT * 100} % of the add's knowledge words and agrees on negation`, () => {
    expect(DUPLICATE_MIN_CONTAINMENT).toBe(1);
    expect(findDuplicate('The user is vegetarian.', [VEG])).toBe('mem_veg');
    expect(findDuplicate('User likes to run in the mornings.', [{ id: 'm', content: 'The user runs in the morning.' }])).toBeNull();
    expect(findDuplicate('The user runs in the morning.', [{ id: 'm', content: 'The user likes running; runs in the morning.' }])).toBe('m');
    expect(findDuplicate("The user's brother lives in Berlin.", [{ id: 'm', content: "The user's sister lives in Berlin." }])).toBeNull();
    expect(findDuplicate('The user is not vegetarian.', [{ id: 'm', content: 'The user is vegetarian.' }])).toBeNull();
    expect(findDuplicate('The user is vegetarian.', [{ id: 'm', content: "The user isn't vegetarian." }])).toBeNull();
    expect(findDuplicate('The user is vegetarian.', [])).toBeNull();
  });

  it('states the source-of-knowledge contract in the system prompt and the prompt', () => {
    expect(MEMORY_EXTRACT_SYSTEM_PROMPT).toContain('A memory may only come from what the USER said');
    expect(buildPrompt({ ...turnInput, existing: [] })).toContain('Assistant said (context only, never a source of memory)');
  });
});

describe('MEM-EVIDENCE: updates and supersedes need the user\'s words and must say something new', () => {
  const INDIAN_VEG = { id: 'mem_iv', kind: 'fact' as const, content: 'The user is Indian and vegetarian.' };
  const question = { userText: 'can I have chicken tonight', assistantText: "Since you're vegetarian, how about paneer?", now: NOW };

  it('live case: a question alone never supersedes "Indian and vegetarian" with "Indian"', async () => {
    // As the live model answered: the user's question quoted, the fact narrowed.
    const model = mockExtractModel(
      [{ op: 'supersede', id: 'mem_iv', content: 'The user is Indian.', confidence: 0.8 }],
      'can I have chicken tonight',
    );
    const result = await createMemoryExtractor(model)({ ...question, existing: [INDIAN_VEG] });
    expect(result.ops).toEqual([{ op: 'noop', id: 'mem_iv' }]);
    expect(result.rejected).toMatchObject({ changesUngrounded: 0, narrowed: 1 });
  });

  it('a supersede or update quoting no user words becomes a noop on its memory', async () => {
    const model = mockExtractModel([
      { op: 'supersede', id: 'mem_iv', content: 'The user eats chicken.', confidence: 0.8, evidence: "Since you're vegetarian" },
      { op: 'update', id: 'mem_iv', content: 'The user is Indian, vegetarian and likes paneer.', confidence: 0.8, evidence: null },
    ]);
    const result = await createMemoryExtractor(model)({ ...question, existing: [INDIAN_VEG] });
    expect(result.ops).toEqual([{ op: 'noop', id: 'mem_iv' }, { op: 'noop', id: 'mem_iv' }]);
    expect(result.rejected).toMatchObject({ changesUngrounded: 2, narrowed: 0 });
  });

  it('a real correction by the user still supersedes', async () => {
    const content = 'The user is Indian and no longer vegetarian.';
    const model = mockExtractModel(
      [{ op: 'supersede', id: 'mem_iv', content, confidence: 0.9 }],
      "actually I'm not vegetarian any more",
    );
    const result = await createMemoryExtractor(model)({
      userText: "Actually I'm not vegetarian any more.", assistantText: 'Got it.', now: NOW, existing: [INDIAN_VEG],
    });
    expect(result.ops).toEqual([{ op: 'supersede', id: 'mem_iv', content, confidence: 0.9 }]);
  });

  it('an update the user said still updates', async () => {
    const dog = { id: 'mem_dog', kind: 'fact' as const, content: "User's dog is named Biscuit." };
    const content = "User's dog is a golden retriever named Biscuit.";
    const model = mockExtractModel([{ op: 'update', id: 'mem_dog', content, confidence: 0.9 }], 'Biscuit is a golden retriever');
    const result = await createMemoryExtractor(model)({
      userText: 'Biscuit is a golden retriever, by the way.', assistantText: 'Lovely breed.', now: NOW, existing: [dog],
    });
    expect(result.ops).toEqual([{ op: 'update', id: 'mem_dog', content, confidence: 0.9 }]);
  });

  it('narrowsMemory reads only the targeted memory and keeps negation apart', () => {
    expect(narrowsMemory('The user is Indian.', 'mem_iv', [INDIAN_VEG])).toBe(true);
    expect(narrowsMemory('The user is not vegetarian.', 'mem_iv', [INDIAN_VEG])).toBe(false);
    expect(narrowsMemory('The user is Indian.', 'mem_other', [INDIAN_VEG])).toBe(false);
  });

  it('asks for evidence on every change and forbids narrowing in the system prompt', () => {
    expect(MEMORY_EXTRACT_SYSTEM_PROMPT).toContain('Every add, update and supersede carries evidence');
    expect(MEMORY_EXTRACT_SYSTEM_PROMPT).toContain('Never narrow or split an existing memory');
  });
});

describe('buildPrompt (#402)', () => {
  const RETURN_LINE =
    'Return JSON only: { "ops": [ { "op": "add", "kind": "fact|preference", "content": "...", "confidence": 0.0-1.0, "evidence": "<the user\'s exact words>" }, { "op": "update", "id": "...", "content": "...", "confidence": 0.0-1.0, "evidence": "<the user\'s exact words>" }, { "op": "supersede", "id": "...", "content": "...", "confidence": 0.0-1.0, "evidence": "<the user\'s exact words>" }, { "op": "noop", "id": "..." } ] }.';
  const base = {
    userText: 'I moved to Pune.',
    assistantText: 'Got it.',
    existing: [{ id: 'mem_1', kind: 'fact' as const, content: 'User lives in Delhi.' }],
    now: NOW,
  };
  /** The prompt as it was before priorTurns existed, byte for byte. */
  const GOLDEN = [
    'Extract memory operations from this turn. Compare against the existing memories and prefer update, supersede, or noop over adding a duplicate.',
    'Today is 2026-09-15T09:00:00.000Z.',
    'Existing memories (id, kind, content):\n- mem_1 (fact): User lives in Delhi.',
    'User said: I moved to Pune.',
    'Assistant said (context only, never a source of memory): Got it.',
    RETURN_LINE,
  ].join('\n');

  it('is byte-identical to the single-turn prompt when priorTurns is absent or empty', () => {
    expect(buildPrompt(base)).toBe(GOLDEN);
    expect(buildPrompt({ ...base, priorTurns: [] })).toBe(GOLDEN);
  });

  it('keeps the no-existing, no-assistant form unchanged', () => {
    expect(buildPrompt({ userText: 'Thanks', assistantText: '', existing: [], now: NOW })).toBe(
      ['Extract memory operations from this turn. Compare against the existing memories and prefer update, supersede, or noop over adding a duplicate.',
        'Today is 2026-09-15T09:00:00.000Z.', 'Existing memories: none.', 'User said: Thanks', RETURN_LINE].join('\n'),
    );
  });

  it('adds earlier turns before the current turn, never inside assistantText', () => {
    const prompt = buildPrompt({ ...base, priorTurns: [{ user: 'My sister moved.', assistant: 'Where to?' }, { user: 'Hmm', assistant: '' }] });
    expect(prompt).toContain('Earlier turns, oldest first (context only):\n- User: My sister moved. | Assistant: Where to?\n- User: Hmm\nUser said: I moved to Pune.');
    expect(prompt).toContain('\nAssistant said (context only, never a source of memory): Got it.\n');
  });

  it('sends priorTurns to the model through the extractor', async () => {
    const model = mockExtractModel([]);
    await createMemoryExtractor(model)({ ...base, priorTurns: [{ user: 'Earlier ask', assistant: 'Sure' }] });
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('Earlier ask');
  });
});

describe('createEmbedder', () => {
  it('returns EMBEDDING_DIM-dimensional vectors and honours modelId/dim', async () => {
    const model = new MockEmbeddingModelV4({
      maxEmbeddingsPerCall: 100,
      doEmbed: async ({ values }) => ({
        embeddings: values.map(() => new Array(EMBEDDING_DIM).fill(0.1)),
        usage: { tokens: values.length },
        warnings: [],
      }),
    });
    const embedder = createEmbedder(model);
    expect(embedder.modelId).toBe(EMBEDDING_MODEL_ID);
    expect(embedder.dim).toBe(EMBEDDING_DIM);
    const vector = await embedder.embed('hello');
    expect(vector).toHaveLength(EMBEDDING_DIM);
    const many = await embedder.embedMany(['a', 'b']);
    expect(many).toHaveLength(2);
    expect(many[0]).toHaveLength(EMBEDDING_DIM);
    expect(many[1]).toHaveLength(EMBEDDING_DIM);
  });

  it('throws when the model returns a wrong-length vector', async () => {
    const model = new MockEmbeddingModelV4({
      doEmbed: async () => ({ embeddings: [new Array(3).fill(0.1)], usage: { tokens: 1 }, warnings: [] }),
    });
    const embedder = createEmbedder(model);
    await expect(embedder.embed('x')).rejects.toThrow(/dimension/i);
  });
});