/**
 * Embeddings for memory retrieval and storage (spec 010, R2): the AI SDK
 * `embed`/`embedMany` calls against the gateway embedding model, with a
 * dimension guard. Lives in apps/ai because apps/api must not call providers
 * (AGENTS.md layer rule).
 */
import { embed, embedMany, type EmbeddingModel } from 'ai';
import { gateway } from './agents.ts';
import { AI_STUB_MODE } from './config.ts';
import { agentTelemetry, traceSpan } from './telemetry.ts';

/** The embedding model id, fixed by research R2. */
export const EMBEDDING_MODEL_ID = 'openai/text-embedding-3-small';
/** The vector length this model produces (research R2); stored per row. */
export const EMBEDDING_DIM = 1536;

export interface Embedder {
  embed(text: string, options?: { signal?: AbortSignal }): Promise<number[]>;
  embedMany(texts: string[]): Promise<number[][]>;
  readonly modelId: string;
  readonly dim: number;
}

/**
 * The embedder under AI_STUB_MODE: refuses every call without touching the
 * network. Callers already treat an embed failure as a normal case -- memory
 * retrieval degrades to its full-text arm -- so refusing is the honest stub.
 * A fake vector would not be: cosine distance against a zero vector is
 * undefined in pgvector, and any other made-up vector would fake similarity.
 */
function stubEmbedder(): Embedder {
  const refuse = async (): Promise<never> => {
    throw new Error('embeddings are stubbed (AI_STUB_MODE): no embedding model is called');
  };
  return { embed: refuse, embedMany: refuse, modelId: EMBEDDING_MODEL_ID, dim: EMBEDDING_DIM };
}

/**
 * Creates the embedder for a model (the gateway embedding model by default).
 * Every returned vector length is validated against EMBEDDING_DIM and a
 * mismatch throws, so a future model change cannot silently store a
 * wrong-dimension vector.
 *
 * AI_STUB_MODE promises no real AI calls: with no model supplied it gets the
 * refusing stub. An explicitly supplied model is always honoured (a test's mock).
 */
export function createEmbedder(model?: EmbeddingModel): Embedder {
  if (model === undefined && AI_STUB_MODE) return stubEmbedder();
  return createGatewayEmbedder(model ?? gateway.embeddingModel(EMBEDDING_MODEL_ID));
}

function createGatewayEmbedder(model: EmbeddingModel): Embedder {
  async function embedOne(text: string, options: { signal?: AbortSignal } = {}): Promise<number[]> {
    const result = await traceSpan('bob-memory-embedding', {}, () => embed({ model, value: text, abortSignal: options.signal,
      telemetry: { ...agentTelemetry, functionId: 'bob-memory-embedding' } }));
    const vector = result.embedding;
    if (vector.length !== EMBEDDING_DIM) {
      throw new Error(`embedding model returned ${vector.length} dimensions; expected ${EMBEDDING_DIM}`);
    }
    return vector;
  }

  async function embedManyValues(texts: string[]): Promise<number[][]> {
    const result = await traceSpan('bob-memory-embedding-batch', {}, () => embedMany({ model, values: texts,
      telemetry: { ...agentTelemetry, functionId: 'bob-memory-embedding-batch' } }));
    for (const vector of result.embeddings) {
      if (vector.length !== EMBEDDING_DIM) {
        throw new Error(`embedding model returned ${vector.length} dimensions; expected ${EMBEDDING_DIM}`);
      }
    }
    return result.embeddings;
  }

  return { embed: embedOne, embedMany: embedManyValues, modelId: EMBEDDING_MODEL_ID, dim: EMBEDDING_DIM };
}
