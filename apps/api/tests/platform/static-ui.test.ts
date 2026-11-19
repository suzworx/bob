import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createStaticUiHandler, resolveUiDist, staticUiRouteTemplate } from '../../src/platform/http/static-ui.ts';

const roots: string[] = [];
const servers: Server[] = [];
const INDEX_HTML = [
  '<!doctype html>',
  '<html lang="en" data-astryx-theme="bob">',
  '  <head>',
  '    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
  '    <title>Bob</title>',
  '    <link rel="icon" href="/favicon.ico" sizes="32x32" />',
  '    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
  '  </head>',
  '  <body><div id="root">bob-index</div></body>',
  '</html>',
  '',
].join('\n');

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

/** A raw HTTP request, because fetch cannot set the Host header a proxy or crawler sends. */
function send(base: string, path: string, headers: OutgoingHttpHeaders = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}${path}`, { method, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

/** Builds a throwaway tree holding a built index.html for each requested UI. */
function makeRoot(uis: Array<'ui' | 'ui-v2'>): string {
  const root = mkdtempSync(join(tmpdir(), 'bob-static-ui-'));
  roots.push(root);
  for (const ui of uis) {
    const dist = join(root, 'apps', ui, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html>');
  }
  return root;
}

/** Serves a temp dist (index.html plus assets/x.js) through the handler on a loopback port. */
async function serveDist(): Promise<string> {
  const dist = mkdtempSync(join(tmpdir(), 'bob-static-dist-'));
  roots.push(dist);
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), INDEX_HTML);
  writeFileSync(join(dist, 'assets', 'x.js'), 'export const x = 1;');
  const server = express().use(createStaticUiHandler(dist)).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveUiDist', () => {
  it('picks apps/ui-v2/dist when present', () => {
    const root = makeRoot(['ui-v2']);
    expect(resolveUiDist(root)).toBe(join(root, 'apps', 'ui-v2', 'dist'));
  });

  it('returns null when only apps/ui/dist exists (v1 is never served)', () => {
    const root = makeRoot(['ui']);
    expect(resolveUiDist(root)).toBeNull();
  });

  it('returns null when neither dist is present', () => {
    const root = makeRoot([]);
    expect(resolveUiDist(root)).toBeNull();
  });
});

describe('createStaticUiHandler', () => {
  it.each([
    ['GET', '/assets/private-build.js', 'static_asset'],
    ['GET', '/private-conversation', 'static_ui'],
    ['GET', '/api/private-id', null],
    ['GET', '/v2/private-id', null],
    ['GET', '/health', null],
    ['GET', '/metrics', null],
    ['GET', '/admin/monitoring', 'static_ui'],
    ['HEAD', '/assets/private-build.js', null],
    ['POST', '/private-conversation', null],
  ])('classifies %s requests with a fixed template while preserving serving exclusions', (method, path, template) => {
    expect(staticUiRouteTemplate(String(method), String(path))).toBe(template);
  });
  it.each(['/assets/missing-abc123.js', '/favicon-missing.png', '/assets/nested/gone', '/gone.webmanifest'])(
    'answers a missing file (%s) with a plain 404, never index.html',
    async (path) => {
      const response = await fetch(`${await serveDist()}${path}`);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type') ?? '').not.toContain('text/html');
      expect(await response.text()).not.toContain('bob-index');
    },
  );

  it.each(['/family', '/c/cnv_x', '/pair'])('falls back to a no-cache index.html for the route %s', async (path) => {
    const response = await fetch(`${await serveDist()}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toBe(INDEX_HTML);
  });

  it('serves an existing hashed asset as immutable', async () => {
    const response = await fetch(`${await serveDist()}/assets/x.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await response.text()).toBe('export const x = 1;');
  });

  it('serves index.html at / with no-cache', async () => {
    const response = await fetch(`${await serveDist()}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('leaves excluded paths to downstream handlers', async () => {
    const response = await fetch(`${await serveDist()}/api/nope`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('bob-index');
  });
});

const BOB_HOST = { host: 'app.heybob.xyz' };

describe('static UI on any host', () => {
  it.each([{}, BOB_HOST, { 'x-forwarded-host': 'app.heybob.xyz' }])('serves the one index.html byte-identical for %j', async (headers) => {
    const base = await serveDist();
    for (const path of ['/', '/index.html', '/c/cnv_x']) expect((await send(base, path, headers)).body).toBe(INDEX_HTML);
  });

  it('serves canonical monitoring deep links while preserving the reserved metrics path', async () => {
    const base = await serveDist();
    for (const headers of [{}, BOB_HOST]) {
      const response = await send(base, '/admin/monitoring', headers);
      expect(response.status).toBe(200);
      expect(response.body).toContain('bob-index');
      expect((await send(base, '/metrics', headers)).body).not.toContain('bob-index');
    }
  });
  it('keeps assets, exclusions and the HEAD pass-through unchanged on the Bob host', async () => {
    const base = await serveDist();
    const asset = await send(base, '/assets/x.js', BOB_HOST);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.body).toBe('export const x = 1;');
    expect((await send(base, '/assets/missing-abc.js', BOB_HOST)).status).toBe(404);
    for (const path of ['/api/nope', '/v2/nope', '/health', '/metrics']) expect((await send(base, path, BOB_HOST)).body).not.toContain('bob-index');
    expect((await send(base, '/', BOB_HOST, 'HEAD')).status).toBe((await send(base, '/', {}, 'HEAD')).status);
    expect((await send(base, '/', BOB_HOST, 'POST')).status).toBe(404);
  });
});
