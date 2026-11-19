import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createCorsMiddleware, parseAllowedOrigins } from '../../src/platform/http/cors.ts';

const servers: Server[] = [];

/** Builds a small app with the CORS middleware and starts it on a loopback port. */
async function createTestServer(middleware: ReturnType<typeof createCorsMiddleware>): Promise<string> {
  const app = express();
  app.use(middleware);
  // Dummy route to respond to all requests (GET, OPTIONS, etc).
  app.use((_request, response) => response.status(200).json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('parseAllowedOrigins', () => {
  it('returns empty array when env is unset', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });

  it('returns empty array when env is empty string', () => {
    expect(parseAllowedOrigins('')).toEqual([]);
  });

  it('parses comma-separated origins', () => {
    expect(parseAllowedOrigins('http://localhost:3000,https://app.example.com')).toEqual([
      'http://localhost:3000',
      'https://app.example.com',
    ]);
  });

  it('trims whitespace around origins', () => {
    expect(parseAllowedOrigins('  http://a.com  , https://b.com  ')).toEqual([
      'http://a.com',
      'https://b.com',
    ]);
  });

  it('drops empty origins after trimming', () => {
    expect(parseAllowedOrigins('http://a.com,  , https://b.com')).toEqual([
      'http://a.com',
      'https://b.com',
    ]);
  });
});

describe('createCorsMiddleware', () => {
  describe('with empty origins list (default)', () => {
    it('passes through a GET request with Origin header, no CORS headers', async () => {
      const url = await createTestServer(createCorsMiddleware([]));
      const response = await fetch(`${url}/api/test`, {
        headers: { 'Origin': 'http://localhost:3000' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('vary')).toBeNull();
    });

    it('passes through an OPTIONS request without turning it into 204', async () => {
      const url = await createTestServer(createCorsMiddleware([]));
      const response = await fetch(`${url}/api/test`, { method: 'OPTIONS' });
      // Middleware passes through; dummy handler responds with 200, no CORS headers.
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('with configured origins', () => {
    it('echoes an allowed origin back with Vary header', async () => {
      const url = await createTestServer(createCorsMiddleware(['http://localhost:3000']));
      const response = await fetch(`${url}/api/test`, {
        headers: { 'Origin': 'http://localhost:3000' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      expect(response.headers.get('vary')).toBe('Origin');
      expect(response.headers.get('access-control-expose-headers')).toContain('X-Bob-Trace-Id');
      expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
      expect(response.headers.get('access-control-allow-methods')).toContain('GET');
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('rejects a foreign origin with no CORS header', async () => {
      const url = await createTestServer(createCorsMiddleware(['http://localhost:3000']));
      const response = await fetch(`${url}/api/test`, {
        headers: { 'Origin': 'http://evil.com' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });

    it("answers an allowed origin's preflight with 204 and methods", async () => {
      const url = await createTestServer(createCorsMiddleware(['http://localhost:3000']));
      const response = await fetch(`${url}/api/test`, {
        method: 'OPTIONS',
        headers: { 'Origin': 'http://localhost:3000' },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      expect(response.headers.get('access-control-allow-methods')).toContain('POST');
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('allows the web app\'s X-Bob-* request headers on an allowed origin\'s preflight', async () => {
      const url = await createTestServer(createCorsMiddleware(['http://localhost:3000']));
      const requested = 'authorization, x-bob-client-session, x-bob-conversation, x-bob-ui-action-id, x-bob-ui-request-id, x-bob-expected-updated-at';
      const response = await fetch(`${url}/api/test`, {
        method: 'OPTIONS',
        headers: { 'Origin': 'http://localhost:3000', 'Access-Control-Request-Headers': requested },
      });
      expect(response.status).toBe(204);
      const allowed = (response.headers.get('access-control-allow-headers') ?? '').split(',').map((h) => h.trim());
      for (const header of requested.split(', ')) expect(allowed).toContain(header);
      expect(allowed).toContain('content-type');
    });

    it('still refuses a disallowed origin asking for those headers', async () => {
      const url = await createTestServer(createCorsMiddleware(['http://localhost:3000']));
      const response = await fetch(`${url}/api/test`, {
        method: 'OPTIONS',
        headers: { 'Origin': 'http://evil.com', 'Access-Control-Request-Headers': 'x-bob-client-session' },
      });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('access-control-allow-headers')).toBeNull();
    });

    it("rejects a foreign origin's preflight with no CORS header", async () => {
      const url = await createTestServer(createCorsMiddleware(['http://localhost:3000']));
      const response = await fetch(`${url}/api/test`, {
        method: 'OPTIONS',
        headers: { 'Origin': 'http://evil.com' },
      });
      // Foreign origin: middleware passes through with no CORS headers, dummy responds 200.
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('handles multiple configured origins', async () => {
      const url = await createTestServer(
        createCorsMiddleware(['http://localhost:3000', 'https://app.example.com']),
      );
      const response1 = await fetch(`${url}/api/test`, {
        headers: { 'Origin': 'http://localhost:3000' },
      });
      expect(response1.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');

      const response2 = await fetch(`${url}/api/test`, {
        headers: { 'Origin': 'https://app.example.com' },
      });
      expect(response2.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    });
  });
});
