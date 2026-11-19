import type { Request, Response } from 'express';
import type { z } from 'zod';

export function sendError(response: Response, status: number, code: string, message?: string): void {
  response.status(status).json({ error: { code, ...(message ? { message } : {}) } });
}

/** Sends the contract error for a known store error, or throws so Express answers 500. */
export type ErrorMapper = (response: Response, error: unknown) => void;

type Schema = z.ZodType | undefined;
export interface RouteSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  auth?: boolean;
}
const routeSchemasKey = Symbol.for('bob.http.route.schemas');

/** Documentation reads the exact validation schemas used by the handler. */
export function getRouteSchemas(handler: object): RouteSchemas | undefined {
  return (handler as Record<symbol, RouteSchemas | undefined>)[routeSchemasKey];
}
type Out<S extends Schema> = S extends z.ZodType ? z.output<S> : undefined;

export interface RouteSpec<P extends Schema, Q extends Schema, B extends Schema> {
  params?: P;
  query?: Q;
  body?: B;
  /** Default true: answer 401 `invalid_token` when there is no signed-in account. */
  auth?: boolean;
  mapError?: ErrorMapper;
}

export interface RouteInput<P extends Schema, Q extends Schema, B extends Schema> {
  params: Out<P>;
  query: Out<Q>;
  body: Out<B>;
  userId: string;
}

function parse(schema: Schema, value: unknown): { ok: true; data: unknown } | { ok: false } {
  if (!schema) return { ok: true, data: undefined };
  const result = schema.safeParse(value);
  return result.success ? { ok: true, data: result.data } : { ok: false };
}

/**
 * Wraps an Express handler. Validation order matches the routers it replaced:
 * query and body (400), then the account (401), then path params (400).
 */
export function route<P extends Schema = undefined, Q extends Schema = undefined, B extends Schema = undefined>(
  spec: RouteSpec<P, Q, B>,
  handler: (input: RouteInput<P, Q, B>, request: Request, response: Response) => Promise<void>,
): (request: Request, response: Response) => Promise<void> {
  const wrapped = async (request: Request, response: Response): Promise<void> => {
    const query = parse(spec.query, request.query);
    const body = parse(spec.body, request.body);
    if (!query.ok || !body.ok) {
      sendError(response, 400, 'invalid_request');
      return;
    }
    const userId = request.account?.userId ?? '';
    if (spec.auth !== false && !userId) {
      sendError(response, 401, 'invalid_token');
      return;
    }
    const params = parse(spec.params, request.params);
    if (!params.ok) {
      sendError(response, 400, 'invalid_request');
      return;
    }
    const input = { params: params.data, query: query.data, body: body.data, userId } as RouteInput<P, Q, B>;
    try {
      await handler(input, request, response);
    } catch (error) {
      if (!spec.mapError) throw error;
      spec.mapError(response, error);
    }
  };
  Object.defineProperty(wrapped, routeSchemasKey, { value: { params: spec.params, query: spec.query, body: spec.body, auth: spec.auth } });
  return wrapped;
}
