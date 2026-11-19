import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { HttpRouteInventory } from '../observability/http-route-inventory.ts';
import type { RouteSchemas } from './route.ts';

type Json = Record<string, unknown>;
interface ApiOperationOverride extends RouteSchemas {
  description?: string;
  responseType?: string;
  responseSchema?: z.ZodType;
  responseStatus?: number;
  responseBody?: false;
  responseDescription?: string;
  security?: 'public' | 'account' | 'device';
  hidden?: boolean;
  noBody?: boolean;
  additionalResponses?: Record<string, Json>;
  additionalResponseTypes?: string[];
  parameters?: Json[];
}
export type ApiOverrides = Record<string, ApiOperationOverride>;

const httpMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const assetNames = new Set(['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js', 'favicon-32x32.png', 'favicon-16x16.png']);
const require = createRequire(import.meta.url);
const assetRoot = dirname(require.resolve('swagger-ui-dist/swagger-ui-bundle.js'));

function schema(value: z.ZodType, io: 'input' | 'output' = 'input'): Json {
  return z.toJSONSchema(value, { target: 'draft-2020-12', io, reused: 'inline', unrepresentable: 'any' }) as Json;
}

function fields(value: z.ZodType | undefined, location: 'path' | 'query'): Json[] {
  if (!value) return [];
  const converted = schema(value);
  const properties = converted.properties as Record<string, Json> | undefined;
  if (!properties) return [];
  const required = new Set(Array.isArray(converted.required) ? converted.required as string[] : []);
  return Object.entries(properties).map(([name, property]) => ({
    name, in: location, required: location === 'path' || required.has(name), schema: property,
  }));
}

function pathFields(path: string, specified: z.ZodType | undefined): Json[] {
  const existing = fields(specified, 'path');
  const names = [...path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]);
  return names.map((name) => existing.find((entry) => entry.name === name) ?? {
    name, in: 'path', required: true, schema: { type: 'string' },
  });
}

function responseSchema(type: string, override: ApiOperationOverride, primary: string): Json {
  if (override.responseSchema && type === primary) return schema(override.responseSchema, 'output');
  if (type === 'application/octet-stream' || type === 'audio/mpeg') return { type: 'string', format: 'binary' };
  return {};
}

function responses(path: string, security: string, override: ApiOperationOverride, validates: boolean): Json {
  const status = String(override.responseStatus ?? 200);
  const primary = override.responseType ?? 'application/json';
  const content = Object.fromEntries([primary, ...(override.additionalResponseTypes ?? [])]
    .map((type) => [type, { schema: responseSchema(type, override, primary) }]));
  const success = { description: override.responseDescription ?? 'Successful response; response schema is maintained by the handler.',
    ...(status === '204' || override.responseBody === false ? {} : { content }) };
  const error = (description: string): Json => ({ description, content: { 'application/json': { schema: {
    type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code'] } }, required: ['error'],
  } } } });
  return {
    [status]: success,
    ...(validates ? { '400': error('Invalid request parameters or body.') } : {}),
    ...(security === 'public' ? {} : { '401': error('Missing or invalid bearer token.') }),
    ...(path.startsWith('/api/admin/') || path.startsWith('/api/operator/') ? { '403': error('Insufficient account scope.') } : {}),
    ...(path.startsWith('/api/') ? { '429': error('API rate limit exceeded.') } : {}),
    ...(override.additionalResponses ?? {}),
  };
}

function securityFor(path: string, input: RouteSchemas, override: ApiOperationOverride): 'public' | 'account' | 'device' {
  if (override.security) return override.security;
  if (input.auth === false || path === '/health') return 'public';
  return 'account';
}

