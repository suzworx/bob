// core/email-client.ts tests: an unconfigured client skips (journals, never
// fetches), a 2xx resolves, a non-2xx or a hung server throws EmailSendError,
// and no journal line carries the address or the template data. A real local
// http server stands in for notify-email.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setJournalSink } from '../../src/platform/logger.ts';
import { EmailSendError, appUrl, emailConfigured, sendTemplateEmail } from '../../src/notifications/email-client.ts';

type Received = { auth: string | undefined; body: unknown };

let server: Server;
let baseUrl: string;
let reply: (res: ServerResponse) => void = (res) => res.end('{"ok":true}');
const received: Received[] = [];
const lines: string[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      });
      reply(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setJournalSink((line) => lines.push(line));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  received.length = 0;
  lines.length = 0;
  reply = (res) => res.end('{"ok":true}');
});

function configure(): void {
  vi.stubEnv('BOB_NOTIFY_EMAIL_URL', `${baseUrl}/functions/v1/notify-email`);
  vi.stubEnv('BOB_NOTIFY_EMAIL_SECRET', 'test-secret');
}

const INPUT = { template: 'task-assigned', to: 'maya@example.com', data: { taskTitle: 'Buy milk' } };

function assertNoPrivateData(): void {
  const all = lines.join('\n');
  expect(all).not.toContain('maya@example.com');
  expect(all).not.toContain('Buy milk');
  expect(all).not.toContain('test-secret');
}

describe('email client', () => {
  it('is not configured without both env vars, and then skips without a request', async () => {
    vi.stubEnv('BOB_NOTIFY_EMAIL_URL', '');
    vi.stubEnv('BOB_NOTIFY_EMAIL_SECRET', 'test-secret');
    expect(emailConfigured()).toBe(false);
    await expect(sendTemplateEmail(INPUT)).resolves.toBeUndefined();
    expect(received).toHaveLength(0);
    expect(lines.some((line) => line.includes('"v2.email_skipped"'))).toBe(true);
    assertNoPrivateData();
  });

  it('POSTs template, to and data with the bearer secret and resolves on 2xx', async () => {
    configure();
    expect(emailConfigured()).toBe(true);
    await sendTemplateEmail(INPUT);
    expect(received).toEqual([{ auth: 'Bearer test-secret', body: INPUT }]);
    expect(lines.some((line) => line.includes('"v2.email_sent"'))).toBe(true);
    assertNoPrivateData();
  });

  it('throws EmailSendError with the status code on a non-2xx', async () => {
    configure();
    reply = (res) => {
      res.statusCode = 502;
      res.end('{"ok":false,"error":"send_failed"}');
    };
    const error = await sendTemplateEmail(INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSendError);
    expect((error as EmailSendError).code).toBe('http_502');
    assertNoPrivateData();
  });

  it('throws a timeout EmailSendError when notify-email never answers', async () => {
    configure();
    reply = () => undefined; // never respond
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), 50);
      return controller.signal;
    });
    const error = await sendTemplateEmail(INPUT).catch((e: unknown) => e);
    expect(timeout).toHaveBeenCalledWith(10_000);
    timeout.mockRestore();
    expect(error).toBeInstanceOf(EmailSendError);
    expect((error as EmailSendError).code).toBe('timeout');
  });

  it('throws a network EmailSendError when nothing is listening', async () => {
    vi.stubEnv('BOB_NOTIFY_EMAIL_URL', 'http://127.0.0.1:1/notify-email');
    vi.stubEnv('BOB_NOTIFY_EMAIL_SECRET', 'test-secret');
    const error = await sendTemplateEmail(INPUT).catch((e: unknown) => e);
    expect((error as EmailSendError).code).toBe('network');
  });

  it('builds app URLs from BOB_APP_URL, defaulting to the hosted app', () => {
    vi.stubEnv('BOB_APP_URL', '');
    expect(appUrl('/today')).toBe('https://app.heybob.xyz/today');
    vi.stubEnv('BOB_APP_URL', 'http://localhost:5173/');
    expect(appUrl('spaces/x')).toBe('http://localhost:5173/spaces/x');
  });
});
