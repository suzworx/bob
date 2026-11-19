/**
 * #447 extraction contract: a memory is timeless. The envelope and prompt the
 * model sees carry no due time, the system prompt sends a time at which the
 * user should be told something to reminders, and stored rows with a due time
 * still parse. Pinned through the contract, not through any user phrasing.
 */
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MEMORY_EXTRACT_SYSTEM_PROMPT,
  buildPrompt,
  createMemoryExtractor,
  extractionEnvelopeSchema,
  memoryOpSchema,
} from '../src/memory-extractor.ts';

interface EnvelopeJson {
  properties: { ops: { items: { properties: Record<string, unknown>; required: string[] } } };
}

describe('memory extraction time boundary (#447)', () => {
  it('gives the extraction model no field for a time', () => {
    const items = (z.toJSONSchema(extractionEnvelopeSchema) as EnvelopeJson).properties.ops.items;
    expect(Object.keys(items.properties)).not.toContain('due_at');
    expect(items.required).not.toContain('due_at');
    expect(buildPrompt({ userText: 't', assistantText: '', existing: [], now: new Date(0) })).not.toContain('due_at');
  });

  it('still parses a stored action_item add that carries a due time', () => {
    const stored = { op: 'add', kind: 'action_item', content: 'x', confidence: 0.9, due_at: '2026-09-18T00:00:00Z' };
    expect(memoryOpSchema.safeParse(stored).success).toBe(true);
  });

  it('defines a memory as timeless and sends timed requests to reminders', () => {
    expect(MEMORY_EXTRACT_SYSTEM_PROMPT).toContain('timeless');
    expect(MEMORY_EXTRACT_SYSTEM_PROMPT).toContain('reminder');
  });
});

describe('memory extraction source of knowledge (MEM-ECHO)', () => {
  it('requires every op to carry evidence, a string or null', () => {
    const items = (z.toJSONSchema(extractionEnvelopeSchema, { io: 'input' }) as EnvelopeJson).properties.ops.items;
    expect(items.required).toContain('evidence');
    expect(JSON.stringify(items.properties.evidence)).toContain('string');
  });

  it('makes the user the only source and the assistant context only', () => {
    expect(MEMORY_EXTRACT_SYSTEM_PROMPT).toContain('A memory may only come from what the USER said');
    expect(MEMORY_EXTRACT_SYSTEM_PROMPT).toContain('never a source');
    const prompt = buildPrompt({ userText: 'Can I have chicken?', assistantText: 'You are vegetarian.', existing: [], now: new Date(0) });
    expect(prompt).toContain('Assistant said (context only, never a source of memory): You are vegetarian.');
    expect(prompt).toContain('"evidence"');
  });
});

describe('memory extraction drops payment and ID numbers (MEM-SAFE)', () => {
  /** A mock model that proposes one grounded add of `content`. */
  function proposing(content: string): MockLanguageModelV4 {
    const ops = [{ op: 'add', id: null, kind: 'fact', content, confidence: 0.9, evidence: content }];
    return new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: JSON.stringify({ ops }) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      },
    });
  }

  it.each([
    'My Visa number is 4111 1111 1111 1111',
    'my card is 4111111111111111 exp 12/28 cvv 123',
    'My SSN: 123-45-6789',
    'my bank login is bob and hunter2',
  ])('drops a secret add: %s', async (content) => {
    const result = await createMemoryExtractor(proposing(content))({ userText: content, assistantText: 'Okay.', existing: [], now: new Date(0) });
    expect(result.ops).toEqual([]);
    expect(result.dropped.secret).toBe(1);
  });

  it('keeps an ordinary fact that has a phone number and a year', async () => {
    const content = 'The user moved to Pune in 2019 and their office line is 020 2567 1234';
    const result = await createMemoryExtractor(proposing(content))({ userText: content, assistantText: 'Okay.', existing: [], now: new Date(0) });
    expect(result.dropped.secret).toBe(0);
    expect(result.ops).toHaveLength(1);
  });
});