function operation(method: string, path: string, schemas: RouteSchemas | undefined, override: ApiOperationOverride): Json {
  const input = { ...schemas, ...override };
  const security = securityFor(path, input, override);
  const parameters = [...pathFields(path, input.params), ...fields(input.query, 'query'), ...(override.parameters ?? [])];
  const responseType = override.responseType ?? 'application/json';
  const result: Json = {
    tags: [path.startsWith('/api/') ? path.split('/')[2] : path.split('/')[1]],
    summary: `${method} ${path}`,
    ...(override.description ? { description: override.description } : {}),
    operationId: `${method.toLowerCase()}_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
    ...(security === 'public' ? { security: [] } : { security: [{ [security === 'device' ? 'deviceBearer' : 'accountBearer']: [] }] }),
    ...(parameters.length ? { parameters } : {}),
    responses: responses(path, security, override, Boolean(input.params || input.query || input.body)),
  };
  if (input.body) result.requestBody = { required: !input.body.safeParse(undefined).success, content: { 'application/json': { schema: schema(input.body) } } };
  if (!override.responseSchema && responseType === 'application/json' && override.responseStatus !== 204 && override.responseBody !== false) result['x-bob-response-schema'] = 'Response schema is not available from the registered handler.';
  if (['POST', 'PUT', 'PATCH'].includes(method) && !input.body && !override.noBody) result['x-bob-request-schema'] = 'Handler does not expose a reusable request schema.';
  return result;
}

/** Generated from the live Express registration graph at startup. WebSocket upgrades are documented separately. */
export function createOpenApiDocument(inventory: HttpRouteInventory, overrides: ApiOverrides = {}): Json {
  const paths: Record<string, Json> = {};
  for (const route of inventory.documentedRoutes()) {
    if (!httpMethods.has(route.method) || route.path === '/v2/cardputer' || route.path.startsWith('/docs') || route.path.startsWith('/openapi')) continue;
    const key = `${route.method} ${route.path}`;
    const override = overrides[key] ?? {};
    if (override.hidden) continue;
    const path = route.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}');
    const methods = paths[path] ?? {};
    paths[path] = methods;
    methods[route.method.toLowerCase()] = operation(route.method, route.path, route.schemas, override);
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Bob HTTP API', version: '1.0.0', description: 'Live HTTP routes. Authenticate browser APIs with a Supabase access token. Device firmware uses a paired device token. The Cardputer WebSocket and OLX2 binary frames are documented in the repository device protocol, not as HTTP operations.' },
    servers: [{ url: '/' }],
    paths,
    components: { securitySchemes: {
      accountBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Supabase account access token.' },
      deviceBearer: { type: 'http', scheme: 'bearer', description: 'Paired olxd_ device token.' },
    } },
  };
}

function html(spec: string, readOnly: boolean): string {
  const heading = readOnly ? '<p>Supabase Edge Functions run on a separate host. This reference is read only.</p><p><a href="/docs">HTTP API docs</a></p>' : '<p><a href="/docs/edge">Supabase Edge Functions (read only)</a></p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bob API docs</title><link rel="stylesheet" href="/docs/assets/swagger-ui.css"></head><body>${heading}<div id="swagger-ui"></div><script src="/docs/assets/swagger-ui-bundle.js"></script><script src="/docs/assets/swagger-ui-standalone-preset.js"></script><script>window.onload=function(){SwaggerUIBundle({url:'${spec}',dom_id:'#swagger-ui',deepLinking:true,presets:[SwaggerUIBundle.presets.apis,SwaggerUIStandalonePreset],layout:'StandaloneLayout',persistAuthorization:false,validatorUrl:null${readOnly ? ',supportedSubmitMethods:[]' : ''}})}</script></body></html>`;
}

function serveHtml(response: Response, spec: string, readOnly: boolean): void {
  response.set({ 'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'", 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }).type('html').send(html(spec, readOnly));
}

export function mountApiDocs(app: Express, inventory: HttpRouteInventory, overrides: ApiOverrides = {}, edgeDocument?: Json): void {
  app.get('/openapi.json', (_request: Request, response: Response) => {
    response.set('Cache-Control', 'no-store').json(createOpenApiDocument(inventory, overrides));
  });
  app.get('/openapi-edge.json', (_request: Request, response: Response) => {
    if (!edgeDocument) { response.status(404).end(); return; }
    response.set('Cache-Control', 'no-store').json(edgeDocument);
  });
  app.get('/docs', (_request: Request, response: Response) => {
    serveHtml(response, '/openapi.json', false);
  });
  app.get('/docs/edge', (_request: Request, response: Response) => serveHtml(response, '/openapi-edge.json', true));
  app.get('/docs/assets/:name', (request: Request, response: Response) => {
    const name = request.params.name;
    if (typeof name !== 'string' || !assetNames.has(name)) { response.status(404).end(); return; }
    response.set({ 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' }).type(name).send(readFileSync(join(assetRoot, name)));
  });
}
