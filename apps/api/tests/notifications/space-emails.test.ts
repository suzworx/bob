// Space membership emails (core/space-emails.ts) through the real spaces router
// over real Postgres, with the email client's transport mocked: the invite, removal,
// ownership and archive routes mail the right people with the right template,
// never log a token or an address, and a failed send never fails the request.
// Accepting an invitation enqueues an 'invitation' notification to the inviter.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureInviteeAccount } from '../../src/account/provisioning.ts';
import { appUrl, emailConfigured, sendTemplateEmail } from '../../src/notifications/email-client.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { type Db } from '../../src/platform/db/db.ts';
import { listNotifications, upsertPreference } from '../../src/notifications/store.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createSpacesRouter } from '../../src/spaces/http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestAccount, type TestDb, withAdminAuth } from '../support/test-db.ts';

vi.mock('../../src/notifications/email-client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/notifications/email-client.ts')>()),
  emailConfigured: vi.fn(() => true),
  sendTemplateEmail: vi.fn(async () => undefined),
}));

vi.mock('../../src/account/provisioning.ts', () => ({
  ensureInviteeAccount: vi.fn(async () => 'exists'),
}));

const send = vi.mocked(sendTemplateEmail);
const configured = vi.mocked(emailConfigured);
const provision = vi.mocked(ensureInviteeAccount);

