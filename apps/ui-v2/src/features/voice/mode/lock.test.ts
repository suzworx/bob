import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireMicLock, type LockEnv, type MicLock } from './lock';

interface BroadcastHub {
  channels: FakeBroadcastChannel[];
  suppressed: Set<FakeBroadcastChannel>;
  closed: Set<FakeBroadcastChannel>;
  sent: Array<{ from: FakeBroadcastChannel; data: { kind: string } }>;
}

class FakeBroadcastChannel {
  readonly name: string;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  private closed = false;
  private readonly hub: BroadcastHub;

  constructor(name: string, hub: BroadcastHub) {
    this.name = name;
    this.hub = hub;
    hub.channels.push(this);
  }

  postMessage(data: { kind: string }): void {
    this.hub.sent.push({ from: this, data });
    if (this.closed || this.hub.suppressed.has(this)) return;
    for (const other of this.hub.channels) {
      if (other === this || other.closed || other.name !== this.name) continue;
      other.onmessage?.({ data });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.hub.closed.add(this);
  }
}

const createHub = (): BroadcastHub => ({
  channels: [],
  suppressed: new Set(),
  closed: new Set(),
  sent: [],
});

const envWithChannel = (hub: BroadcastHub): LockEnv => {
  const Bc = class extends FakeBroadcastChannel {
    constructor(name: string) {
      super(name, hub);
    }
  };
  return {
    navigator: {},
    BroadcastChannel: Bc as unknown as typeof BroadcastChannel,
  };
};

class FakeLockManager {
  private held: object | null = null;

  async request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: Lock | null) => unknown,
  ): Promise<unknown> {
    if (this.held && options.ifAvailable) {
      return await callback(null);
    }
    if (!this.held) {
      this.held = {};
      const result = callback({ name } as Lock);
      await result;
      this.held = null;
      return result;
    }
    return await callback(null);
  }
}

const envWithLocks = (locks: LockManager): LockEnv => ({
  navigator: { locks },
  BroadcastChannel: undefined,
});

describe('acquireMicLock web locks path', () => {
  it('first holds, the second is denied, and after a release a third acquires', async () => {
    const env = envWithLocks(new FakeLockManager() as unknown as LockManager);
    const first = await acquireMicLock({ env });
    expect(first.held).toBe(true);
    const second = await acquireMicLock({ env });
    expect(second.held).toBe(false);
    first.release();
    first.release();
    await Promise.resolve();
    const third = await acquireMicLock({ env });
    expect(third.held).toBe(true);
    third.release();
  });
});

describe('acquireMicLock broadcast channel fallback', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function acquireAfterWindow(
    env: LockEnv,
    opts: { onLost?: () => void } = {},
  ): Promise<MicLock> {
    const promise = acquireMicLock({ env, ...opts });
    await vi.advanceTimersByTimeAsync(200);
    return await promise;
  }

  it('first holds, the second is denied, and after a release a third acquires', async () => {
    vi.useFakeTimers();
    const env = envWithChannel(createHub());
    const first = await acquireAfterWindow(env);
    expect(first.held).toBe(true);
    const second = await acquireAfterWindow(env);
    expect(second.held).toBe(false);
    first.release();
    first.release();
    const third = await acquireAfterWindow(env);
    expect(third.held).toBe(true);
    third.release();
  });

  it('a denied tab leaves no pending timers and closes its channel', async () => {
    vi.useFakeTimers();
    const hub = createHub();
    const env = envWithChannel(hub);
    const first = await acquireAfterWindow(env);
    expect(first.held).toBe(true);
    const denied = await acquireAfterWindow(env);
    expect(denied.held).toBe(false);
    expect(hub.closed.has(hub.channels[1])).toBe(true);
    first.release();
    expect(vi.getTimerCount()).toBe(0);
    denied.release();
    denied.release();
  });

  it('a holder that disappears without released lets the next claim acquire', async () => {
    vi.useFakeTimers();
    const hub = createHub();
    const env = envWithChannel(hub);
    const first = await acquireAfterWindow(env);
    expect(first.held).toBe(true);
    hub.suppressed.add(hub.channels[0]);
    const second = await acquireAfterWindow(env);
    expect(second.held).toBe(true);
    second.release();
  });

  it('two simultaneous claims end with exactly one holder and onLost fires once on the higher id', async () => {
    vi.useFakeTimers();
    const hub = createHub();
    const env = envWithChannel(hub);
    const onLostA = vi.fn();
    const onLostB = vi.fn();
    const promiseA = acquireMicLock({ env, onLost: onLostA });
    const promiseB = acquireMicLock({ env, onLost: onLostB });
    await vi.advanceTimersByTimeAsync(200);
    const a = await promiseA;
    const b = await promiseB;
    expect(a.held).toBe(true);
    expect(b.held).toBe(true);
    await vi.advanceTimersByTimeAsync(1100);
    expect(onLostA.mock.calls.length + onLostB.mock.calls.length).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('release is idempotent and posts released once', async () => {
    vi.useFakeTimers();
    const hub = createHub();
    const env = envWithChannel(hub);
    const first = await acquireAfterWindow(env);
    expect(first.held).toBe(true);
    first.release();
    first.release();
    first.release();
    const released = hub.sent.filter(
      (m) => m.from === hub.channels[0] && m.data.kind === 'released',
    );
    expect(released.length).toBe(1);
    expect(hub.closed.has(hub.channels[0])).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('there is no takeover: a denied tab never becomes a holder later', async () => {
    vi.useFakeTimers();
    const hub = createHub();
    const env = envWithChannel(hub);
    const first = await acquireAfterWindow(env);
    expect(first.held).toBe(true);
    const denied = await acquireAfterWindow(env);
    expect(denied.held).toBe(false);
    hub.suppressed.add(hub.channels[0]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(denied.held).toBe(false);
    const heartbeats = hub.sent.filter(
      (m) => m.from === hub.channels[1] && m.data.kind === 'heartbeat',
    );
    expect(heartbeats.length).toBe(0);
    denied.release();
  });
});

describe('acquireMicLock degradation', () => {
  it('holds with a visible reason when neither API exists', async () => {
    const lock = await acquireMicLock({
      env: { navigator: {}, BroadcastChannel: undefined },
    });
    expect(lock.held).toBe(true);
    expect(lock.reason).toBeDefined();
    lock.release();
    lock.release();
  });
});