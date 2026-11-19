import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { route, sendError, type ErrorMapper } from '../../src/platform/http/route.ts';
import { StoreNotFoundError } from '../../src/platform/db/db.ts';

async function post(
  userId: string | null,
  handler: express.RequestHandler,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.account = { userId } as typeof req.account;
    next();
  });
  app.post('/items/:id', handler);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      method: 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  } finally {
    server.close();
  }
}

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({ title: z.string().min(1) }).strict();
const ID = '7f1b8c2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b';

const mapError: ErrorMapper = (response, error) => {
  if (error instanceof StoreNotFoundError) {
    sendError(response, 404, 'not_found', error.message);
    return;
  }
  throw error;
};

describe('route()', () => {
  it('passes parsed params, body and the account to the handler', async () => {
    const handler = route({ params: Params, body: Body }, async ({ params, body, userId }, _req, res) => {
      res.status(200).json({ id: params.id, title: body.title, userId });
    });
    const res = await post('user-1', handler, `/items/${ID}`, { title: 'x' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: ID, title: 'x', userId: 'user-1' });
  });

  it('answers 400 for a bad body before checking the account', async () => {
    const handler = route({ params: Params, body: Body }, async () => {});
    const res = await post(null, handler, `/items/${ID}`, { nope: 1 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'invalid_request' } });
  });

  it('answers 401 without an account, before checking params', async () => {
    const handler = route({ params: Params, body: Body }, async () => {});
    const res = await post(null, handler, '/items/not-a-uuid', { title: 'x' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: 'invalid_token' } });
  });

  it('answers 400 for bad params', async () => {
    const handler = route({ params: Params }, async () => {});
    const res = await post('user-1', handler, '/items/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('skips the account check when auth is false', async () => {
    const handler = route({ auth: false }, async (_input, _req, res) => {
      res.status(204).end();
    });
    const res = await post(null, handler, `/items/${ID}`);
    expect(res.status).toBe(204);
  });

  it('hands store errors to the mapper', async () => {
    const handler = route({ mapError }, async () => {
      throw new StoreNotFoundError('gone');
    });
    const res = await post('user-1', handler, `/items/${ID}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'gone' } });
  });

  it('lets unknown errors reach Express as a 500', async () => {
    const handler = route({ mapError }, async () => {
      throw new Error('boom');
    });
    const res = await post('user-1', handler, `/items/${ID}`);
    expect(res.status).toBe(500);
  });
});
