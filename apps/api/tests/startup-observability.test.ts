import type { WebSocketExpress } from 'websocket-express';
import { afterEach, expect, it, vi } from 'vitest';
import { traceSpan } from '@bob/ai';
import { mountModules, startModules, type ApiModule } from '../src/api-module.ts';
import type { AppDeps } from '../src/app-deps.ts';

vi.mock('@bob/ai', async (original) => ({
  ...(await original<typeof import('@bob/ai')>()), traceSpan: vi.fn(async (_name, _attrs, fn: () => unknown) => fn()),
}));
afterEach(() => vi.clearAllMocks());

it('covers all module lifecycle dispatcher variants while preserving mount/start/stop order', async () => {
  const order: string[] = [];
  const module: ApiModule = { name: 'test-worker', mount: () => { order.push('mount'); },
    start: async () => { order.push('start'); return async () => { order.push('stop'); }; } };
  mountModules([module], {} as WebSocketExpress, {} as AppDeps);
  expect(order).toEqual(['mount']);
  const stop = await startModules([module], {} as AppDeps);
  await stop();
  expect(order).toEqual(['mount', 'start', 'stop']);
  expect(vi.mocked(traceSpan).mock.calls.map((call) => call[0])).toEqual(['module-mount', 'module-start', 'module-stop']);
});
