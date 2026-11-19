// Account/security notification tests (API-TIME). notifySecurityEvent writes one
// 'security' row per kind for the account's owner (no space) and ignores every
// mute (#127); DELETE /api/account emails `account-deleted` BEFORE erasure, and a
// failing send never fails the erase (email-client and erasure call order
// observed through mocks).
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifySecurityEvent, type SecurityEventKind } from '../../src/notifications/notify.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { listNotifications, upsertPreference } from '../../src/notifications/store.ts';
import { createAccountRouter } from '../../src/account/http.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

const calls: string[] = [];
const sendTemplateEmail = vi.fn(async (input: { template: string; to: string }): Promise<void> => {
  calls.push(`send:${input.template}:${input.to}`);
});
vi.mock('../../src/notifications/email-client.ts', () => ({
  sendTemplateEmail: (input: { template: string; to: string }) => sendTemplateEmail(input),
  recipientEmail: async (_db: Db, userId: string): Promise<string> => {
    calls.push('resolve');
    return `${userId}@example.com`;
  },
}));
vi.mock('../../src/account/erasure-service.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/account/erasure-service.ts')>();
  return {
    ...actual,
    eraseAccount: async (...args: Parameters<typeof actual.eraseAccount>) => {
      calls.push('erase');
      return actual.eraseAccount(...args);
    },
  };
});

let pg: TestDb;
let db: Db;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  const app = express();
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
  app.use('/api/account', createAccountRouter({
    getDb: () => Promise.resolve(db),
    requireActiveSession: requireActiveSession(() => Promise.resolve(db)),
    deviceSessions: { closeDevice: vi.fn() },
    googleConnection: { revoke: vi.fn() },
  }));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.close();
  await closeTestDb(pg).catch(() => undefined);
});

beforeEach(() => {
  calls.length = 0;
  sendTemplateEmail.mockClear();
});

describe('security notifications', () => {
  const kinds: Array<[SecurityEventKind, string]> = [
    ['google_linked', 'google_account'], ['google_unlinked', 'google_account'],
    ['device_paired', 'device'], ['device_removed', 'device'],
  ];

  it.each(kinds)('%s writes one security row for the owner', async (kind, resourceType) => {
    const owner = await addAccount(pg);
    const resourceId = randomUUID();
    await notifySecurityEvent(db, owner.userId, kind, resourceId, 1);
    await notifySecurityEvent(db, owner.userId, kind, resourceId, 1); // replay: no duplicate

    const rows = await listNotifications(db, owner.userId, { limit: 100 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'security', resourceType, resourceId, spaceId: null,
      revision: 1, effectKey: `${kind}:${resourceId}:1` });
  });

  // #127 criterion 1: security notices get through every mute.
  it.each([
    ['a global mute', [{ muted: true }]],
    ['a security type mute', [{ type: 'security' as const, muted: true }]],
    ['both', [{ muted: true }, { type: 'security' as const, muted: true }]],
  ])('an owner with %s still gets one security row', async (_label, prefs) => {
    const owner = await addAccount(pg);
    for (const pref of prefs) await upsertPreference(db, owner.userId, pref);
    const resourceId = randomUUID();
    await notifySecurityEvent(db, owner.userId, 'device_paired', resourceId, 1);
    const rows = await listNotifications(db, owner.userId, { limit: 100 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'security', resourceType: 'device', resourceId });
  });
});

describe('account-deleted email', () => {
  async function deleteAccount(): Promise<{ status: number; userId: string }> {
    const account = await addAccount(pg);
    const token = await signToken({ userId: account.userId, sessionId: account.sessionId });
    const response = await fetch(`${baseUrl}/api/account`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    return { status: response.status, userId: account.userId };
  }

  it('resolves the address and sends before the account is erased', async () => {
    const { status, userId } = await deleteAccount();
    expect(status).toBe(204);
    expect(calls).toEqual(['resolve', `send:account-deleted:${userId}@example.com`, 'erase']);
  });

  it('a failing send never fails the erase', async () => {
    sendTemplateEmail.mockRejectedValueOnce(new Error('send_failed'));
    const { status } = await deleteAccount();
    expect(status).toBe(204);
    expect(calls).toContain('erase');
  });
});
