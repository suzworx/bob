import type { AddressInfo } from 'node:net';
import { existsSync, readdirSync } from 'node:fs';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createHttpRouteInventory } from '../../src/platform/observability/http-route-inventory.ts';
import { createOpenApiDocument, mountApiDocs } from '../../src/platform/http/api-docs.ts';
import { route } from '../../src/platform/http/route.ts';
import { webApiDocOverrides } from '../../src/web-api-docs.ts';
import { webApiResponseDocOverrides } from '../../src/web-api-response-docs.ts';
import { createAppDeps } from '../../src/app-deps.ts';
import { apiModules } from '../../src/api-modules.ts';
import type { WebSocketExpress } from 'websocket-express';
import { createV2Server } from '../../src/server.ts';

function mergeOverrides(): typeof webApiDocOverrides {
  const merged = { ...webApiResponseDocOverrides } as typeof webApiDocOverrides;
  for (const [key, value] of Object.entries(webApiDocOverrides)) merged[key] = { ...merged[key], ...value };
  return merged;
}

describe('OpenAPI documentation', () => {
  it('derives mounted paths, input constraints, and authorization from registered handlers', () => {
    const app = express();
    const routes = createHttpRouteInventory(app);
    const router = express.Router();
    router.post('/:id', route({ params: z.object({ id: z.string().uuid() }), query: z.object({ dry: z.coerce.boolean().optional() }), body: z.object({ count: z.number().int().min(1) }) }, async (_input, _request, response) => { response.end(); }));
    app.use('/api/things', router);
    const document = createOpenApiDocument(routes);
    const operation = (document.paths as Record<string, Record<string, Record<string, unknown>>>)['/api/things/{id}']?.post;
    expect(operation?.security).toEqual([{ accountBearer: [] }]);
    expect(operation?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'id', in: 'path', required: true, schema: expect.objectContaining({ format: 'uuid' }) }),
      expect.objectContaining({ name: 'dry', in: 'query', required: false }),
    ]));
    expect(operation?.requestBody).toMatchObject({ content: { 'application/json': { schema: { properties: { count: { minimum: 1 } } } } } });
  });

  it('tracks added, removed, and changed routes and their request and response contracts', () => {
    const oldApp = express();
    const oldRoutes = createHttpRouteInventory(oldApp);
    oldApp.get('/api/legacy', (_request, response) => { response.end(); });
    oldApp.get('/api/widgets/:id', (_request, response) => { response.end(); });
    oldApp.post('/api/widgets', route({ body: z.object({ title: z.string().min(1) }) },
      async (_input, _request, response) => { response.end(); }));
    const oldDocument = createOpenApiDocument(oldRoutes, {
      'GET /api/widgets/:id': { responseType: 'text/plain', responseDescription: 'Plain widget label.' },
      'POST /api/widgets': { responseStatus: 201, responseSchema: z.object({ title: z.string().max(20) }) },
    });

    const newApp = express();
    const newRoutes = createHttpRouteInventory(newApp);
    newApp.patch('/api/widgets/:id', route({ params: z.object({ id: z.string().uuid() }), body: z.object({ title: z.string().min(4) }) },
      async (_input, _request, response) => { response.end(); }));
    newApp.post('/api/widgets', route({ auth: false, body: z.object({ title: z.string().min(4), priority: z.number().int() }) },
      async (_input, _request, response) => { response.end(); }));
    newApp.delete('/api/widgets/:id', (_request, response) => { response.status(204).end(); });
    const newDocument = createOpenApiDocument(newRoutes, {
      'PATCH /api/widgets/:id': { responseSchema: z.object({ id: z.string().uuid(), title: z.string() }) },
      'POST /api/widgets': { responseStatus: 202, responseSchema: z.object({ title: z.string().max(80), accepted: z.boolean() }) },
      'DELETE /api/widgets/:id': { responseStatus: 204 },
    });

    const oldPaths = oldDocument.paths as Record<string, Record<string, Record<string, unknown>>>;
    const newPaths = newDocument.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(oldPaths).toHaveProperty('/api/legacy');
    expect(newPaths).not.toHaveProperty('/api/legacy');
    expect(oldPaths['/api/widgets/{id}']).toHaveProperty('get');
    expect(newPaths['/api/widgets/{id}']).not.toHaveProperty('get');
    expect(newPaths['/api/widgets/{id}']).toHaveProperty('patch');
    expect(newPaths['/api/widgets/{id}']).toHaveProperty('delete');
    expect((oldPaths['/api/widgets/{id}']?.get?.responses as Record<string, { content: object }>)['200']?.content).toHaveProperty('text/plain');
    expect((newPaths['/api/widgets/{id}']?.patch?.responses as Record<string, { content: object }>)['200']?.content).toHaveProperty('application/json');
    expect((oldPaths['/api/widgets']?.post?.requestBody as { content: Record<string, { schema: { properties: { title: { minLength: number } } } }> }).content['application/json']?.schema.properties.title.minLength).toBe(1);
    expect((newPaths['/api/widgets']?.post?.requestBody as { content: Record<string, { schema: { properties: { title: { minLength: number } } } }> }).content['application/json']?.schema.properties.title.minLength).toBe(4);
    expect((newPaths['/api/widgets']?.post?.requestBody as { content: Record<string, { schema: { required: string[] } }> }).content['application/json']?.schema.required).toContain('priority');
    expect(newPaths['/api/widgets']?.post?.security).toEqual([]);
    expect(oldPaths['/api/widgets']?.post?.security).toEqual([{ accountBearer: [] }]);
    expect(oldPaths['/api/widgets']?.post?.responses).toHaveProperty('201');
    expect(oldPaths['/api/widgets']?.post?.responses).toMatchObject({ '201': { content: { 'application/json': { schema: { properties: { title: { maxLength: 20 } } } } } } });
    expect(newPaths['/api/widgets']?.post?.responses).toMatchObject({ '202': { content: { 'application/json': { schema: { properties: { title: { maxLength: 80 }, accepted: { type: 'boolean' } } } } } } });
    expect(newPaths['/api/widgets/{id}']?.delete?.responses).toHaveProperty('204');
  });

  it('serves the spec and Swagger UI assets locally without persisting credentials', async () => {
    const app = express();
    const routes = createHttpRouteInventory(app);
    app.get('/health', (_request, response) => { response.json({ ok: true }); });
    mountApiDocs(app, routes, webApiDocOverrides);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const [spec, docs, script, blocked] = await Promise.all([
        fetch(`${base}/openapi.json`), fetch(`${base}/docs`),
        fetch(`${base}/docs/assets/swagger-ui-bundle.js`), fetch(`${base}/docs/assets/../server.ts`),
      ]);
      expect(spec.status).toBe(200);
      expect((await spec.json()).paths).toHaveProperty('/health');
      const html = await docs.text();
      expect(html).toContain("persistAuthorization:false");
      expect(html).toContain("validatorUrl:null");
      expect(html).toContain('/docs/assets/swagger-ui-bundle.js');
      expect(html).not.toMatch(/https?:\/\//);
      expect(docs.headers.get('content-security-policy')).toContain("connect-src 'self'");
      expect(script.status).toBe(200);
      expect(script.headers.get('content-type')).toContain('javascript');
      expect(blocked.status).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('classifies public, account, device, and streaming operations accurately', () => {
    const app = express();
    const routes = createHttpRouteInventory(app);
    app.get('/api/invitations/:token', (_request, response) => { response.end(); });
    app.get('/v2/firmware/:board/:file', (_request, response) => { response.end(); });
    app.post('/api/chat', (_request, response) => { response.end(); });
    app.get('/api/events', (_request, response) => { response.end(); });
    app.post('/api/speech', (_request, response) => { response.end(); });
    app.get('/v2/cardputer', (_request, response) => { response.end(); });
    const paths = createOpenApiDocument(routes, webApiDocOverrides).paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths['/api/invitations/{token}']?.get?.security).toEqual([]);
    expect(paths['/v2/firmware/{board}/{file}']?.get?.security).toEqual([{ deviceBearer: [] }]);
    expect((paths['/api/chat']?.post?.responses as Record<string, { content: object }>)['200']?.content).toHaveProperty('text/event-stream');
    expect((paths['/api/events']?.get?.responses as Record<string, { content: object }>)['200']?.content).toHaveProperty('text/event-stream');
    expect((paths['/api/speech']?.post?.responses as Record<string, { content: object }>)['200']?.content).toHaveProperty('audio/mpeg');
    expect(paths).not.toHaveProperty('/v2/cardputer');
  });

  it('publishes every registered HTTP API route with real request and success contracts', async () => {
    vi.stubEnv('BOB_SYSTEM_TEST', '1');
    vi.stubEnv('BOB_V2_HOST', '127.0.0.1');
    vi.stubEnv('BOB_PRODUCTION', undefined);
    vi.stubEnv('BOB_DATABASE_URL', 'postgresql://bob_server@127.0.0.1:1/bob_no_shared_db');
    // Include optional mounted Google routes in the completeness inventory.
    // Synthetic settings construct adapters but never contact the provider.
    vi.stubEnv('BOB_GOOGLE_BRIDGE_URL', 'https://bridge.example.test/connect');
    vi.stubEnv('BOB_GOOGLE_BRIDGE_SECRET', 'synthetic_api_docs_secret_not_for_runtime_123');
    vi.stubEnv('BOB_GOOGLE_CLIENT_ID', 'test.apps.googleusercontent.com');
    vi.stubEnv('BOB_GOOGLE_CALLBACK_URLS', 'https://app.example.test/google/callback');
    const deps = createAppDeps();
    deps.getDb = async () => { throw new Error('API documentation must not read the database'); };
    const created = await createV2Server(deps);
    await new Promise<void>((resolve) => created.server.listen(0, '127.0.0.1', resolve));
    try {
      const overrides = mergeOverrides();
      const document = createOpenApiDocument(created.httpRoutes, overrides);
      const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
      expect(created.httpRoutes.documentedRoutes().find(({ method, path }) => method === 'POST' && path === '/api/spaces/:spaceId/tasks')?.schemas?.body).toBeDefined();
      const docsRoutes = new Set(['/openapi.json', '/openapi-edge.json', '/docs', '/docs/edge', '/docs/assets/:name']);
      const supportedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
      const expectedOperations = created.httpRoutes.routes()
        .filter(({ method, path }) => supportedMethods.has(method) && path !== '/v2/cardputer' && !docsRoutes.has(path))
        .map(({ method, path }) => `${method} ${path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}')}`)
        .sort();
      const actualOperations = Object.entries(paths)
        .flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`))
        .sort();
      expect(actualOperations).toEqual(expectedOperations);
      const operationsWithoutUsefulDescriptions = Object.entries(paths).flatMap(([path, methods]) =>
        Object.entries(methods)
          .filter(([, operation]) => {
            const description = typeof operation.description === 'string' ? operation.description.trim() : '';
            return description.length < 24 || description === operation.summary;
          })
          .map(([method]) => `${method.toUpperCase()} ${path}`));
      expect(operationsWithoutUsefulDescriptions).toEqual([]);
      const genericAuthorizationDescriptions = Object.entries(paths).flatMap(([path, methods]) =>
        Object.entries(methods)
          .filter(([, operation]) => typeof operation.description === 'string'
            && /^Requires (?:operator|accounts\.admin) scope and an active account session\.$/i.test(operation.description))
          .map(([method]) => `${method.toUpperCase()} ${path}`));
      expect(genericAuthorizationDescriptions).toEqual([]);
      const registeredKeys = new Set(created.httpRoutes.routes()
        .filter(({ method, path }) => supportedMethods.has(method) && path !== '/v2/cardputer' && !docsRoutes.has(path))
        .map(({ method, path }) => `${method} ${path}`));
      expect(created.httpRoutes.routes().filter(({ method, path }) => path.startsWith('/api/') && !overrides[`${method} ${path}`])).toEqual([]);
      expect(Object.keys(overrides).filter((key) => !registeredKeys.has(key))).toEqual([]);
      expect(Object.entries(paths).flatMap(([path, methods]) => Object.entries(methods)
        .filter(([, operation]) => operation['x-bob-response-schema'])
        .map(([method]) => `${method.toUpperCase()} ${path}`))).toEqual([]);
      const undocumentedBodies = Object.entries(paths).flatMap(([path, methods]) => Object.entries(methods)
        .filter(([method, operation]) => ['post', 'put', 'patch'].includes(method) && operation['x-bob-request-schema'])
        .map(([method]) => `${method.toUpperCase()} ${path}`));
      expect(undocumentedBodies).toEqual([]);
      expect(paths['/api/conversations']?.get?.security).toEqual([{ accountBearer: [] }]);
      expect(paths['/api/public-config']?.get?.security).toEqual([]);
      expect(paths['/api/google-accounts/callback']?.post).toMatchObject({
        security: [{ accountBearer: [] }],
        requestBody: { content: { 'application/json': { schema: { required: ['state'], additionalProperties: false } } } },
        responses: { '201': { content: { 'application/json': { schema: { required: ['account'] } } } }, '403': expect.any(Object), '503': expect.any(Object) },
      });
      expect(paths['/api/google-accounts/authorize']?.post?.requestBody).toMatchObject({
        content: { 'application/json': { schema: { required: ['capabilities'], properties: { capabilities: { minItems: 1, maxItems: 6 } } } } },
      });
      expect(paths['/api/google-accounts/authorize']?.post?.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Origin', in: 'header', required: true }),
      ]));
      expect(paths['/api/google-accounts/{accountId}/calendars']?.get).toMatchObject({
        security: [{ accountBearer: [] }], parameters: expect.arrayContaining([
          expect.objectContaining({ name: 'accountId', in: 'path', required: true, schema: expect.objectContaining({ format: 'uuid' }) }),
          expect.objectContaining({ name: 'pageToken', in: 'query', required: false }),
        ]), responses: { '200': { content: { 'application/json': { schema: { required: expect.arrayContaining(['calendars', 'selected_calendar_ids']) } } } } },
      });
      expect(paths['/api/google-accounts/{accountId}/calendars/selection']?.put?.requestBody).toMatchObject({
        content: { 'application/json': { schema: { required: ['calendarIds'], properties: { calendarIds: { maxItems: 5 } } } } },
      });
      expect(paths['/api/agenda']?.get?.responses).toMatchObject({ '200': { content: { 'application/json': { schema: {
        required: ['items'], properties: { remote_items: { type: 'array' }, sources: { type: 'array' }, remote_unavailable: { const: true } },
      } } } } });
      expect(paths['/health']?.get?.responses).toMatchObject({ '200': { content: { 'application/json': { schema: {
        required: expect.arrayContaining(['ok', 'protocol', 'path', 'schema_version', 'schema_expected', 'schema_status']),
        additionalProperties: false,
      } } } }, '503': { description: expect.any(String) } });
      const read = paths['/api/threads/{id}/read']?.put?.requestBody as { required: boolean };
      expect(read.required).toBe(false);
      const task = paths['/api/spaces/{spaceId}/tasks']?.post;
      expect(task?.requestBody).toBeDefined();
      expect(task?.responses).toHaveProperty('201');
      expect(paths['/api/events/{id}/attendees']?.delete?.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'user_id', in: 'query', required: true, schema: expect.objectContaining({ format: 'uuid' }) }),
      ]));
      const edge = JSON.parse((await import('node:fs')).readFileSync(new URL('../../src/web-edge-api-docs.json', import.meta.url), 'utf8')) as { paths: object };
      const functionsDir = new URL('../../../../supabase/functions/', import.meta.url);
      const edgePaths = readdirSync(functionsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/index.ts`, functionsDir)))
        .map((entry) => `/${entry.name}`).sort();
      expect(Object.keys(edge.paths).sort()).toEqual(edgePaths);
      const base = `http://127.0.0.1:${(created.server.address() as AddressInfo).port}`;
      expect((await fetch(`${base}/openapi-edge.json`)).status).toBe(200);
      expect((await fetch(`${base}/api/conversations`)).status).toBe(401);
      const nativeReturn = await fetch(`${base}/api/google-accounts/native/return?state=${'a'.repeat(43)}`, { redirect: 'manual' });
      expect(nativeReturn.status).toBe(303);
      expect(nativeReturn.headers.get('location')).toBe(`xyz.heybob.oauth://google/callback?state=${'a'.repeat(43)}&outcome=returned`);
      expect(nativeReturn.headers.get('cache-control')).toBe('no-store');
      for (const action of ['authorize', 'complete', 'cancel']) {
        expect((await fetch(`${base}/api/google-accounts/native/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
      }
      expect(paths['/api/google-accounts/native/return']?.get?.security).toEqual([]);
      expect(paths['/api/google-accounts/native/return']?.get?.responses).toMatchObject({ '303': { headers: { Location: expect.any(Object) } } });
      expect((paths['/api/google-accounts/native/return']?.get?.responses as Record<string, object>)['303']).not.toHaveProperty('content');
      expect(paths['/api/google-accounts/native/complete']?.post?.security).toEqual([{ accountBearer: [] }]);
      const edgePage = await (await fetch(`${base}/docs/edge`)).text();
      expect(edgePage).toContain('supportedSubmitMethods:[]');
    } finally {
      created.server.closeAllConnections();
      await new Promise<void>((resolve) => created.server.close(() => resolve()));
      vi.unstubAllEnvs();
    }
  });

  it('documents only mounted Google routes when the runtime is dormant', () => {
    for (const key of ['BRIDGE_URL', 'BRIDGE_SECRET', 'CLIENT_ID', 'CALLBACK_URLS']) vi.stubEnv(`BOB_GOOGLE_${key}`, undefined);
    try {
      const deps = createAppDeps();
      deps.getDb = async () => { throw new Error('API documentation must not read the database'); };
      const app = express();
      const inventory = createHttpRouteInventory(app);
      const google = apiModules.find(module => module.name === 'google-accounts');
      if (!google?.mount) throw new Error('Google module missing');
      google.mount(app as unknown as WebSocketExpress, deps);
      const document = createOpenApiDocument(inventory, mergeOverrides());
      expect(document.paths).toHaveProperty('/api/google-accounts/callback');
      expect(document.paths).not.toHaveProperty('/api/google-accounts/{accountId}/calendars');
      expect(document.paths).not.toHaveProperty('/api/google-accounts/{accountId}/calendars/selection');
    } finally { vi.unstubAllEnvs(); }
  });
});
