/**
 * The unit a feature registers with the server (issue #619). server.ts builds
 * `AppDeps` once, then walks a list of modules: each one mounts its HTTP routes
 * (and, for the device socket, its WebSocket route) and may start background
 * work. Adding a feature is one entry in that list and no other server.ts edit.
 */
import { withDetachedTelemetryContext } from '@bob/ai';
import type { WebSocketExpress } from 'websocket-express';
import type { AppDeps } from './app-deps.ts';
import { traceSynchronousWorkflow, traceWorkflow } from './platform/observability/workflow-diagnostics.ts';

export interface ApiModule {
  /** Stable name, used in journal lines and tests. */
  name: string;
  /** Mounts this module's routes on the app, under the guards server.ts has already installed. */
  mount?(app: WebSocketExpress, deps: AppDeps): void;
  /** Starts background work once the server is listening; resolves to its `stop()`. */
  start?(deps: AppDeps): Promise<() => Promise<void>>;
}

/** Mounts every module in list order (registration order is route order). */
export function mountModules(modules: readonly ApiModule[], app: WebSocketExpress, deps: AppDeps): void {
  for (const module of modules) {
    if (module.mount) traceSynchronousWorkflow('module-mount', { detached: true, metadata: { action: module.name } },
      () => module.mount?.(app, deps));
  }
}

/** Starts every module's background work in list order; returns one function that stops them all, last started first. */
export async function startModules(modules: readonly ApiModule[], deps: AppDeps): Promise<() => Promise<void>> {
  const stops: Array<() => Promise<void>> = [];
  for (const module of modules) {
    const start = module.start;
    if (start) {
      const attrs = { detached: true, metadata: { action: module.name } };
      // The span measures start; the work start schedules (timers, loops) must not inherit it.
      const stop = await traceWorkflow('module-start', attrs,
        () => withDetachedTelemetryContext(() => start.call(module, deps)));
      stops.push(() => traceWorkflow('module-stop', attrs, stop));
    }
  }
  return async (): Promise<void> => {
    for (const stop of stops.reverse()) await stop();
  };
}
