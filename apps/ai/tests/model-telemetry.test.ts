import { registerTelemetry, simulateReadableStream, streamText } from 'ai';
import { MockEmbeddingModelV4, MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OpenTelemetry } from '@ai-sdk/otel';

const spans = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('../src/telemetry.ts', () => ({
  agentTelemetry: { isEnabled: true, recordInputs: false, recordOutputs: false },
  traceSpan: async (name: string, _attrs: unknown, run: () => unknown) => { spans.names.push(name); return run(); },
}));
vi.mock('../src/agents.ts', () => ({ gateway: vi.fn(), chatModel: undefined }));

import { createEmbedder } from '../src/embeddings.ts';
import { createMemoryExtractor } from '../src/memory-extractor.ts';
import { createMemoryJudge } from '../src/memory-judge.ts';
import { judge } from '../src/eval-judge.ts';
import { CorrelationSpanProcessor, ScrubbingSpanProcessor, createSpanScrubber } from '../src/telemetry-export.ts';

const events: Array<{ functionId?: string; recordInputs?: boolean; recordOutputs?: boolean }> = [];
registerTelemetry({ onStart(event) {
  events.push({ functionId: event.functionId, recordInputs: event.recordInputs, recordOutputs: event.recordOutputs });
} });
beforeEach(() => { events.length = 0; spans.names.length = 0; });

function answering(output: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doGenerate: {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
    warnings: [],
  } });
}

describe('model operation telemetry', () => {
  it('names single and bulk embedding calls and explicitly excludes their contents', async () => {
    const embedder = createEmbedder(new MockEmbeddingModelV4({ doEmbed: async ({ values }) => ({
      embeddings: values.map(() => Array.from({ length: 1536 }, () => 0)), usage: { tokens: 7 }, warnings: [],
    }) }));
    await embedder.embed('private content');
    await embedder.embedMany(['private one', 'private two']);
    expect(events).toEqual([
      { functionId: 'bob-memory-embedding', recordInputs: false, recordOutputs: false },
      { functionId: 'bob-memory-embedding-batch', recordInputs: false, recordOutputs: false },
    ]);
    expect(spans.names).toEqual(['bob-memory-embedding', 'bob-memory-embedding-batch']);
  });

  it('names extraction and both judges with explicit metadata-only capture flags', async () => {
    await createMemoryExtractor(answering({ ops: [] }))({ userText: 'private input', assistantText: 'private response', existing: [], now: new Date('2026-01-01T00:00:00Z') });
    await createMemoryJudge(answering({ relation: 'different', id: null }))({ content: 'private new', candidates: [{ id: 'memory-1', content: 'private prior' }] });
    await judge({ criteria: 'private criterion', input: 'private input', output: 'private output' }, { model: answering({ score: 1, rationale: 'private rationale' }) });
    expect(events).toEqual([
      { functionId: 'bob-memory-extractor', recordInputs: false, recordOutputs: false },
      { functionId: 'bob-memory-judge', recordInputs: false, recordOutputs: false },
      { functionId: 'bob-eval-judge', recordInputs: false, recordOutputs: false },
    ]);
    expect(spans.names).toEqual(['bob-memory-extractor', 'bob-memory-judge', 'bob-eval-judge']);
  });
});

// --- the real AI SDK -> @ai-sdk/otel -> scrub -> export pipeline ----------

function streamingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 5,
        chunks: [
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'hi' },
          { type: 'text-end', id: 'text-1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ],
      }),
    }),
  });
}

/** A local provider with the production processor chain; no global OTel state, nothing reaches a network. */
async function runStreamedGeneration(prompt: string, payload: boolean): Promise<ReadableSpan[]> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new ScrubbingSpanProcessor(createSpanScrubber(payload), [new CorrelationSpanProcessor(), new SimpleSpanProcessor(exporter)])],
  });
  const result = streamText({
    model: streamingModel(),
    prompt,
    telemetry: { isEnabled: true, recordInputs: payload, recordOutputs: payload, integrations: [new OpenTelemetry({ tracer: provider.getTracer('gen_ai') })] },
  });
  await result.text;
  await result.usage;
  await provider.forceFlush();
  return exporter.getFinishedSpans();
}

describe('AI SDK spans through the provider-free pipeline', () => {
  it('exports generation spans with model, usage and first-chunk latency', async () => {
    const generation = (await runStreamedGeneration('hello', false)).find((span) => span.attributes['gen_ai.operation.name'] === 'chat');
    expect(generation).toBeDefined();
    expect(generation!.attributes['gen_ai.usage.input_tokens']).toBe(3);
    expect(typeof generation!.attributes['gen_ai.client.operation.time_to_first_chunk']).toBe('number');
  });

  it('keeps the prompt and reply out of every exported span when payload capture is off', async () => {
    const marker = 'unmistakable-prompt-9f3c7a';
    const exported = await runStreamedGeneration(marker, false);
    expect(exported.length).toBeGreaterThan(0);
    expect(JSON.stringify(exported.map((span) => [span.attributes, span.events]))).not.toContain(marker);
  });

  it('exports the prompt only when payload capture is on', async () => {
    const marker = 'unmistakable-prompt-9f3c7a';
    const exported = await runStreamedGeneration(marker, true);
    expect(JSON.stringify(exported.map((span) => span.attributes))).toContain(marker);
  });
});
