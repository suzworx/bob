import { z } from 'zod';
import { GoogleCredentialError, type GoogleCapability } from './google-credentials.ts';

const subjectSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const capabilitiesSchema = z.array(z.enum(['calendar.read', 'calendar.write', 'gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify'])).max(6);
const tokenSchema = z.object({ token: z.string().min(1).max(16384).regex(/^[A-Za-z0-9._~+/-]+=*$/), expiresAt: z.number().positive() }).strict();
const authorizationSchema = z.object({ url: z.string().url().refine((value) => new URL(value).protocol === 'https:'), expiresAt: z.number().positive().optional() }).strict();
const revokedSchema = z.object({ ok: z.literal(true) }).strict();
const errorSchema = z.object({ error: z.object({ code: z.enum(['reconnect_required', 'permission_required', 'unavailable']) }) });

interface BridgeOptions {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Server-only boundary; callers must derive subject from owned durable state. */
export interface GoogleBridge {
  authorize(subject: string, capabilities: GoogleCapability[], callbackUrl: string, signal?: AbortSignal): Promise<z.infer<typeof authorizationSchema>>;
  token(subject: string, capabilities: GoogleCapability[], signal?: AbortSignal): Promise<z.infer<typeof tokenSchema>>;
  revoke(subject: string, signal?: AbortSignal): Promise<void>;
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new GoogleCredentialError('unavailable');
  const reader = response.body.getReader();
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 32768) throw new GoogleCredentialError('unavailable');
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}

export function createGoogleBridge(options: BridgeOptions): GoogleBridge {
  const url = new URL(options.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !/^[A-Za-z0-9_-]{32,256}$/.test(options.secret)) throw new GoogleCredentialError('unavailable');
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new GoogleCredentialError('unavailable');

  async function request<T>(body: Record<string, unknown>, schema: z.ZodType<T>, callerSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let onAbort: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = (): void => reject(new GoogleCredentialError('unavailable'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      if (signal.aborted) throw new GoogleCredentialError('unavailable');
      const work = async (): Promise<T> => {
        const response = await fetcher(url.href, {
          method: 'POST', headers: { authorization: `Bearer ${options.secret}`, 'content-type': 'application/json' },
          body: JSON.stringify(body), redirect: 'error', cache: 'no-store', signal,
        });
        const data = await readResponse(response, signal);
        if (!response.ok) {
          const error = errorSchema.safeParse(data);
          throw new GoogleCredentialError(error.success ? error.data.error.code : 'unavailable');
        }
        return schema.parse(data);
      };
      return await Promise.race([work(), cancelled]);
    } catch (error) {
      throw new GoogleCredentialError(error instanceof GoogleCredentialError ? error.code : 'unavailable');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }

  return {
    authorize: (subject, capabilities, callbackUrl, signal) => request({ action: 'authorize', subject: subjectSchema.parse(subject), capabilities: capabilitiesSchema.min(1).parse(capabilities), callbackUrl }, authorizationSchema, signal),
    token: (subject, capabilities, signal) => request({ action: 'token', subject: subjectSchema.parse(subject), capabilities: capabilitiesSchema.parse(capabilities) }, tokenSchema, signal),
    async revoke(subject, signal): Promise<void> {
      await request({ action: 'revoke', subject: subjectSchema.parse(subject) }, revokedSchema, signal);
    },
  };
}
