// core/account-provisioning.ts tests: unconfigured skips without a request, the
// invite-account URL derives from the notify-email one (or its override), a
// created/exists answer maps through, and a 5xx, a hung server or nothing
// listening resolves 'failed' -- never throws. No journal line carries the
// address or the secret. A real local http server stands in for invite-account.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setJournalSink } from '../../src/platform/logger.ts';
import { ensureInviteeAccount, inviteAccountUrl } from '../../src/account/provisioning.ts';

type Received = { path: string | undefined; auth: string | undefined; body: unknown };

let server: Server;
let baseUrl: string;
let reply: (res: ServerResponse) => void = (res) => res.end('{"ok":true,"created":true}');
const received: Received[] = [];
const lines: string[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ path: req.url, auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
      reply(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setJournalSink((line) => lines.push(line));
});

afterAll(async () => {
  setJournalSink(null);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.unstubAllEnvs();
  received.length = 0;
  lines.length = 0;
  reply = (res) => res.end('{"ok":true,"created":true}');
});

function configure(): void {
  vi.stubEnv('BOB_INVITE_ACCOUNT_URL', '');
  vi.stubEnv('BOB_NOTIFY_EMAIL_URL', `${baseUrl}/functions/v1/notify-email`);
  vi.stubEnv('BOB_NOTIFY_EMAIL_SECRET', 'test-secret');
}

function assertNoPrivateData(): void {
  const all = lines.join('\n');
  expect(all).not.toContain('arjun@example.com');
  expect(all).not.toContain('test-secret');
}

describe('inviteAccountUrl', () => {
  it('derives from the notify-email URL, and the override wins', () => {
    vi.stubEnv('BOB_INVITE_ACCOUNT_URL', '');
    vi.stubEnv('BOB_NOTIFY_EMAIL_URL', 'https://ref.supabase.co/functions/v1/notify-email');
    expect(inviteAccountUrl()).toBe('https://ref.supabase.co/functions/v1/invite-account');
    vi.stubEnv('BOB_NOTIFY_EMAIL_URL', 'https://ref.supabase.co/functions/v1/notify-email/');
    expect(inviteAccountUrl()).toBe('https://ref.supabase.co/functions/v1/invite-account');
    vi.stubEnv('BOB_INVITE_ACCOUNT_URL', 'https://elsewhere.example/invite-account');
    expect(inviteAccountUrl()).toBe('https://elsewhere.example/invite-account');
  });

  it('is null when nothing is set or the notify-email URL has another shape', () => {
    vi.stubEnv('BOB_INVITE_ACCOUNT_URL', '');
    vi.stubEnv('BOB_NOTIFY_EMAIL_URL', '');
    expect(inviteAccountUrl()).toBeNull();
    vi.stubEnv('BOB_NOTIFY_EMAIL_URL', 'https://mail.example/send');
    expect(inviteAccountUrl()).toBeNull();
  });
});

describe('ensureInviteeAccount', () => {
  it('skips without a request when not configured', async () => {
    vi.stubEnv('BOB_INVITE_ACCOUNT_URL', '');
    vi.stubEnv('BOB_NOTIFY_EMAIL_URL', '');
    vi.stubEnv('BOB_NOTIFY_EMAIL_SECRET', '');
    expect(await ensureInviteeAccount('arjun@example.com')).toBe('skipped');
    expect(received).toHaveLength(0);
    expect(lines.join('\n')).toContain('"outcome":"skipped"');
  });

  it('posts the address with the shared bearer and maps created / exists', async () => {
    configure();
    expect(await ensureInviteeAccount('arjun@example.com')).toBe('created');
    expect(received[0]).toEqual({ path: '/functions/v1/invite-account',
      auth: 'Bearer test-secret', body: { email: 'arjun@example.com' } });
    reply = (res) => res.end('{"ok":true,"created":false}');
    expect(await ensureInviteeAccount('arjun@example.com')).toBe('exists');
    assertNoPrivateData();
  });

  it('resolves failed on a 5xx or an unexpected body', async () => {
    configure();
    reply = (res) => { res.statusCode = 502; res.end('{"ok":false,"error":"provision_failed"}'); };
    expect(await ensureInviteeAccount('arjun@example.com')).toBe('failed');
    expect(lines.join('\n')).toContain('"code":"http_502"');
    reply = (res) => res.end('not json');
    expect(await ensureInviteeAccount('arjun@example.com')).toBe('failed');
    assertNoPrivateData();
  });

  it('resolves failed on a timeout or when nothing is listening, never throws', async () => {
    configure();
    reply = () => undefined; // never respond
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), 50);
      return controller.signal;
    });
    expect(await ensureInviteeAccount('arjun@example.com')).toBe('failed');
    expect(timeout).toHaveBeenCalledWith(10_000);
    timeout.mockRestore();
    expect(lines.join('\n')).toContain('"code":"timeout"');

    vi.stubEnv('BOB_INVITE_ACCOUNT_URL', 'http://127.0.0.1:1/invite-account');
    expect(await ensureInviteeAccount('arjun@example.com')).toBe('failed');
    expect(lines.join('\n')).toContain('"code":"network"');
    assertNoPrivateData();
  });
});
