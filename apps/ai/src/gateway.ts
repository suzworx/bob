/**
 * The AI Gateway provider, with its fetch. Apart from agents.ts so tools.ts can
 * build the TTS model from the same instance without an import cycle.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createGateway } from '@ai-sdk/gateway';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import {
  AI_GATEWAY_API_KEY,
  BOB_GATEWAY_BASE_URL,
  BOB_GATEWAY_KEEPALIVE_MS,
} from './config.ts';

/** `performance.now()` marks of the TTS HTTP call that the gateway's timing fetch writes while a store is active. */
export interface TtsFetchMarks { start?: number; headers?: number; lastByte?: number }

export const ttsTimingStore = new AsyncLocalStorage<TtsFetchMarks>();

/**
 * A fetch whose pool keeps idle sockets for `keepAliveMs`, so a call
 * after a pause skips the TCP+TLS handshake. It uses npm undici's own fetch
 * with its own Agent (never Node's bundled fetch, never the global
 * dispatcher, which Supabase and email requests share).
 */
function keepAliveFetch(keepAliveMs: number): typeof globalThis.fetch {
  const dispatcher = new UndiciAgent({ keepAliveTimeout: keepAliveMs, keepAliveMaxTimeout: keepAliveMs });
  return ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(input, { ...init, dispatcher })) as unknown as typeof globalThis.fetch;
}

/**
 * Passes every call through to `base`. While a TTS call's marks store is
 * active it records when the response headers arrive and when the body ends,
 * as `performance.now()` marks. The body is piped through untouched; nothing
 * of it, the URL or the headers is read or kept.
 */
export function withTtsTiming(base: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const marks = ttsTimingStore.getStore();
    if (marks === undefined) return base(input, init);
    // A retry is a new fetch: its marks replace the failed attempt's.
    Object.assign(marks, { start: performance.now(), headers: undefined, lastByte: undefined });
    const response = await base(input, init);
    marks.headers = performance.now();
    if (response.body === null) {
      marks.lastByte = marks.headers;
      return response;
    }
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      flush: () => { marks.lastByte = performance.now(); },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof globalThis.fetch;
}

/** Gateway provider instance created from the configured API key. Its fetch is always the timing wrapper. */
export const gateway = createGateway({
  apiKey: AI_GATEWAY_API_KEY,
  ...(BOB_GATEWAY_BASE_URL ? { baseURL: BOB_GATEWAY_BASE_URL } : {}),
  fetch: withTtsTiming(keepAliveFetch(BOB_GATEWAY_KEEPALIVE_MS)),
});

// STT passes string model ids, which the SDK resolves through this global
// (else its own gateway), so it shares the pool, and it also
// honours BOB_GATEWAY_BASE_URL. TTS passes the instance, so it needs none of this.
globalThis.AI_SDK_DEFAULT_PROVIDER = gateway;
