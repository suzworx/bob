import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createGoogleCalendarRouter } from '../../src/integrations/google-calendar-http.ts';
import { createGoogleAgendaService } from '../../src/integrations/google-agenda-service.ts';
import { addGoogleAccount } from '../../src/integrations/google-store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let server: Server;
let base: string;
const calendar = { listCalendars: vi.fn().mockResolvedValue({ items: [{ id: 'calendar', summary: 'Personal', accessRole: 'reader' }] }), listEvents: vi.fn() };
beforeAll(async () => {
  pg = await createTestDb();
  const app = express();
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use('/api/google-accounts', createGoogleCalendarRouter({ service: createGoogleAgendaService({ db: asDb(pg), calendar }) }));
  server = await new Promise<Server>((resolve) => { const handle = app.listen(0, () => resolve(handle)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/google-accounts`;
});
afterAll(async () => { server.close(); await closeTestDb(pg); });

it('validates authenticated owner and strict selection input at the HTTP boundary', async () => {
  const owner = await addAccount(pg);
  const other = await addAccount(pg);
  const account = await addGoogleAccount(asDb(pg), owner.userId, { installationId: randomUUID(), accountId: 'provider', email: 'test@example.test' });
  const token = await signToken({ userId: owner.userId, sessionId: owner.sessionId });
  const foreign = await signToken({ userId: other.userId, sessionId: other.sessionId });
  const url = `${base}/${account.id}/calendars`;
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { authorization: `Bearer ${foreign}` } })).status).toBe(404);
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ calendars: [{ id: 'calendar', selected: false, read_only: true }] });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  expect((await fetch(`${url}/selection`, { method: 'PUT', headers, body: JSON.stringify({ calendarIds: ['calendar'], accountId: other.userId }) })).status).toBe(400);
  const selected = await fetch(`${url}/selection`, { method: 'PUT', headers, body: JSON.stringify({ calendarIds: ['calendar'] }) });
  expect(selected.status).toBe(200);
  expect(await selected.json()).toMatchObject({ selections: [{ calendar_id: 'calendar', account_id: account.id }] });
});

it('never returns raw credential or provider exception text', async () => {
  const owner = await addAccount(pg);
  const account = await addGoogleAccount(asDb(pg), owner.userId, { installationId: randomUUID(), accountId: 'provider', email: 'test@example.test' });
  const token = await signToken({ userId: owner.userId, sessionId: owner.sessionId });
  calendar.listCalendars.mockRejectedValueOnce(new Error('secret token provider message'));
  const response = await fetch(`${base}/${account.id}/calendars`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { code: 'google_calendar_unavailable' } });
});
