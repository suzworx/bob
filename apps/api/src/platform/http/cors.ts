/**
 * CORS middleware for cross-origin requests.
 *
 * Default (no BOB_CORS_ORIGINS set): pass-through, no headers — ui-v2 is
 * same-origin, Vite dev proxies /api, and Capacitor loads from app.heybob.xyz.
 * Explicitly configured: exact-match allow-list, echo origin + Vary header.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Request headers a cross-origin client (the Capacitor app) may send: auth, body type, and the web app's X-Bob-* headers. */
const ALLOWED_REQUEST_HEADERS = [
  'authorization', 'content-type', 'x-bob-client-session', 'x-bob-conversation',
  'x-bob-ui-action-id', 'x-bob-ui-request-id', 'x-bob-expected-updated-at', 'traceparent',
].join(', ');

/** Parse comma-separated, trimmed origins from env; empty/unset gives []. */
export function parseAllowedOrigins(value = process.env.BOB_CORS_ORIGINS): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** Creates a CORS middleware. Empty origins list: pass-through (no headers). */
export function createCorsMiddleware(origins: string[]): RequestHandler {
  if (origins.length === 0) {
    // Default: no cross-origin access. Return a pass-through middleware.
    return (_request: Request, _response: Response, next: NextFunction): void => {
      next();
    };
  }

  // Origins configured: check exact match and echo allowed origins back.
  const originSet = new Set(origins);
  return (request: Request, response: Response, next: NextFunction): void => {
    const requestOrigin = request.get('origin');

    // Handle preflight OPTIONS requests.
    if (request.method === 'OPTIONS') {
      if (requestOrigin && originSet.has(requestOrigin)) {
        response.header('Access-Control-Allow-Origin', requestOrigin);
        response.header('Vary', 'Origin');
        response.header('Access-Control-Allow-Headers', ALLOWED_REQUEST_HEADERS);
        response.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
        response.header('Access-Control-Allow-Credentials', 'true');
        response.status(204).end();
        return;
      }
      // Foreign origin: no CORS header, browser will block.
      next();
      return;
    }

    // Regular request: echo origin if allowed.
    if (requestOrigin && originSet.has(requestOrigin)) {
      response.header('Access-Control-Allow-Origin', requestOrigin);
      response.header('Vary', 'Origin');
      response.header('Access-Control-Allow-Headers', ALLOWED_REQUEST_HEADERS);
      response.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      response.header('Access-Control-Allow-Credentials', 'true');
      response.header('Access-Control-Expose-Headers', 'X-Bob-Trace-Id, X-Bob-Speech-Truncated');
    }
    // Foreign origin or no origin header: no CORS header.
    next();
  };
}
