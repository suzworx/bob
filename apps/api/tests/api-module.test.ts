import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebSocketExpress } from 'websocket-express';
import { mountModules, startModules, type ApiModule } from '../src/api-module.ts';
import type { AppDeps } from '../src/app-deps.ts';
import { journal, setJournalSink } from '../src/platform/logger.ts';

// Tracing is a no-op without OTLP config, so the workflow wrapper is replaced by
// a real span on a real tracer: the test needs an active module-start span.
vi.mock('../src/platform/observability/workflow-diagnostics.ts', () => ({
  traceSynchronousWorkflow: (_name: string, _attrs: unknown, work: () => unknown) => work(),
  traceWorkflow: (name: string, _attrs: unknown, work: (setOutcome: () => void) => unknown) =>
    trace.getTracer('test').startActiveSpan(name, async (span) => {
      try {
        return await work(() => undefined);
      } finally {
        span.end();
      }
    }),
}));

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new BasicTracerProvider());
});

afterAll(() => {
  trace.disable();
  context.disable();
});

const app = {} as WebSocketExpress;
const deps = {} as AppDeps;

describe('mountModules', () => {
  it('mounts every module in list order and skips modules with nothing to mount', () => {
    const order: string[] = [];
    const modules: ApiModule[] = [
      { name: 'a', mount: () => { order.push('a'); } },
      { name: 'background-only' },
      { name: 'b', mount: (mounted, given) => { order.push(`b:${mounted === app}:${given === deps}`); } },
    ];
    mountModules(modules, app, deps);
    expect(order).toEqual(['a', 'b:true:true']);
  });
});

describe('startModules', () => {
  it('starts in list order and stops in reverse, one combined stop function', async () => {
    const order: string[] = [];
    const worker = (name: string): ApiModule => ({
      name,
      start: async () => { order.push(`start ${name}`); return async () => { order.push(`stop ${name}`); }; },
    });
    const stop = await startModules([worker('memories'), { name: 'routes-only' }, worker('timers')], deps);
    expect(order).toEqual(['start memories', 'start timers']);
    await stop();
    expect(order).toEqual(['start memories', 'start timers', 'stop timers', 'stop memories']);
  });

  it('runs background ticks scheduled by start outside the module-start span', async () => {
    const lines: string[] = [];
    setJournalSink((line) => lines.push(line));
    let startSpanId: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const looping: ApiModule = {
      name: 'looping',
      start: async () => {
        startSpanId = trace.getActiveSpan()?.spanContext().spanId;
        timer = setTimeout(() => journal('test.tick'), 5);
        return async () => undefined;
      },
    };
    try {
      const stop = await startModules([looping], deps);
      await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0));
      await stop();
    } finally {
      clearTimeout(timer);
      setJournalSink(null);
    }
    const tick = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(tick.event).toBe('test.tick');
    expect(tick).not.toHaveProperty('trace_id');
    expect(tick).not.toHaveProperty('span_id');
    expect(startSpanId).toBeUndefined();
  });

  it('awaits each start before the next and returns a no-op stop when nothing starts', async () => {
    const gate = vi.fn();
    const slow: ApiModule = { name: 'slow', start: async () => { await Promise.resolve(); gate('slow'); return async () => undefined; } };
    const next: ApiModule = { name: 'next', start: async () => { gate('next'); return async () => undefined; } };
    await startModules([slow, next], deps);
    expect(gate.mock.calls.map(([name]) => name)).toEqual(['slow', 'next']);
    await expect((await startModules([{ name: 'none' }], deps))()).resolves.toBeUndefined();
  });
});
