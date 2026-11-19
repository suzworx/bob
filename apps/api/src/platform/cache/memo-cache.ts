/**
 * A small bounded LRU + TTL cache of promises. Storing the promise (not the
 * value) means concurrent callers for one key share a single in-flight call;
 * a rejected call is evicted so a failure is never replayed.
 */
export interface MemoCacheOptions {
  max: number;
  ttlMs: number;
  now?: () => number;
}

export interface MemoCache<V> {
  /** Returns the cached value for `key`, or runs `factory` once and caches it. `hit` is true when `factory` did not run. */
  getOrCreate(key: string, factory: () => Promise<V>): Promise<{ value: V; hit: boolean }>;
  /** Stores a value already known (a write-through), replacing whatever `key` held. */
  set(key: string, value: V): void;
  clear(): void;
  readonly size: number;
}

export function createMemoCache<V>({ max, ttlMs, now = Date.now }: MemoCacheOptions): MemoCache<V> {
  const entries = new Map<string, { at: number; promise: Promise<V> }>();
  const insert = (key: string, promise: Promise<V>): void => {
    entries.delete(key);
    const entry = { at: now(), promise };
    entries.set(key, entry);
    while (entries.size > max) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    promise.catch(() => {
      if (entries.get(key) === entry) entries.delete(key);
    });
  };
  return {
    async getOrCreate(key, factory) {
      const cached = entries.get(key);
      if (cached && now() - cached.at < ttlMs) {
        // Re-insert: Map order is the recency order, oldest first.
        entries.delete(key);
        entries.set(key, cached);
        return { value: await cached.promise, hit: true };
      }
      const promise = factory();
      insert(key, promise);
      return { value: await promise, hit: false };
    },
    set: (key, value) => insert(key, Promise.resolve(value)),
    clear: () => entries.clear(),
    get size() {
      return entries.size;
    },
  };
}
