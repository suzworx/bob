/**
 * 014 (issue #152): the net error handler under /api. A route that escapes its
 * own mapping lands here and becomes a generic 500 -- no driver text, no SQL,
 * no table or constraint names, no stack. The per-router mapping of store
 * errors is preserved (this middleware runs only after a route already decided
 * not to respond). All three tests build a bare express app with the handler
 * mounted at /api, mirroring how server.ts wires it.
 */
import express, { type ErrorRequestHandler, type Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { webErrorHandler } from '../../src/platform/http/errors.ts';
import { StoreNotFoundError } from '../../src/platform/db/db.ts';

let server: Server | null = null;

async function bootApp(app: Express): Promise<string> {
  const created = server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => created.once('listening', resolve));
  const address = created.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe('webErrorHandler (issue #152)', () => {
  it('maps an unmapped error to a generic 500 with no leaked details', async () => {
    const app = express();
    app.get('/api/boom', () => {
      throw new Error(
        'insert or update on table "spaces" violates foreign key constraint "spaces_owner_id_fkey"',
      );
    });
    app.use('/api', webErrorHandler);
    const baseUrl = await bootApp(app);

    const response = await fetch(`${baseUrl}/api/boom`);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal');
    expect(body.error.message).toBe('Internal server error');

    const text = JSON.stringify(body);
    expect(text).not.toContain('spaces');
    expect(text).not.toContain('spaces_owner_id_fkey');
    expect(text).not.toContain('PostgresError');
    expect(text).not.toContain('Error');
    expect(text).not.toContain('Stack');
    expect(text).not.toContain('at ');
  });

  it('delegates to next when the response already started, without double-sending', async () => {
    const app = express();
    let delegated = false;
    app.get('/api/partial', (_request, response) => {
      response.write('partial');
      throw new Error('after the response started');
    });
    app.use('/api', webErrorHandler);
    // A terminal handler in place of Express's default: record that the error
    // was handed off rather than re-sending a status on an open response.
    const terminalHandler: ErrorRequestHandler = (error, _request, response, next) => {
      if (!(error instanceof Error)) {
        next(error);
        return;
      }
      delegated = true;
      response.end();
    };
    app.use('/api', terminalHandler);
    const baseUrl = await bootApp(app);

    const response = await fetch(`${baseUrl}/api/partial`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('partial');
    expect(delegated).toBe(true);
  });

  it('preserves the per-router mapping: a handled StoreNotFoundError still 404s', async () => {
    const app = express();
    app.get('/api/spaces/:id', (_request, response) => {
      try {
        throw new StoreNotFoundError('space not found');
      } catch (error) {
        if (error instanceof StoreNotFoundError) {
          response.status(404).json({ error: { code: 'not_found' } });
          return;
        }
        throw error;
      }
    });
    app.use('/api', webErrorHandler);
    const baseUrl = await bootApp(app);

    const response = await fetch(`${baseUrl}/api/spaces/anything`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});