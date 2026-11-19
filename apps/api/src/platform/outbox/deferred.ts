/** An expected delivery delay (for example recipient quiet hours), not a failed attempt. */
export class OutboxDeferredError extends Error {
  readonly retryInMs: number;
  constructor(retryInMs: number) {
    super('delivery_deferred');
    this.name = 'OutboxDeferredError';
    this.retryInMs = Math.max(1_000,Math.min(86_400_000,Number.isFinite(retryInMs) ? Math.floor(retryInMs) : 60_000));
  }
}
