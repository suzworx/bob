import { describe, expect, it, vi } from 'vitest';
import { createPlaybackQueue, type PlaybackQueueDeps } from './playback-queue';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface SynthCall {
  text: string;
  signal: AbortSignal;
  d: Deferred<string>;
}

interface Harness {
  queue: ReturnType<typeof createPlaybackQueue>;
  synthCalls: SynthCall[];
  plays: string[];
  revoked: string[];
  states: string[];
  errors: unknown[];
  stopPlayback: ReturnType<typeof vi.fn>;
  playDeferred: (url: string) => Deferred<void>;
  url: (n: number) => string;
}

function setup(): Harness {
  const synthCalls: SynthCall[] = [];
  const plays: string[] = [];
  const revoked: string[] = [];
  const states: string[] = [];
  const errors: unknown[] = [];
  const stopPlayback = vi.fn();
  const playDeferreds = new Map<string, Deferred<void>>();

  const playDeferred = (url: string): Deferred<void> => {
    let d = playDeferreds.get(url);
    if (!d) {
      d = deferred<void>();
      playDeferreds.set(url, d);
    }
    return d;
  };

  const deps: PlaybackQueueDeps = {
    synthesize: (text, signal) => {
      const d = deferred<string>();
      synthCalls.push({ text, signal, d });
      return d.promise;
    },
    play: (url) => {
      plays.push(url);
      return playDeferred(url).promise;
    },
    stopPlayback,
    revoke: (url) => {
      revoked.push(url);
    },
    onState: (state) => {
      states.push(state);
    },
    onError: (error) => {
      errors.push(error);
    },
  };

  const queue = createPlaybackQueue(deps);
  const url = (n: number): string => `blob:mock-${n}`;
  return { queue, synthCalls, plays, revoked, states, errors, stopPlayback, playDeferred, url };
}

