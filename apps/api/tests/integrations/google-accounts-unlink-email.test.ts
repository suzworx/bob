// DELETE /api/google-accounts/:id mails google-account-unlinked directly: the
// Google address is read before the row is deleted and sent to the owner's
// Bob address, best-effort (a failed send never changes the 204). Nothing is
// sent when the delete found nothing. Runs on createTestDb, which also covers
// addGoogleAccount inserting the explicit owner id rather than auth.uid().
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GmailClient } from '../../src/integrations/google-connect.ts';
import type { createGoogleConnectionService } from '../../src/integrations/google-connection-service.ts';
type GoogleConnectionService = ReturnType<typeof createGoogleConnectionService>;
import { setJournalSink } from '../../src/platform/logger.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { addGoogleAccount, listGoogleAccounts } from '../../src/integrations/google-store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard } from '../../src/platform/http/auth-guard.ts';
import { createGoogleAccountsRouter } from '../../src/integrations/google-http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const sendTemplateEmail = vi.fn(async (_input: { template: string; to: string; data: Record<string, unknown> }):
  Promise<void> => undefined);
vi.mock('../../src/notifications/email-client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/notifications/email-client.ts')>()),
  sendTemplateEmail: (input: { template: string; to: string; data: Record<string, unknown> }) =>
    sendTemplateEmail(input),
  recipientEmail: async (_db: Db, userId: string): Promise<string> => `${userId}@bob.example`,
}));

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;
const lines: string[] = [];

const connection = {
  revoke: vi.fn(async () => undefined),
} as unknown as GoogleConnectionService;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  const app = express();
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use('/api/google-accounts', createGoogleAccountsRouter({
    getDb: () => Promise.resolve(db), connection, gmail: {} as GmailClient,
  }));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setJournalSink((line) => lines.push(line));
});

afterAll(async () => {
  setJournalSink(null);
  server?.close();
  await closeTestDb(pg).catch(() => undefined);
});

beforeEach(() => {
  sendTemplateEmail.mockClear();
  lines.length = 0;
});

async function unlink(userId: string, sessionId: string, id: string): Promise<number> {
  const token = await signToken({ userId, sessionId });
  const response = await fetch(`${baseUrl}/api/google-accounts/${id}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${token}` },
  });
  return response.status;
}

describe('google account unlink email', () => {
  it('sends exactly one google-account-unlinked naming the Google address, to the owner', async () => {
    const owner = await addAccount(pg);
    const account = await addGoogleAccount(db, owner.userId,
      { installationId: 'inst-1', accountId: 'acct-1', email: 'maya.g@gmail.example' });
    expect(await unlink(owner.userId, owner.sessionId, account.id)).toBe(204);
    expect(sendTemplateEmail).toHaveBeenCalledTimes(1);
    expect(sendTemplateEmail).toHaveBeenCalledWith({ template: 'google-account-unlinked',
      to: `${owner.userId}@bob.example`, data: { googleEmail: 'maya.g@gmail.example' } });
    expect(await listGoogleAccounts(db, owner.userId)).toEqual([]);
    const all = lines.join('\n');
    expect(all).not.toContain('maya.g@gmail.example');
    expect(all).not.toContain('@bob.example');
  });

  it('a failing send still returns the normal 204', async () => {
    sendTemplateEmail.mockRejectedValueOnce(new Error('send_failed'));
    const owner = await addAccount(pg);
    const account = await addGoogleAccount(db, owner.userId,
      { installationId: 'inst-2', accountId: 'acct-2', email: 'arjun.g@gmail.example' });
    expect(await unlink(owner.userId, owner.sessionId, account.id)).toBe(204);
    expect(sendTemplateEmail).toHaveBeenCalledTimes(1);
    expect(await listGoogleAccounts(db, owner.userId)).toEqual([]);
  });

  it('sends nothing when there is nothing to delete', async () => {
    const owner = await addAccount(pg);
    const other = await addAccount(pg);
    const theirs = await addGoogleAccount(db, other.userId,
      { installationId: 'inst-3', accountId: 'acct-3', email: 'other.g@gmail.example' });
    expect(await unlink(owner.userId, owner.sessionId, randomUUID())).toBe(404);
    expect(await unlink(owner.userId, owner.sessionId, theirs.id)).toBe(404);
    expect(sendTemplateEmail).not.toHaveBeenCalled();
    expect(await listGoogleAccounts(db, other.userId)).toHaveLength(1);
  });
});
