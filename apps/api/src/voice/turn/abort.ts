/** Waits, returning early (never rejecting) when the signal aborts. */
export function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The turn was cancelled by the device; not a failure. */
export class TurnCancelledError extends Error {
  constructor() {
    super('turn cancelled');
    this.name = 'TurnCancelledError';
  }
}

/**
 * Settles with `promise`, or rejects with TurnCancelledError as soon as the
 * signal aborts -- the pipeline stops waiting at once. A stage that cannot take
 * a signal itself (the STT/TTS adapters) is abandoned: its late result or
 * rejection is consumed here and never used.
 */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new TurnCancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new TurnCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}