describe('createPlaybackQueue', () => {
  it('plays strictly in enqueue order when syntheses resolve out of order', async () => {
    const h = setup();
    h.queue.enqueue('one');
    h.queue.enqueue('two');
    h.queue.enqueue('three');

    h.synthCalls[1].d.resolve(h.url(2));
    await flush();
    h.synthCalls[0].d.resolve(h.url(1));
    await flush();
    expect(h.plays).toEqual([h.url(1)]);

    h.playDeferred(h.url(1)).resolve();
    await flush();
    expect(h.plays).toEqual([h.url(1), h.url(2)]);

    h.synthCalls[2].d.resolve(h.url(3));
    await flush();
    expect(h.plays).toEqual([h.url(1), h.url(2)]);

    h.playDeferred(h.url(2)).resolve();
    await flush();
    expect(h.plays).toEqual([h.url(1), h.url(2), h.url(3)]);

    h.playDeferred(h.url(3)).resolve();
    await flush();
    expect(h.plays).toEqual([h.url(1), h.url(2), h.url(3)]);
  });

  it('runs at most two syntheses in flight', async () => {
    const h = setup();
    h.queue.enqueue('one');
    h.queue.enqueue('two');
    h.queue.enqueue('three');
    h.queue.enqueue('four');

    expect(h.synthCalls.map((c) => c.text)).toEqual(['one', 'two']);

    h.synthCalls[0].d.resolve(h.url(1));
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(['one', 'two', 'three']);

    h.synthCalls[1].d.resolve(h.url(2));
    h.synthCalls[2].d.resolve(h.url(3));
    await flush();
    expect(h.synthCalls.map((c) => c.text)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('stop() aborts in-flight syntheses, stops playback, revokes every URL and returns heardChars', async () => {
    const h = setup();
    h.queue.enqueue('one');
    h.queue.enqueue('two');
    h.queue.enqueue('three');
    h.queue.enqueue('four');

    h.synthCalls[0].d.resolve(h.url(1));
    await flush();
    h.synthCalls[1].d.resolve(h.url(2));
    await flush();
    h.playDeferred(h.url(1)).resolve();
    await flush();
    expect(h.plays).toEqual([h.url(1), h.url(2)]);

    const result = h.queue.stop();
    expect(result).toEqual({ heardChars: 'one'.length });
    expect(h.synthCalls.every((c) => c.signal.aborted)).toBe(true);
    expect(h.stopPlayback).toHaveBeenCalledTimes(1);
    expect(h.revoked).toEqual([h.url(1), h.url(2)]);

    h.synthCalls[2].d.resolve(h.url(3));
    h.playDeferred(h.url(2)).resolve();
    await flush();
    expect(h.revoked).toEqual([h.url(1), h.url(2), h.url(3)]);
    expect(h.plays).toEqual([h.url(1), h.url(2)]);
    expect(h.queue.speaking).toBe(false);
  });

  it('skips a failed synthesis and continues', async () => {
    const h = setup();
    const boom = new Error('boom');
    h.queue.enqueue('bad');
    h.queue.enqueue('good');

    h.synthCalls[0].d.reject(boom);
    await flush();
    expect(h.errors).toEqual([boom]);

    h.synthCalls[1].d.resolve(h.url(2));
    await flush();
    expect(h.plays).toEqual([h.url(2)]);

    h.playDeferred(h.url(2)).resolve();
    await flush();
    expect(h.queue.stop().heardChars).toBe('good'.length);
  });

  it('is reusable after stop() with a fresh heardChars count', async () => {
    const h = setup();
    h.queue.enqueue('one');
    h.synthCalls[0].d.resolve(h.url(1));
    await flush();
    h.playDeferred(h.url(1)).resolve();
    await flush();
    expect(h.queue.stop().heardChars).toBe('one'.length);

    h.queue.enqueue('two');
    h.synthCalls[1].d.resolve(h.url(2));
    await flush();
    h.playDeferred(h.url(2)).resolve();
    await flush();
    expect(h.queue.stop().heardChars).toBe('two'.length);
  });

  it('reports speaking and idle state transitions', async () => {
    const h = setup();
    h.queue.enqueue('one');
    expect(h.queue.speaking).toBe(false);

    h.synthCalls[0].d.resolve(h.url(1));
    await flush();
    expect(h.queue.speaking).toBe(true);
    expect(h.states).toEqual(['speaking']);

    h.playDeferred(h.url(1)).resolve();
    await flush();
    expect(h.queue.speaking).toBe(false);
    expect(h.states).toEqual(['speaking', 'idle']);
  });

  it('plays new speech after stop() even when the old play never resolves', async () => {
    const h = setup();
    h.queue.enqueue('one');
    h.synthCalls[0].d.resolve(h.url(1));
    await flush();
    expect(h.plays).toEqual([h.url(1)]);

    h.queue.stop();
    h.queue.enqueue('next.');
    expect(h.synthCalls.map((c) => c.text)).toEqual(['one', 'next.']);

    h.synthCalls[1].d.resolve(h.url(2));
    await flush();
    expect(h.plays).toEqual([h.url(1), h.url(2)]);
  });

  it('a stale synthesis resolving after stop() revokes its URL but does not start playback or change speaking', async () => {
    const h = setup();
    h.queue.enqueue('one');
    h.queue.enqueue('two');
    h.queue.stop();
    expect(h.queue.speaking).toBe(false);

    h.synthCalls[0].d.resolve(h.url(1));
    h.synthCalls[1].d.resolve(h.url(2));
    await flush();
    expect(h.revoked).toEqual([h.url(1), h.url(2)]);
    expect(h.plays).toEqual([]);
    expect(h.queue.speaking).toBe(false);
  });

  it('a stale play resolving after stop() does not add to heardChars or shift the new queue', async () => {
    const h = setup();
    h.queue.enqueue('one');
    h.synthCalls[0].d.resolve(h.url(1));
    await flush();
    expect(h.plays).toEqual([h.url(1)]);

    h.queue.stop();
    h.queue.enqueue('next.');
    h.synthCalls[1].d.resolve(h.url(2));
    await flush();
    h.playDeferred(h.url(1)).resolve();
    await flush();
    h.playDeferred(h.url(2)).resolve();
    await flush();
    expect(h.queue.stop().heardChars).toBe('next.'.length);
  });

  it('inflight after stop() allows 2 new syntheses while old ones are still pending', async () => {
    const h = setup();
    h.queue.enqueue('one');
    h.queue.enqueue('two');
    expect(h.synthCalls).toHaveLength(2);

    h.queue.stop();
    h.queue.enqueue('three');
    h.queue.enqueue('four');
    expect(h.synthCalls.map((c) => c.text)).toEqual(['one', 'two', 'three', 'four']);
  });
});