describe('space membership emails', () => {
  let pg: TestDb;
  let db: Db;
  let server: Server;
  let baseUrl: string;
  const journalLines: string[] = [];

  beforeAll(async () => {
    setJournalSink((line: string) => journalLines.push(line));
    pg = await createTestDb();
    db = asDb(pg);
    const app = express();
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use('/api', createSpacesRouter({ getDb: () => Promise.resolve(db),
      requireActiveSession: requireActiveSession(() => Promise.resolve(db)) }));
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    setJournalSink(null);
    server.close();
    await closeTestDb(pg);
  });

  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue(undefined);
    configured.mockReturnValue(true);
    journalLines.length = 0;
    provision.mockReset();
    provision.mockResolvedValue('exists');
  });

  async function person(name: string, email: string): Promise<TestAccount> {
    const account = await addAccount(pg);
    await withAdminAuth(pg, (admin) => admin.setProfile(account.userId, { email, name }));
    return account;
  }

  async function call(method: string, path: string, account: TestAccount, body?: unknown): Promise<Response> {
    const token = await signToken({ userId: account.userId, sessionId: account.sessionId });
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it('emails the invitee once with the accept link, and never logs the token or address', async () => {
    const maya = await person('Maya', 'maya@example.com');
    const space = await createSpace(db, maya.userId, { kind: 'group', name: 'Home' });

    const res = await call('POST', `/api/spaces/${space.id}/invitations`, maya,
      { email: 'arjun@example.com', role: 'admin' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; email_sent: boolean };
    expect(body.email_sent).toBe(true);
    expect(body.token.length).toBeGreaterThan(20);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ template: 'space-invite', to: 'arjun@example.com', data: {
      inviterName: 'Maya', spaceName: 'Home', spaceKind: 'group', role: 'admin',
      acceptUrl: appUrl(`/invite/${body.token}`), expiresLabel: expect.any(String) } });
    const log = journalLines.join('\n');
    expect(log).toContain('v2.space_email_sent');
    expect(log).not.toContain(body.token);
    expect(log).not.toContain('arjun@example.com');
    expect(log).not.toContain('Maya');
  });

  it('keeps the invitation and the copy link when the send fails or email is off', async () => {
    const maya = await person('Maya', 'maya2@example.com');
    const space = await createSpace(db, maya.userId, { kind: 'group', name: 'Home' });

    send.mockRejectedValueOnce(new Error('send_failed'));
    const failed = await call('POST', `/api/spaces/${space.id}/invitations`, maya,
      { email: 'arjun@example.com', role: 'member' });
    expect(failed.status).toBe(201);
    expect(await failed.json()).toMatchObject({ email_sent: false, token: expect.any(String) });
    expect(journalLines.join('\n')).toContain('v2.space_email_failed');

    configured.mockReturnValue(false);
    send.mockClear();
    const off = await call('POST', `/api/spaces/${space.id}/invitations`, maya,
      { email: 'arjun@example.com', role: 'member' });
    expect(off.status).toBe(201);
    expect(await off.json()).toMatchObject({ email_sent: false, token: expect.any(String) });
    expect(send).not.toHaveBeenCalled();
  });

  async function ownerSpace(email: string): Promise<{ account: TestAccount; spaceId: string }> {
    const account = await person('Maya', email);
    const space = await createSpace(db, account.userId, { kind: 'group', name: 'Home' });
    return { account, spaceId: space.id };
  }

  function invite(account: TestAccount, spaceId: string, email: string): Promise<Response> {
    return call('POST', `/api/spaces/${spaceId}/invitations`, account, { email, role: 'member' });
  }

  it('creates the account for a new address once, before the invite email', async () => {
    const { account, spaceId } = await ownerSpace('maya-p1@example.com');
    provision.mockResolvedValueOnce('created');
    const res = await invite(account, spaceId, 'new-p1@example.com');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ email_sent: true, account_created: true });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledWith('new-p1@example.com');
    expect(send).toHaveBeenCalledTimes(1);
    expect(provision.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0] ?? 0);
  });

  it('reports no new account for an address that already has one', async () => {
    const { account, spaceId } = await ownerSpace('maya-p2@example.com');
    provision.mockResolvedValueOnce('exists');
    const res = await invite(account, spaceId, 'maya-p1@example.com');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ email_sent: true, account_created: false });
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it('still invites and emails when provisioning fails', async () => {
    const { account, spaceId } = await ownerSpace('maya-p3@example.com');
    provision.mockResolvedValueOnce('failed');
    const res = await invite(account, spaceId, 'new-p3@example.com');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ email_sent: true, account_created: false,
      token: expect.any(String) });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('tells a removed member who removed them, and a self-leave mails nobody', async () => {
    const maya = await person('Maya', 'maya3@example.com');
    const arjun = await person('Arjun', 'arjun3@example.com');
    const sam = await person('Sam', 'sam3@example.com');
    const space = await createSpace(db, maya.userId, { kind: 'group', name: 'Home' });
    await addMember(db, maya.userId, space.id, arjun.userId, 'member');
    await addMember(db, maya.userId, space.id, sam.userId, 'member');

    send.mockRejectedValueOnce(new Error('send_failed'));
    expect((await call('DELETE', `/api/spaces/${space.id}/members/${arjun.userId}`, maya)).status).toBe(204);
    expect(send).toHaveBeenCalledWith({ template: 'space-member-removed', to: 'arjun3@example.com',
      data: { spaceName: 'Home', removedByName: 'Maya' } });

    send.mockClear();
    expect((await call('DELETE', `/api/spaces/${space.id}/members/${sam.userId}`, sam)).status).toBe(204);
    expect(send).not.toHaveBeenCalled();
  });

  it('tells the new owner, naming the previous one', async () => {
    const maya = await person('Maya', 'maya4@example.com');
    const arjun = await person('Arjun', 'arjun4@example.com');
    const space = await createSpace(db, maya.userId, { kind: 'group', name: 'Home' });
    await addMember(db, maya.userId, space.id, arjun.userId, 'member');

    const res = await call('PUT', `/api/spaces/${space.id}/owner`, maya, { user_id: arjun.userId });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ template: 'space-ownership-transferred', to: 'arjun4@example.com',
      data: { spaceName: 'Home', previousOwnerName: 'Maya', spaceUrl: appUrl(`/spaces/${space.id}`) } });
  });

  it('tells every other member once when a space is archived, even if a send fails', async () => {
    const maya = await person('Maya', 'maya5@example.com');
    const arjun = await person('Arjun', 'arjun5@example.com');
    const sam = await person('Sam', 'sam5@example.com');
    const space = await createSpace(db, maya.userId, { kind: 'group', name: 'Home' });
    await addMember(db, maya.userId, space.id, arjun.userId, 'member');
    await addMember(db, maya.userId, space.id, sam.userId, 'admin');

    send.mockRejectedValueOnce(new Error('send_failed'));
    expect((await call('DELETE', `/api/spaces/${space.id}`, maya)).status).toBe(200);
    expect(send.mock.calls.map(([input]) => input.to).sort()).toEqual(['arjun5@example.com', 'sam5@example.com']);
    expect(send.mock.calls.every(([input]) => input.template === 'space-archived'
      && (input.data as { archivedByName: string }).archivedByName === 'Maya')).toBe(true);

    send.mockClear();
    expect((await call('DELETE', `/api/spaces/${space.id}`, maya)).status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it('accepting an invitation notifies the inviter, unless they muted invitations', async () => {
    const maya = await person('Maya', 'maya6@example.com');
    const arjun = await person('Arjun', 'arjun6@example.com');
    const space = await createSpace(db, maya.userId, { kind: 'group', name: 'Home' });
    const created = await call('POST', `/api/spaces/${space.id}/invitations`, maya,
      { email: 'arjun6@example.com', role: 'member' });
    const { token, invitation } = (await created.json()) as { token: string; invitation: { id: string } };

    const accepted = await call('POST', `/api/invitations/${token}/accept`, arjun);
    expect(await accepted.json()).toEqual({ status: 'accepted' });
    const inbox = await listNotifications(db, maya.userId, { limit: 10 });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ type: 'invitation', resourceType: 'invitation',
      resourceId: invitation.id, spaceId: space.id, effectKey: `invitation_accepted:${invitation.id}` });

    const sam = await person('Sam', 'sam6@example.com');
    await upsertPreference(db, maya.userId, { type: 'invitation', muted: true });
    const again = await call('POST', `/api/spaces/${space.id}/invitations`, maya,
      { email: 'sam6@example.com', role: 'member' });
    const second = (await again.json()) as { token: string };
    expect((await call('POST', `/api/invitations/${second.token}/accept`, sam)).status).toBe(200);
    expect(await listNotifications(db, maya.userId, { limit: 10 })).toHaveLength(1);
  });

  it('accepting tells the inviter it was accepted, every other member someone joined, and never the joiner (#858)', async () => {
    const maya = await person('Maya', 'maya7@example.com');
    const sam = await person('Sam', 'sam7@example.com');
    const arjun = await person('Arjun', 'arjun7@example.com');
    const space = await createSpace(db, maya.userId, { kind: 'group', name: 'Home' });
    await addMember(db, maya.userId, space.id, sam.userId, 'admin');
    const created = await call('POST', `/api/spaces/${space.id}/invitations`, maya,
      { email: 'arjun7@example.com', role: 'member' });
    const { token, invitation } = (await created.json()) as { token: string; invitation: { id: string } };
    expect(await listNotifications(db, maya.userId, { limit: 10 })).toEqual([]);

    expect((await call('POST', `/api/invitations/${token}/accept`, arjun)).status).toBe(200);
    const owner = await listNotifications(db, maya.userId, { limit: 10 });
    expect(owner).toHaveLength(1);
    expect(owner[0]).toMatchObject({ type: 'invitation', resourceType: 'invitation', resourceId: invitation.id });
    const member = await listNotifications(db, sam.userId, { limit: 10 });
    expect(member).toHaveLength(1);
    expect(member[0]).toMatchObject({ type: 'invitation', resourceType: 'space_member',
      resourceId: arjun.userId, spaceId: space.id, effectKey: `member_joined:${invitation.id}` });
    expect(await listNotifications(db, arjun.userId, { limit: 10 })).toEqual([]);
  });
});
