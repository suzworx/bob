import { describe, expect, it, vi } from 'vitest';
import { createMemoCache } from '../../src/platform/cache/memo-cache.ts';

describe('createMemoCache', () => {
  it('runs the factory once and reports a hit afterwards', async () => {
    const cache = createMemoCache<number>({ max: 4, ttlMs: 1000 });
    const factory = vi.fn(() => Promise.resolve(1));
    expect(await cache.getOrCreate('a', factory)).toEqual({ value: 1, hit: false });
    expect(await cache.getOrCreate('a', factory)).toEqual({ value: 1, hit: true });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight call between concurrent callers', async () => {
    const cache = createMemoCache<number>({ max: 4, ttlMs: 1000 });
    const factory = vi.fn(() => new Promise<number>((resolve) => setTimeout(() => resolve(7), 5)));
    const [x, y] = await Promise.all([cache.getOrCreate('a', factory), cache.getOrCreate('a', factory)]);
    expect([x.value, y.value]).toEqual([7, 7]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('expires entries after the TTL', async () => {
    let t = 0;
    const cache = createMemoCache<number>({ max: 4, ttlMs: 100, now: () => t });
    const factory = vi.fn(() => Promise.resolve(1));
    await cache.getOrCreate('a', factory);
    t = 101;
    expect((await cache.getOrCreate('a', factory)).hit).toBe(false);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used entry past max', async () => {
    const cache = createMemoCache<number>({ max: 2, ttlMs: 1000 });
    const f = (n: number) => () => Promise.resolve(n);
    await cache.getOrCreate('a', f(1));
    await cache.getOrCreate('b', f(2));
    await cache.getOrCreate('a', f(1));
    await cache.getOrCreate('c', f(3));
    expect(cache.size).toBe(2);
    expect((await cache.getOrCreate('a', f(1))).hit).toBe(true);
    expect((await cache.getOrCreate('b', f(2))).hit).toBe(false);
  });

  it('evicts a rejected entry so the failure is not replayed', async () => {
    const cache = createMemoCache<number>({ max: 4, ttlMs: 1000 });
    await expect(cache.getOrCreate('a', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(cache.size).toBe(0);
    expect(await cache.getOrCreate('a', () => Promise.resolve(2))).toEqual({ value: 2, hit: false });
  });
});
