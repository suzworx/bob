export interface MicLock {
  readonly held: boolean;
  readonly reason?: string;
  release(): void;
}

export interface LockEnv {
  readonly navigator: { readonly locks?: LockManager };
  readonly BroadcastChannel?: typeof BroadcastChannel;
}

interface AcquireLockOptions {
  readonly name?: string;
  readonly onLost?: () => void;
  readonly env?: LockEnv;
}

const DEFAULT_LOCK_NAME = 'bob.microphone';

const CLAIM_WINDOW_MS = 150;
const HEARTBEAT_INTERVAL_MS = 1000;
const SINGLE_TAB_REASON = 'no cross-tab lock API available';

type BcMessage =
  | { readonly kind: 'claim'; readonly id: string }
  | { readonly kind: 'held'; readonly id: string; readonly for: string }
  | { readonly kind: 'heartbeat'; readonly id: string }
  | { readonly kind: 'released'; readonly id: string };

const noopRelease = (): void => {};

function defaultEnv(): LockEnv {
  return {
    navigator:
      typeof navigator === 'undefined'
        ? {}
        : (navigator as unknown as { readonly locks?: LockManager }),
    BroadcastChannel:
      typeof BroadcastChannel === 'undefined' ? undefined : BroadcastChannel,
  };
}

export async function acquireMicLock(opts: AcquireLockOptions = {}): Promise<MicLock> {
  const name = opts.name ?? DEFAULT_LOCK_NAME;
  const env = opts.env ?? defaultEnv();
  if (env.navigator.locks) {
    return await acquireWithWebLocks(env.navigator.locks, name);
  }
  if (env.BroadcastChannel) {
    return await acquireWithBroadcast(env.BroadcastChannel, name, opts.onLost);
  }
  return { held: true, reason: SINGLE_TAB_REASON, release: noopRelease };
}

function acquireWithWebLocks(locks: LockManager, name: string): Promise<MicLock> {
  return new Promise<MicLock>((resolve) => {
    let settled = false;
    let release = noopRelease;
    const held = new Promise<void>((res) => {
      release = () => res();
    });
    void locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          if (!settled) {
            settled = true;
            resolve({ held: false, release: noopRelease });
          }
          return undefined;
        }
        if (!settled) {
          settled = true;
          resolve({ held: true, release });
        }
        return held;
      })
      .catch(() => {
        if (!settled) {
          settled = true;
          resolve({ held: false, release: noopRelease });
        }
      });
  });
}

function acquireWithBroadcast(
  Bc: typeof BroadcastChannel,
  name: string,
  onLost: (() => void) | undefined,
): Promise<MicLock> {
  return new Promise<MicLock>((resolve) => {
    const id = randomTabId();
    const channel = new Bc(name);
    type Phase = 'claiming' | 'holding' | 'done';
    let phase: Phase = 'claiming';
    let settled = false;
    let released = false;
    let windowTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

    const send = (message: BcMessage): void => {
      channel.postMessage(message);
    };

    const clearTimers = (): void => {
      if (windowTimer !== null) clearTimeout(windowTimer);
      if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
      windowTimer = null;
      heartbeatTimer = null;
    };

    const close = (): void => {
      clearTimers();
      channel.close();
    };

    const finish = (lock: MicLock): void => {
      if (settled) return;
      settled = true;
      resolve(lock);
    };

    const startHeartbeat = (): void => {
      const beat = (): void => {
        if (phase !== 'holding') return;
        send({ kind: 'heartbeat', id });
        heartbeatTimer = setTimeout(beat, HEARTBEAT_INTERVAL_MS);
      };
      heartbeatTimer = setTimeout(beat, HEARTBEAT_INTERVAL_MS);
    };

    const becomeHolder = (): void => {
      if (phase !== 'claiming') return;
      phase = 'holding';
      startHeartbeat();
      finish({ held: true, release });
    };

    const handle = (message: BcMessage): void => {
      switch (message.kind) {
        case 'claim':
          if (phase === 'holding') send({ kind: 'held', id, for: message.id });
          break;
        case 'held':
          if (phase === 'claiming' && message.for === id) {
            phase = 'done';
            close();
            finish({ held: false, release: noopRelease });
          }
          break;
        case 'heartbeat':
          if (phase === 'holding' && message.id !== id && message.id > id) {
            phase = 'done';
            close();
            onLost?.();
          }
          break;
        case 'released':
          break;
      }
    };

    const release = (): void => {
      if (released) return;
      released = true;
      if (phase === 'holding') send({ kind: 'released', id });
      phase = 'done';
      clearTimers();
      channel.close();
    };

    channel.onmessage = (event: MessageEvent<BcMessage>) => {
      handle(event.data);
    };

    send({ kind: 'claim', id });
    if (phase === 'claiming') {
      windowTimer = setTimeout(() => {
        if (phase === 'claiming') becomeHolder();
      }, CLAIM_WINDOW_MS);
    }
  });
}

function randomTabId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}