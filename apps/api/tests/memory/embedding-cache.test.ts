import { describe, expect, it, vi } from 'vitest';
import type { Embedder } from '@bob/ai';
import { withEmbeddingCache } from '../../src/memory/embedding-cache.ts';

function fake(): Embedder & { embed: ReturnType<typeof vi.fn>; embedMany: ReturnType<typeof vi.fn> } {
  return { modelId: 'm', dim: 2, embed: vi.fn(() => Promise.resolve([1, 2])), embedMany: vi.fn(() => Promise.resolve([[1, 2]])) };
}

describe('withEmbeddingCache', () => {
  it('embeds a repeated query once', async () => {
    const inner = fake();
    const cached = withEmbeddingCache(inner);
    await cached.embed('what is on my agenda');
    await cached.embed('what is on my agenda');
    await cached.embed('something else');
    expect(inner.embed).toHaveBeenCalledTimes(2);
  });

  it('hands out copies so a caller cannot corrupt the cached vector', async () => {
    const cached = withEmbeddingCache(fake());
    (await cached.embed('q')).fill(9);
    expect(await cached.embed('q')).toEqual([1, 2]);
  });

  it('passes embedMany through uncached and keeps the model identity', async () => {
    const inner = fake();
    const cached = withEmbeddingCache(inner);
    await cached.embedMany(['a']);
    await cached.embedMany(['a']);
    expect(inner.embedMany).toHaveBeenCalledTimes(2);
    expect([cached.modelId, cached.dim]).toEqual(['m', 2]);
  });
});
