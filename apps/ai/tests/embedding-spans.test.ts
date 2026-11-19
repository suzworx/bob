/**
 * One memory embedding = one provider call and exactly two `embeddings <model>`
 * spans (#880 follow-up). Production traces show two such spans per retrieval,
 * one with tokens and one with 0; this pins why. `@ai-sdk/otel` opens an
 * operation span for `embed`/`embedMany` (no usage) and a child span per
 * provider `doEmbed` call (carries `gen_ai.usage.input_tokens`), and both are
 * named `embeddings <model>`. It is a span pair, not a double call.
 *
 * Real OTel: a BasicTracerProvider with the production processor chain
 * (scrub, correlate) and an InMemorySpanExporter. Only the `traceSpan` wrapper
 * is replaced, because the real one is a passthrough until OTLP is configured;
 * the replacement opens a real span exactly as the real one does.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { context, ROOT_CONTEXT, trace, type Context, type ContextManager } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { MockEmbeddingModelV4 } from 'ai/test';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const otel = vi.hoisted(() => ({
  exporter: undefined as unknown as InMemorySpanExporter,
  provider: undefined as unknown as BasicTracerProvider,
  telemetry: { isEnabled: true, recordInputs: false, recordOutputs: false } as Record<string, unknown>,
}));
vi.mock('../src/telemetry.ts', () => ({
  get agentTelemetry() { return otel.telemetry; },
  traceSpan: (name: string, _attrs: unknown, run: () => Promise<unknown>) =>
    otel.provider.getTracer('bob').startActiveSpan(name, { attributes: { 'bob.observation.type': 'span' } }, async (span) => {
      try { return await run(); } finally { span.end(); }
    }),
}));
vi.mock('../src/agents.ts', () => ({ gateway: vi.fn(), chatModel: undefined }));

import { createEmbedder, EMBEDDING_DIM, EMBEDDING_MODEL_ID } from '../src/embeddings.ts';
import { aiSdkSpans, CorrelationSpanProcessor, ScrubbingSpanProcessor, createSpanScrubber } from '../src/telemetry-export.ts';

/** A minimal async-local context manager: parents follow awaits, as under NodeSDK. */
class AlsContextManager implements ContextManager {
  private readonly store = new AsyncLocalStorage<Context>();
  active(): Context { return this.store.getStore() ?? ROOT_CONTEXT; }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(ctx: Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A): ReturnType<F> {
    return this.store.run(ctx, () => fn.call(thisArg, ...args));
  }
  bind<T>(_ctx: Context, target: T): T { return target; }
  enable(): this { return this; }
  disable(): this { return this; }
}

context.setGlobalContextManager(new AlsContextManager());
otel.exporter = new InMemorySpanExporter();
otel.provider = new BasicTracerProvider({
  spanProcessors: [new ScrubbingSpanProcessor(createSpanScrubber(false), [new CorrelationSpanProcessor(), new SimpleSpanProcessor(otel.exporter)])],
});
otel.telemetry.integrations = [aiSdkSpans(otel.provider.getTracer('gen_ai'))];
afterAll(() => { context.disable(); });
beforeEach(() => { otel.exporter.reset(); });

const SPAN = `embeddings ${EMBEDDING_MODEL_ID}`;

function gatewayLikeModel(tokens: number): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    provider: 'gateway',
    modelId: EMBEDDING_MODEL_ID,
    // The gateway embedding model's own limits (@ai-sdk/gateway), so batching matches production.
    maxEmbeddingsPerCall: 2048,
    supportsParallelCalls: true,
    doEmbed: async ({ values }) => ({ embeddings: values.map(() => new Array<number>(EMBEDDING_DIM).fill(0.1)), usage: { tokens }, warnings: [] }),
  });
}

async function exported(): Promise<ReadableSpan[]> {
  await otel.provider.forceFlush();
  return otel.exporter.getFinishedSpans();
}

const parentOf = (span: ReadableSpan): string | undefined => span.parentSpanContext?.spanId;
const tokensOf = (span: ReadableSpan): unknown => span.attributes['gen_ai.usage.input_tokens'];

describe('memory embedding spans', () => {
  it('one retrieval embed is one provider call: wrapper -> operation span -> provider span, usage only on the provider span', async () => {
    const model = gatewayLikeModel(6);
    await createEmbedder(model).embed('where do I park');

    expect(model.doEmbedCalls).toHaveLength(1);
    const spans = await exported();
    const wrapper = spans.filter((span) => span.name === 'bob-memory-embedding');
    const embeddings = spans.filter((span) => span.name === SPAN);
    expect(wrapper).toHaveLength(1);
    expect(embeddings).toHaveLength(2);

    // Nested, not siblings: the operation span is the wrapper's child, the provider span the operation's child.
    const operation = embeddings.find((span) => parentOf(span) === wrapper[0]!.spanContext().spanId);
    const providerCall = embeddings.find((span) => parentOf(span) === operation?.spanContext().spanId);
    expect(operation).toBeDefined();
    expect(providerCall).toBeDefined();
    expect(new Set(embeddings.map((span) => span.spanContext().traceId)).size).toBe(1);

    // Usage is counted once: the provider span carries it, the operation span has none (OpenObserve shows it as 0).
    expect(tokensOf(providerCall!)).toBe(6);
    expect(tokensOf(operation!)).toBeUndefined();
    expect(embeddings.reduce((sum, span) => sum + Number(tokensOf(span) ?? 0), 0)).toBe(6);
    // Both carry the same operation name, so a dashboard tells them apart by usage or parentage, not by name.
    expect(embeddings.map((span) => span.attributes['gen_ai.operation.name'])).toEqual(['embeddings', 'embeddings']);
    // The SDK role tells them apart: dashboards count `embedding` spans as calls, never the `operation` wrapper.
    expect(operation!.attributes['bob.ai.span_type']).toBe('operation');
    expect(providerCall!.attributes['bob.ai.span_type']).toBe('embedding');
    expect(providerCall!.attributes['ai.operationId']).toBe('ai.embed');
  });

  it('a batch embed is likewise one operation span over one provider span per provider call', async () => {
    const model = gatewayLikeModel(9);
    await createEmbedder(model).embedMany(['one', 'two', 'three']);

    expect(model.doEmbedCalls).toHaveLength(1);
    const spans = await exported();
    const embeddings = spans.filter((span) => span.name === SPAN);
    expect(spans.filter((span) => span.name === 'bob-memory-embedding-batch')).toHaveLength(1);
    expect(embeddings).toHaveLength(2);
    expect(embeddings.map(tokensOf).sort()).toEqual([9, undefined]);
  });
});
