/** Memory retrieval embeds the user's query every turn; the same question
 *  asked twice reuses the vector. Only embed() is cached (embedMany is the
 *  write path). The query text is hashed into the key and never journaled. */
import { createHash } from 'node:crypto';
import type { Embedder } from '@bob/ai';
import { createMemoCache } from '../platform/cache/memo-cache.ts';

export function withEmbeddingCache(embedder: Embedder): Embedder {
  const cache = createMemoCache<number[]>({ max: 256, ttlMs: 60 * 60 * 1000 });
  return {
    modelId: embedder.modelId,
    dim: embedder.dim,
    embedMany: (texts) => embedder.embedMany(texts),
    async embed(text, options) {
      const key = createHash('sha256').update(`${embedder.modelId}\u0000${text}`).digest('hex');
      // The signal is forwarded on a miss only; a shared in-flight call keeps the first caller's signal.
      const { value } = await cache.getOrCreate(key, () => embedder.embed(text, options));
      return [...value];
    },
  };
}
