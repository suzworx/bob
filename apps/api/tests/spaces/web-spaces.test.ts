// Spaces + invitations API tests (spec 014, S02/S03; contracts/api.md "Spaces
// and membership"). A real HTTP server over real Postgres exercises the JWT guard and
// the /api/spaces*, /api/invitations* router. Covers the identity-leak rule
// (a hidden space and a missing id are the same 404), the role-refusal 403
// (only when the caller can see the space), the account-less thin preview, and
// one failure-injection test per state-changing route (500 store_error).
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setJournalSink } from '../../src/platform/logger.ts';
import { StoreError, withUser, type Db } from '../../src/platform/db/db.ts';
import type { AccountEvent } from '../../src/account/events-bus.ts';
import { getAccountEvents } from '../../src/devices/pairing-service.ts';
import { getActiveSpace, setActiveSpace } from '../../src/spaces/active.ts';
import { getActive, setActive } from '../../src/conversations/active.ts';
import { createThread } from '../../src/conversations/thread-store.ts';
import { addMember, createSpace, ensurePrivateSpace, getSpace } from '../../src/spaces/store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, requireActiveSession } from '../../src/platform/http/auth-guard.ts';
import { createSpacesRouter } from '../../src/spaces/http.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  type TestAccount,
  type TestDb, withAdminAuth } from '../support/test-db.ts';

describe('spaces API (contracts/api.md "Spaces and membership")', () => {
  let pg: TestDb;
  let db: Db;
  let server: Server | undefined;
  let baseUrl: string;
  const journalLines: string[] = [];

  beforeAll(async () => {
    setJournalSink((line: string) => journalLines.push(line));
    pg = await createTestDb();
    db = asDb(pg);
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    app.use(
      '/api',
      createSpacesRouter({ getDb: () => Promise.resolve(db), requireActiveSession: requireActiveSession(() => Promise.resolve(db)) }),
    );
    const listening = await new Promise<Server>((resolve) => {
      const created = app.listen(0, () => resolve(created));
    });
    server = listening;
    const address = listening.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    setJournalSink(null);
    // beforeAll may have failed before the server or test db existed; closing
    // what was never created would bury the real error under a TypeError.
    server?.close();
    if (pg) await closeTestDb(pg);
  });

  async function tokenFor(account: TestAccount): Promise<string> {
    return signToken({ userId: account.userId, sessionId: account.sessionId });
  }

  async function setEmail(userId: string, email: string): Promise<void> {
    await withAdminAuth(pg, (admin) => admin.setProfile(userId, { email }));
  }

  async function setMetaName(userId: string, name: string): Promise<void> {
    await withAdminAuth(pg, (admin) => admin.setProfile(userId, { name }));
  }

  async function get(path: string, token: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  async function send(method: string, path: string, token: string | null, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it('GET /api/spaces returns only the caller spaces', async () => {
    const owner = await addAccount(pg);
    const token = await tokenFor(owner);
    const mine = await createSpace(db, owner.userId, { kind: 'group', name: 'Mine' });

    const other = await addAccount(pg);
    const otherSpace = await createSpace(db, other.userId, { kind: 'group', name: 'Theirs' });

    const res = await get('/api/spaces', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spaces: Array<{ id: string; name: string }> };
    const ids = body.spaces.map((entry) => entry.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(otherSpace.id);
    expect(body.spaces[0]).toMatchObject({ kind: 'group', role: 'owner' });
  });

  it('POST /api/spaces rejects kind private with a 400', async () => {
    const owner = await addAccount(pg);
    const token = await tokenFor(owner);
    const res = await send('POST', '/api/spaces', token, { kind: 'private', name: 'No' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'invalid_request' } });
  });

  it('POST /api/spaces creates a group and trims the name', async () => {
    const owner = await addAccount(pg);
    const token = await tokenFor(owner);
    const group = await send('POST', '/api/spaces', token, { kind: 'group', name: '  Family  ' });
    expect(group.status).toBe(201);
    expect((await group.json()) as { name: string; kind: string }).toMatchObject({
      name: 'Family',
      kind: 'group',
    });
  });

  // Escaped defect (prod 2026-10-06): New space -> Pair -> Create returned 500
  // (RLS). Spaces have no type now: a name alone creates one, and a released
  // client's legacy kind 'pair' is created the same way, owned by the caller.
  it.each([{ name: 'p1' }, { kind: 'pair', name: 'p1' }])('POST /api/spaces %j creates a space the caller owns and can open', async (request) => {
    const owner = await addAccount(pg);
    const token = await tokenFor(owner);
    const created = await send('POST', '/api/spaces', token, request);
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; name: string; kind: string; role: string };
    expect(body).toMatchObject({ name: 'p1', kind: 'group', role: 'owner' });
    const opened = await get(`/api/spaces/${body.id}`, token);
    expect(opened.status).toBe(200);
    const members = await get(`/api/spaces/${body.id}/members`, token);
    expect(((await members.json()) as { members: Array<{ user_id: string; role: string }> }).members).toEqual([
      expect.objectContaining({ user_id: owner.userId, role: 'owner' }),
    ]);
  });

  it('a non-member GET /api/spaces/:id is 404, identical to a random uuid', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Hidden' });

    const outsider = await addAccount(pg);
    const outsiderToken = await tokenFor(outsider);

    const hidden = await get(`/api/spaces/${space.id}`, outsiderToken);
    const missing = await get(`/api/spaces/${randomUUID()}`, outsiderToken);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const hiddenBody = await hidden.json();
    const missingBody = await missing.json();
    expect(hiddenBody).toEqual(missingBody);
    expect(hiddenBody).toEqual({ error: { code: 'not_found' } });
  });

  it('a plain member transfer-owner attempt is refused with 403 (they can see the space)', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const member = await addAccount(pg);
    const memberToken = await tokenFor(member);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Tight' });
    await addMember(db, owner.userId, space.id, member.userId, 'member');

    const res = await send('PUT', `/api/spaces/${space.id}/owner`, memberToken, {
      user_id: member.userId,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'forbidden' } });
  });

  it('GET /api/invitations/:token returns the thin preview and no space content', async () => {
    const owner = await addAccount(pg);
    await setEmail(owner.userId, 'owner@example.com');
    const ownerToken = await tokenFor(owner);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Preview' });

    const created = await send('POST', `/api/spaces/${space.id}/invitations`, ownerToken, {
      email: 'guest@example.com',
      role: 'member',
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { token: string; invitation: { id: string } };
    expect(createdBody.token.length).toBeGreaterThan(20);

    // The preview route is account-less: it works with a token (the guard) and
    // returns metadata only.
    const res = await get(`/api/invitations/${createdBody.token}`, ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { preview: Record<string, unknown> };
    expect(body.preview).toEqual({
      space_name: 'Preview',
      space_kind: 'group',
      inviter_display_name: 'owner@example.com',
      exposes_history: true,
      role: expect.any(String),
      expires_at: expect.any(Number),
    });
    // No space content leaks into the preview shape.
    expect(Object.keys(body.preview)).toEqual([
      'space_name',
      'space_kind',
      'inviter_display_name',
      'exposes_history',
      'role',
      'expires_at',
    ]);

    // An unknown/used token is a 404 with no detail.
    const bad = await get('/api/invitations/not-a-real-token', ownerToken);
    expect(bad.status).toBe(404);
  });

  it('POST /api/invitations/:token/accept admits the matching account once', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const invitee = await addAccount(pg);
    await setEmail(invitee.userId, 'admit@example.com');
    const inviteeToken = await tokenFor(invitee);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Admit' });

    const created = await send('POST', `/api/spaces/${space.id}/invitations`, ownerToken, {
      email: 'admit@example.com',
      role: 'member',
    });
    const { token } = (await created.json()) as { token: string };

    const first = await send('POST', `/api/invitations/${token}/accept`, inviteeToken, undefined);
    expect(first.status).toBe(200);
    expect((await first.json()) as { status: string }).toMatchObject({ status: 'accepted' });

    const second = await send('POST', `/api/invitations/${token}/accept`, inviteeToken, undefined);
    expect((await second.json()) as { status: string }).toMatchObject({ status: 'already_accepted' });

    const members = await get(`/api/spaces/${space.id}/members`, ownerToken);
    const memberIds = ((await members.json()) as { members: Array<{ user_id: string }> }).members.map(
      (entry) => entry.user_id,
    );
    expect(memberIds.filter((id) => id === invitee.userId)).toHaveLength(1);
  });

  it('DELETE /api/invitations/:id revokes a pending invitation', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Revoke' });
    const created = await send('POST', `/api/spaces/${space.id}/invitations`, ownerToken, {
      email: 'revoke@example.com',
      role: 'member',
    });
    const { invitation, token } = (await created.json()) as { invitation: { id: string }; token: string };

    const revoked = await send('DELETE', `/api/invitations/${invitation.id}`, ownerToken, undefined);
    expect(revoked.status).toBe(204);

    const preview = await get(`/api/invitations/${token}`, ownerToken);
    expect(preview.status).toBe(404);
  });

  it('DELETE /api/spaces/:id/members/:userId removes a member', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const member = await addAccount(pg);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Remove' });
    await addMember(db, owner.userId, space.id, member.userId, 'member');

    const res = await send(
      'DELETE',
      `/api/spaces/${space.id}/members/${member.userId}`,
      ownerToken,
      undefined,
    );
    expect(res.status).toBe(204);

    const members = await get(`/api/spaces/${space.id}/members`, ownerToken);
    const ids = ((await members.json()) as { members: Array<{ user_id: string }> }).members.map(
      (entry) => entry.user_id,
    );
    expect(ids).not.toContain(member.userId);
  });

  it('GET /api/spaces/:id/members includes display_name and email, plus the original fields', async () => {
    const owner = await addAccount(pg);
    await setMetaName(owner.userId, 'Ada Lovelace');
    await setEmail(owner.userId, 'ada2@example.com');
    const ownerToken = await tokenFor(owner);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Named' });

    const res = await get(`/api/spaces/${space.id}/members`, ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<Record<string, unknown>> };
    expect(body.members).toHaveLength(1);
    expect(body.members[0]).toMatchObject({
      user_id: owner.userId,
      role: 'owner',
      display_name: 'Ada Lovelace',
      email: 'ada2@example.com',
    });
    expect(body.members[0]).toHaveProperty('joined_at');
  });

  it('GET /api/spaces/:id/members carries the derived handle and no field changed', async () => {
    const owner = await addAccount(pg);
    await setMetaName(owner.userId, 'Ada Lovelace');
    await setEmail(owner.userId, 'ada3@example.com');
    const ownerToken = await tokenFor(owner);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Handles' });

    const res = await get(`/api/spaces/${space.id}/members`, ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<Record<string, unknown>> };
    expect(body.members).toHaveLength(1);
    const member = body.members[0]!;
    expect(member).toMatchObject({
      user_id: owner.userId,
      role: 'owner',
      display_name: 'Ada Lovelace',
      handle: 'ada.lovelace',
      email: 'ada3@example.com',
    });
    expect(member).toHaveProperty('joined_at');
    // handle is additive: the pre-existing key set is intact, plus `handle`.
    expect(Object.keys(member).sort()).toEqual([
      'display_name',
      'email',
      'handle',
      'joined_at',
      'role',
      'user_id',
    ]);
  });

  it('a non-member GET /api/spaces/:id/members is 404, identical to a missing id', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Hidden Members' });

    const outsider = await addAccount(pg);
    const outsiderToken = await tokenFor(outsider);

    const hidden = await get(`/api/spaces/${space.id}/members`, outsiderToken);
    const missing = await get(`/api/spaces/${randomUUID()}/members`, outsiderToken);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const hiddenBody = await hidden.json();
    const missingBody = await missing.json();
    expect(hiddenBody).toEqual(missingBody);
    expect(hiddenBody).toEqual({ error: { code: 'not_found' } });

    // The owner's own request still works -- proves the 404s above are the
    // membership check, not e.g. a broken route.
    const ownerView = await get(`/api/spaces/${space.id}/members`, ownerToken);
    expect(ownerView.status).toBe(200);
  });

  it('a group with only one owner DELETEs their own membership -> 409 last_owner; GET still works', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Solo Group' });

    const res = await send(
      'DELETE',
      `/api/spaces/${group.id}/members/${owner.userId}`,
      ownerToken,
      undefined,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'last_owner' } });

    const still = await get(`/api/spaces/${group.id}`, ownerToken);
    expect(still.status).toBe(200);
  });

  it('the owner of their private space DELETEs their own membership -> 409 private_space', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const private_ = await ensurePrivateSpace(db, owner.userId);

    const res = await send(
      'DELETE',
      `/api/spaces/${private_.id}/members/${owner.userId}`,
      ownerToken,
      undefined,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'private_space' } });

    const again = await ensurePrivateSpace(db, owner.userId);
    expect(again.id).toBe(private_.id);
  });

  it('after transferring ownership the former owner can leave and the new owner still sees the space', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const member = await addAccount(pg);
    const memberToken = await tokenFor(member);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Succession' });
    await addMember(db, owner.userId, group.id, member.userId, 'member');

    const transfer = await send('PUT', `/api/spaces/${group.id}/owner`, ownerToken, {
      user_id: member.userId,
    });
    expect(transfer.status).toBe(200);

    const left = await send(
      'DELETE',
      `/api/spaces/${group.id}/members/${owner.userId}`,
      ownerToken,
      undefined,
    );
    expect(left.status).toBe(204);

    const stillSees = await get(`/api/spaces/${group.id}`, memberToken);
    expect(stillSees.status).toBe(200);
  });

  it('PATCH /api/spaces/:id/members/:userId lets the owner promote and demote, answering 204 and bumping the revision', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const member = await addAccount(pg);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Promote' });
    await addMember(db, owner.userId, group.id, member.userId, 'member');
    const before = (await getSpace(db, owner.userId, group.id)).membershipRevision;

    const promote = await send('PATCH', `/api/spaces/${group.id}/members/${member.userId}`, ownerToken, { role: 'admin' });
    expect(promote.status).toBe(204);
    const afterPromote = await get(`/api/spaces/${group.id}/members`, ownerToken);
    const promoted = ((await afterPromote.json()) as { members: Array<{ user_id: string; role: string }> }).members;
    expect(promoted.find((m) => m.user_id === member.userId)?.role).toBe('admin');
    expect((await getSpace(db, owner.userId, group.id)).membershipRevision).toBe(before + 1);

    const demote = await send('PATCH', `/api/spaces/${group.id}/members/${member.userId}`, ownerToken, { role: 'member' });
    expect(demote.status).toBe(204);
    expect((await getSpace(db, owner.userId, group.id)).membershipRevision).toBe(before + 2);
  });

  it('PATCH /api/spaces/:id/members/:userId is 403 for an admin or member, 404 for an outsider and a random uuid, and 403 for an owner target', async () => {
    const owner = await addAccount(pg);
    const admin = await addAccount(pg);
    const member = await addAccount(pg);
    const outsider = await addAccount(pg);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Guarded' });
    await addMember(db, owner.userId, group.id, admin.userId, 'admin');
    await addMember(db, owner.userId, group.id, member.userId, 'member');
    const path = `/api/spaces/${group.id}/members/${member.userId}`;

    for (const caller of [admin, member]) {
      const res = await send('PATCH', path, await tokenFor(caller), { role: 'admin' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: 'forbidden' } });
    }
    const hidden = await send('PATCH', path, await tokenFor(outsider), { role: 'admin' });
    const missing = await send('PATCH', `/api/spaces/${randomUUID()}/members/${member.userId}`, await tokenFor(outsider), { role: 'admin' });
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());

    const ownerTarget = await send('PATCH', `/api/spaces/${group.id}/members/${owner.userId}`, await tokenFor(owner), { role: 'member' });
    expect(ownerTarget.status).toBe(403);
    const unknown = await send('PATCH', `/api/spaces/${group.id}/members/${randomUUID()}`, await tokenFor(owner), { role: 'admin' });
    expect(unknown.status).toBe(404);
  });

  it('PATCH /api/spaces/:id/members/:userId rejects an invalid body with 400 and a missing token with 401', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const member = await addAccount(pg);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Strict' });
    await addMember(db, owner.userId, group.id, member.userId, 'member');
    const path = `/api/spaces/${group.id}/members/${member.userId}`;

    for (const body of [{ role: 'owner' }, { role: 'admin', extra: 1 }, {}, { role: 7 }]) {
      expect((await send('PATCH', path, ownerToken, body)).status).toBe(400);
    }
    expect((await send('PATCH', `/api/spaces/${group.id}/members/not-a-uuid`, ownerToken, { role: 'admin' })).status).toBe(400);
    expect((await send('PATCH', path, null, { role: 'admin' })).status).toBe(401);
  });

  it('PUT /api/spaces/:id/owner on a private space is 409 unsupported_kind', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const other = await addAccount(pg);
    const private_ = await ensurePrivateSpace(db, owner.userId);
    await addMember(db, owner.userId, private_.id, other.userId, 'member');

    const res = await send('PUT', `/api/spaces/${private_.id}/owner`, ownerToken, {
      user_id: other.userId,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'unsupported_kind' } });
  });

  it('PATCH /api/spaces/:id renames for an owner or admin, trimming the name', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const admin = await addAccount(pg);
    const adminToken = await tokenFor(admin);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Original' });
    await addMember(db, owner.userId, group.id, admin.userId, 'admin');

    const byOwner = await send('PATCH', `/api/spaces/${group.id}`, ownerToken, { name: '  Den  ' });
    expect(byOwner.status).toBe(200);
    expect((await byOwner.json()) as { name: string }).toMatchObject({ name: 'Den' });

    const byAdmin = await send('PATCH', `/api/spaces/${group.id}`, adminToken, { name: 'Den 2' });
    expect(byAdmin.status).toBe(200);
  });

  it('PATCH /api/spaces/:id is 403 for a plain member and 404 for a non-member, identical to a random uuid', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const member = await addAccount(pg);
    const memberToken = await tokenFor(member);
    const outsider = await addAccount(pg);
    const outsiderToken = await tokenFor(outsider);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Guarded' });
    await addMember(db, owner.userId, group.id, member.userId, 'member');

    const byMember = await send('PATCH', `/api/spaces/${group.id}`, memberToken, { name: 'Nope' });
    expect(byMember.status).toBe(403);
    expect(await byMember.json()).toEqual({ error: { code: 'forbidden' } });

    const hidden = await send('PATCH', `/api/spaces/${group.id}`, outsiderToken, { name: 'Nope' });
    const missing = await send('PATCH', `/api/spaces/${randomUUID()}`, outsiderToken, { name: 'Nope' });
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const hiddenBody = await hidden.json();
    const missingBody = await missing.json();
    expect(hiddenBody).toEqual(missingBody);
    expect(hiddenBody).toEqual({ error: { code: 'not_found' } });
  });

  it('PATCH /api/spaces/:id rejects an empty name, a too-long name, and an unknown field with 400', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Validated' });

    const empty = await send('PATCH', `/api/spaces/${group.id}`, ownerToken, { name: '' });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: { code: 'invalid_request' } });

    const tooLong = await send('PATCH', `/api/spaces/${group.id}`, ownerToken, { name: 'x'.repeat(61) });
    expect(tooLong.status).toBe(400);

    const extra = await send('PATCH', `/api/spaces/${group.id}`, ownerToken, { name: 'x', extra: 1 });
    expect(extra.status).toBe(400);
  });

  it('PATCH /api/spaces/:id on a private space is 409 unsupported_kind', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const private_ = await ensurePrivateSpace(db, owner.userId);

    const res = await send('PATCH', `/api/spaces/${private_.id}`, ownerToken, { name: 'Nope' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'unsupported_kind' } });
  });

  it('PATCH /api/spaces/:id journals v2.space_renamed with the space id, never the name', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const group = await createSpace(db, owner.userId, { kind: 'group', name: 'Before' });

    journalLines.length = 0;
    const res = await send('PATCH', `/api/spaces/${group.id}`, ownerToken, { name: 'Secret Den' });
    expect(res.status).toBe(200);

    const renamed = journalLines.find((line) => line.includes('v2.space_renamed'));
    expect(renamed).toBeDefined();
    expect(renamed).toContain(group.id);
    expect(journalLines.some((line) => line.includes('Secret Den'))).toBe(false);
  });

  it('GET /api/spaces summaries carry archived_at: null for a live space', async () => {
    const owner = await addAccount(pg);
    const token = await tokenFor(owner);
    await createSpace(db, owner.userId, { kind: 'group', name: 'Live' });

    const res = await get('/api/spaces', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spaces: Array<{ archived_at: number | null }> };
    expect(body.spaces.length).toBeGreaterThan(0);
    for (const space of body.spaces) {
      expect(space.archived_at).toBeNull();
    }
  });

  it('DELETE /api/spaces/:id archives a group: 200, hidden from the default list, listed by ?archived=true, still readable', async () => {
    const owner = await addAccount(pg);
    const token = await tokenFor(owner);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Archive Me' });

    const res = await send('DELETE', `/api/spaces/${space.id}`, token, undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { archived_at: number | null };
    expect(typeof body.archived_at).toBe('number');

    const list = await get('/api/spaces', token);
    const liveIds = ((await list.json()) as { spaces: Array<{ id: string }> }).spaces.map((s) => s.id);
    expect(liveIds).not.toContain(space.id);

    const archivedList = await get('/api/spaces?archived=true', token);
    const archivedIds = ((await archivedList.json()) as { spaces: Array<{ id: string }> }).spaces.map(
      (s) => s.id,
    );
    expect(archivedIds).toContain(space.id);

    const byId = await get(`/api/spaces/${space.id}`, token);
    expect(byId.status).toBe(200);
    const members = await get(`/api/spaces/${space.id}/members`, token);
    expect(members.status).toBe(200);
  });

  it('GET /api/spaces?archived=true lists the space for the owner only, not a plain member', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const member = await addAccount(pg);
    const memberToken = await tokenFor(member);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Owner Only Archive' });
    await addMember(db, owner.userId, space.id, member.userId, 'member');

    const archived = await send('DELETE', `/api/spaces/${space.id}`, ownerToken, undefined);
    expect(archived.status).toBe(200);

    const ownerList = await get('/api/spaces?archived=true', ownerToken);
    const ownerIds = ((await ownerList.json()) as { spaces: Array<{ id: string }> }).spaces.map((s) => s.id);
    expect(ownerIds).toContain(space.id);

    const memberList = await get('/api/spaces?archived=true', memberToken);
    const memberIds = ((await memberList.json()) as { spaces: Array<{ id: string }> }).spaces.map((s) => s.id);
    expect(memberIds).not.toContain(space.id);
  });

  it('archiving a space revokes pending invitations (preview 404) and refuses new invitations with 409', async () => {
    const owner = await addAccount(pg);
    const token = await tokenFor(owner);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Invite Then Archive' });
    const created = await send('POST', `/api/spaces/${space.id}/invitations`, token, {
      email: 'pending@example.com',
      role: 'member',
    });
    const { token: inviteToken } = (await created.json()) as { token: string };

    const archived = await send('DELETE', `/api/spaces/${space.id}`, token, undefined);
    expect(archived.status).toBe(200);

    const preview = await get(`/api/invitations/${inviteToken}`, token);
    expect(preview.status).toBe(404);

    const newInvite = await send('POST', `/api/spaces/${space.id}/invitations`, token, {
      email: 'later@example.com',
      role: 'member',
    });
    expect(newInvite.status).toBe(409);
    expect(await newInvite.json()).toEqual({ error: { code: 'space_archived' } });
  });

  it('DELETE /api/spaces/:id is 403 for an admin or member, and 404 for a non-member (identical to a random uuid)', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const admin = await addAccount(pg);
    const adminToken = await tokenFor(admin);
    const member = await addAccount(pg);
    const memberToken = await tokenFor(member);
    const outsider = await addAccount(pg);
    const outsiderToken = await tokenFor(outsider);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Guarded Archive' });
    await addMember(db, owner.userId, space.id, admin.userId, 'admin');
    await addMember(db, owner.userId, space.id, member.userId, 'member');

    const byAdmin = await send('DELETE', `/api/spaces/${space.id}`, adminToken, undefined);
    expect(byAdmin.status).toBe(403);
    expect(await byAdmin.json()).toEqual({ error: { code: 'forbidden' } });

    const byMember = await send('DELETE', `/api/spaces/${space.id}`, memberToken, undefined);
    expect(byMember.status).toBe(403);
    expect(await byMember.json()).toEqual({ error: { code: 'forbidden' } });

    const hidden = await send('DELETE', `/api/spaces/${space.id}`, outsiderToken, undefined);
    const missing = await send('DELETE', `/api/spaces/${randomUUID()}`, outsiderToken, undefined);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const hiddenBody = await hidden.json();
    const missingBody = await missing.json();
    expect(hiddenBody).toEqual(missingBody);
    expect(hiddenBody).toEqual({ error: { code: 'not_found' } });
  });

  it('DELETE /api/spaces/:id on a private space is 409 unsupported_kind', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const private_ = await ensurePrivateSpace(db, owner.userId);

    const res = await send('DELETE', `/api/spaces/${private_.id}`, ownerToken, undefined);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'unsupported_kind' } });
  });

  it('PATCH { archived: false } restores for the owner, listing the space again; an admin is refused with 403', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const admin = await addAccount(pg);
    const adminToken = await tokenFor(admin);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Restore Me' });
    await addMember(db, owner.userId, space.id, admin.userId, 'admin');
    await send('DELETE', `/api/spaces/${space.id}`, ownerToken, undefined);

    const byAdmin = await send('PATCH', `/api/spaces/${space.id}`, adminToken, { archived: false });
    expect(byAdmin.status).toBe(403);

    const byOwner = await send('PATCH', `/api/spaces/${space.id}`, ownerToken, { archived: false });
    expect(byOwner.status).toBe(200);
    const body = (await byOwner.json()) as { archived_at: number | null };
    expect(body.archived_at).toBeNull();

    const list = await get('/api/spaces', ownerToken);
    const ids = ((await list.json()) as { spaces: Array<{ id: string }> }).spaces.map((s) => s.id);
    expect(ids).toContain(space.id);
  });

  it('PATCH { name } on an archived space is 409 space_archived', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Frozen' });
    await send('DELETE', `/api/spaces/${space.id}`, ownerToken, undefined);

    const res = await send('PATCH', `/api/spaces/${space.id}`, ownerToken, { name: 'Nope' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'space_archived' } });
  });

  it('PATCH /api/spaces/:id rejects both fields, archived: true, and GET ?archived=maybe with 400', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Strict' });

    const both = await send('PATCH', `/api/spaces/${space.id}`, ownerToken, { name: 'X', archived: false });
    expect(both.status).toBe(400);

    const trueArchived = await send('PATCH', `/api/spaces/${space.id}`, ownerToken, { archived: true });
    expect(trueArchived.status).toBe(400);

    const badQuery = await get('/api/spaces?archived=maybe', ownerToken);
    expect(badQuery.status).toBe(400);
    expect(await badQuery.json()).toEqual({ error: { code: 'invalid_request' } });
  });

  it('archive then restore leaves the members list and membership_revision unchanged', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const member = await addAccount(pg);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Unchanged' });
    await addMember(db, owner.userId, space.id, member.userId, 'member');

    const before = await get(`/api/spaces/${space.id}`, ownerToken);
    const beforeRevision = ((await before.json()) as { membership_revision: number }).membership_revision;
    const beforeMembers = await get(`/api/spaces/${space.id}/members`, ownerToken);
    const beforeIds = ((await beforeMembers.json()) as { members: Array<{ user_id: string }> }).members
      .map((m) => m.user_id)
      .sort();

    await send('DELETE', `/api/spaces/${space.id}`, ownerToken, undefined);
    await send('PATCH', `/api/spaces/${space.id}`, ownerToken, { archived: false });

    const after = await get(`/api/spaces/${space.id}`, ownerToken);
    const afterRevision = ((await after.json()) as { membership_revision: number }).membership_revision;
    const afterMembers = await get(`/api/spaces/${space.id}/members`, ownerToken);
    const afterIds = ((await afterMembers.json()) as { members: Array<{ user_id: string }> }).members
      .map((m) => m.user_id)
      .sort();

    expect(afterRevision).toBe(beforeRevision);
    expect(afterIds).toEqual(beforeIds);
  });

  it('v2.space_archived and v2.space_restored carry ids and counts only, never the name', async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Secret Archive Name' });

    journalLines.length = 0;
    const archived = await send('DELETE', `/api/spaces/${space.id}`, ownerToken, undefined);
    expect(archived.status).toBe(200);
    const archivedLine = journalLines.find((line) => line.includes('v2.space_archived'));
    expect(archivedLine).toBeDefined();
    expect(archivedLine).toContain(space.id);
    expect(journalLines.some((line) => line.includes('Secret Archive Name'))).toBe(false);

    journalLines.length = 0;
    const restored = await send('PATCH', `/api/spaces/${space.id}`, ownerToken, { archived: false });
    expect(restored.status).toBe(200);
    const restoredLine = journalLines.find((line) => line.includes('v2.space_restored'));
    expect(restoredLine).toBeDefined();
    expect(restoredLine).toContain(space.id);
    expect(journalLines.some((line) => line.includes('Secret Archive Name'))).toBe(false);
  });

  it("after the owner's session ends, DELETE /api/spaces/:id and PUT /api/spaces/:id/owner answer 401 invalid_token and change nothing", async () => {
    const owner = await addAccount(pg);
    const ownerToken = await tokenFor(owner);
    const member = await addAccount(pg);
    const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Guarded By Session' });
    await addMember(db, owner.userId, space.id, member.userId, 'member');

    await withAdminAuth(pg, (admin) => admin.endSession(owner.sessionId));

    const archive = await send('DELETE', `/api/spaces/${space.id}`, ownerToken, undefined);
    expect(archive.status).toBe(401);
    expect(await archive.json()).toMatchObject({ error: { code: 'invalid_token' } });

    const transfer = await send('PUT', `/api/spaces/${space.id}/owner`, ownerToken, {
      user_id: member.userId,
    });
    expect(transfer.status).toBe(401);
    expect(await transfer.json()).toMatchObject({ error: { code: 'invalid_token' } });

    // GET is not behind requireActiveSession, so the same (session-ended) token
    // still authenticates it -- confirming neither guarded action went through.
    const still = await get(`/api/spaces/${space.id}`, ownerToken);
    expect(still.status).toBe(200);
    const stillBody = (await still.json()) as { role: string; archived_at: number | null };
    expect(stillBody.archived_at).toBeNull();
    expect(stillBody.role).toBe('owner');
  });

  it('every state-changing route answers 500 store_error on a store outage', async () => {
    const account = await addAccount(pg);
    const token = await tokenFor(account);
    const boom = new StoreError('store down');
    const stubDb = {
      query: async (): Promise<never> => {
        throw boom;
      },
      tx: async <T>(): Promise<T> => {
        throw boom;
      },
    } as unknown as Db;

    const stubApp = express();
    stubApp.use(express.json());
    stubApp.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
    // The stub db throws on every query, including the one requireActiveSession
    // itself would run -- the real guard would report that as 401 invalid_token
    // instead of exercising each route's own 500 store_error mapping, so this
    // construction gets a pass-through in place of the real guard.
    stubApp.use(
      '/api',
      createSpacesRouter({
        getDb: () => Promise.resolve(stubDb),
        requireActiveSession: async (_request, _response, next) => {
          next();
        },
      }),
    );
    const stubServer = await new Promise<Server>((resolve) => {
      const s = stubApp.listen(0, () => resolve(s));
    });
    const stubBase = `http://127.0.0.1:${(stubServer.address() as AddressInfo).port}`;
    try {
      const spaceId = randomUUID();
      const memberId = randomUUID();
      const invitationId = randomUUID();
      const routes: Array<[string, string, unknown]> = [
        ['POST', '/api/spaces', { kind: 'group', name: 'X' }],
        ['PATCH', `/api/spaces/${spaceId}`, { name: 'X' }],
        ['PATCH', `/api/spaces/${spaceId}`, { archived: false }],
        ['DELETE', `/api/spaces/${spaceId}`, undefined],
        ['PUT', `/api/spaces/${spaceId}/owner`, { user_id: memberId }],
        ['DELETE', `/api/spaces/${spaceId}/members/${memberId}`, undefined],
        ['POST', `/api/spaces/${spaceId}/invitations`, { email: 'x@example.com', role: 'member' }],
        ['DELETE', `/api/invitations/${invitationId}`, undefined],
        ['POST', `/api/invitations/sometoken/accept`, undefined],
      ];
      for (const [method, path, body] of routes) {
        const res = await fetch(`${stubBase}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: { code: 'store_error' } });
      }
    } finally {
      await new Promise<void>((resolve) => stubServer.close(() => resolve()));
    }
  });

  describe('active Space pointers (#301)', () => {
    async function point(userId: string, spaceId: string): Promise<void> {
      await withUser(db, userId, (tx) => setActiveSpace(tx, userId, spaceId, 'web'));
    }

    function collect(userIds: string[]): { events: Map<string, AccountEvent[]>; stop: () => void } {
      const events = new Map<string, AccountEvent[]>();
      const stops = userIds.map((userId) => {
        events.set(userId, []);
        return getAccountEvents().subscribe(userId, (event) => events.get(userId)!.push(event));
      });
      return { events, stop: () => stops.forEach((stop) => stop()) };
    }

    function pointerEvents(events: AccountEvent[] | undefined): AccountEvent[] {
      return (events ?? []).filter((event) => event.type !== 'space.access_changed');
    }

    function accessEvents(events: AccountEvent[] | undefined): AccountEvent[] {
      return (events ?? []).filter((event) => event.type === 'space.access_changed');
    }

    it('revoking a member without active pointers still publishes access invalidation only to that member', async () => {
      const owner = await addAccount(pg);
      const member = await addAccount(pg);
      const space = await createSpace(db, owner.userId, { kind: 'group', name: 'No pointers' });
      await addMember(db, owner.userId, space.id, member.userId, 'member');
      expect(await getActiveSpace(db, member.userId)).toBeNull();
      expect(await getActive(db, member.userId)).toBeNull();
      const { events, stop } = collect([owner.userId, member.userId]);
      try {
        const res = await send('DELETE', `/api/spaces/${space.id}/members/${member.userId}`, await tokenFor(owner), undefined);
        expect(res.status).toBe(204);
        expect(events.get(member.userId)).toEqual([{ type: 'space.access_changed', space_id: space.id }]);
        expect(events.get(owner.userId)).toEqual([]);
        expect((await get(`/api/spaces/${space.id}`, await tokenFor(member))).status).toBe(404);
      } finally { stop(); }
    });

    it('ownership transfer publishes access invalidation to the old and new owner only', async () => {
      const owner = await addAccount(pg);
      const nextOwner = await addAccount(pg);
      const member = await addAccount(pg);
      const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Handover' });
      await addMember(db, owner.userId, space.id, nextOwner.userId, 'member');
      await addMember(db, owner.userId, space.id, member.userId, 'member');
      const { events, stop } = collect([owner.userId, nextOwner.userId, member.userId]);
      try {
        const res = await send('PUT', `/api/spaces/${space.id}/owner`, await tokenFor(owner), { user_id: nextOwner.userId });
        expect(res.status).toBe(200);
        for (const account of [owner, nextOwner]) {
          expect(events.get(account.userId)).toEqual([{ type: 'space.access_changed', space_id: space.id }]);
        }
        expect(events.get(member.userId)).toEqual([]);
      } finally { stop(); }
    });

    it('role changes publish after commit to the changed member, with no event for a refusal or unchanged role', async () => {
      const owner = await addAccount(pg);
      const member = await addAccount(pg);
      const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Role refresh' });
      await addMember(db, owner.userId, space.id, member.userId, 'member');
      const ownerToken = await tokenFor(owner);
      const memberToken = await tokenFor(member);
      const path = `/api/spaces/${space.id}/members/${member.userId}`;
      const { events, stop } = collect([owner.userId, member.userId]);
      const committedRoles: Promise<string>[] = [];
      const stopRead = getAccountEvents().subscribe(member.userId, (event) => {
        if (event.type === 'space.access_changed') {
          committedRoles.push(getSpace(db, member.userId, space.id).then((current) => current.role));
        }
      });
      try {
        expect((await send('PATCH', path, memberToken, { role: 'admin' })).status).toBe(403);
        expect((await send('PATCH', path, ownerToken, { role: 'member' })).status).toBe(204);
        expect(events.get(member.userId)).toEqual([]);
        for (const role of ['admin', 'member']) {
          expect((await send('PATCH', path, ownerToken, { role })).status).toBe(204);
          expect(await committedRoles.at(-1)).toBe(role);
        }
        expect(events.get(member.userId)).toEqual([
          { type: 'space.access_changed', space_id: space.id },
          { type: 'space.access_changed', space_id: space.id },
        ]);
        expect(events.get(owner.userId)).toEqual([]);
      } finally { stopRead(); stop(); }
    });

    it('archive clears matching pointers and publishes access invalidation to every current member', async () => {
      const owner = await addAccount(pg);
      const pointed = await addAccount(pg);
      const elsewhere = await addAccount(pg);
      const unpointed = await addAccount(pg);
      const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Closing' });
      const other = await createSpace(db, owner.userId, { kind: 'group', name: 'Staying' });
      await addMember(db, owner.userId, space.id, pointed.userId, 'member');
      await addMember(db, owner.userId, space.id, elsewhere.userId, 'member');
      await addMember(db, owner.userId, space.id, unpointed.userId, 'member');
      await addMember(db, owner.userId, other.id, elsewhere.userId, 'member');
      await point(owner.userId, space.id);
      await point(pointed.userId, space.id);
      await point(elsewhere.userId, other.id);

      const { events, stop } = collect([owner.userId, pointed.userId, elsewhere.userId, unpointed.userId]);
      const res = await send('DELETE', `/api/spaces/${space.id}`, await tokenFor(owner), undefined);
      stop();
      expect(res.status).toBe(200);
      for (const userId of [owner.userId, pointed.userId]) {
        expect(pointerEvents(events.get(userId))).toEqual([
          expect.objectContaining({ type: 'active_space.changed', space_id: null, name: null }),
        ]);
      }
      expect(pointerEvents(events.get(elsewhere.userId))).toEqual([]);
      expect(pointerEvents(events.get(unpointed.userId))).toEqual([]);
      for (const account of [owner, pointed, elsewhere, unpointed]) {
        expect(accessEvents(events.get(account.userId))).toEqual([{ type: 'space.access_changed', space_id: space.id }]);
      }
      expect((await getActiveSpace(db, elsewhere.userId))?.spaceId).toBe(other.id);
      const cleared = await getActiveSpace(db, pointed.userId);
      expect(cleared?.spaceId).toBeNull();
      // Cleared by the archive itself, not lazily by this read.
      expect(cleared?.cleared).toBe(false);
    });

    it("revoking a member clears that member's pointer only", async () => {
      const owner = await addAccount(pg);
      const member = await addAccount(pg);
      const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Revoke' });
      await addMember(db, owner.userId, space.id, member.userId, 'member');
      await point(owner.userId, space.id);
      await point(member.userId, space.id);

      const { events, stop } = collect([owner.userId, member.userId]);
      const res = await send('DELETE', `/api/spaces/${space.id}/members/${member.userId}`, await tokenFor(owner), undefined);
      stop();
      expect(res.status).toBe(204);
      expect(pointerEvents(events.get(member.userId))).toEqual([
        expect.objectContaining({ type: 'active_space.changed', space_id: null, name: null, surface: 'web' }),
      ]);
      expect(events.get(owner.userId)).toEqual([]);
      expect(accessEvents(events.get(member.userId))).toEqual([{ type: 'space.access_changed', space_id: space.id }]);
      expect((await getActiveSpace(db, member.userId))?.cleared).toBe(false);
      expect((await getActiveSpace(db, owner.userId))?.spaceId).toBe(space.id);
    });

    describe("a Cardputer pointed at one of the space's threads (#565 D7)", () => {
      /** An owner, a member, a group space with a thread both point at. */
      async function pointedAtThread(): Promise<{ owner: TestAccount; member: TestAccount; spaceId: string }> {
        const owner = await addAccount(pg);
        const member = await addAccount(pg);
        const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Threaded' });
        await addMember(db, owner.userId, space.id, member.userId, 'member');
        const thread = await createThread(db, owner.userId, { spaceId: space.id, title: 'Plans' });
        for (const userId of [owner.userId, member.userId]) {
          await withUser(db, userId, (tx) => setActive(tx, userId, `thr_${thread.id}`, 'activate'));
        }
        return { owner, member, spaceId: space.id };
      }

      const clearedEvent = expect.objectContaining({ type: 'active.changed', conversation_id: null, title: null });

      it("revoking a member clears that member's thread pointer only, and publishes it", async () => {
        const { owner, member, spaceId } = await pointedAtThread();
        const { events, stop } = collect([owner.userId, member.userId]);
        const res = await send('DELETE', `/api/spaces/${spaceId}/members/${member.userId}`, await tokenFor(owner), undefined);
        stop();
        expect(res.status).toBe(204);
        expect(pointerEvents(events.get(member.userId))).toEqual([clearedEvent]);
        expect(accessEvents(events.get(member.userId))).toEqual([{ type: 'space.access_changed', space_id: spaceId }]);
        expect(events.get(owner.userId)).toEqual([]);
        expect(await getActive(db, member.userId)).toMatchObject({ conversationId: null, cleared: false });
        expect((await getActive(db, owner.userId))?.kind).toBe('thread');
      });

      it('leaving clears the leaver\'s thread pointer and publishes it', async () => {
        const { member, spaceId } = await pointedAtThread();
        const { events, stop } = collect([member.userId]);
        const res = await send('DELETE', `/api/spaces/${spaceId}/members/${member.userId}`, await tokenFor(member), undefined);
        stop();
        expect(res.status).toBe(204);
        expect(pointerEvents(events.get(member.userId))).toEqual([clearedEvent]);
        expect(accessEvents(events.get(member.userId))).toEqual([{ type: 'space.access_changed', space_id: spaceId }]);
        expect(await getActive(db, member.userId)).toMatchObject({ conversationId: null, cleared: false });
      });

      it("archiving clears every member's thread pointer and publishes it", async () => {
        const { owner, member, spaceId } = await pointedAtThread();
        const { events, stop } = collect([owner.userId, member.userId]);
        const res = await send('DELETE', `/api/spaces/${spaceId}`, await tokenFor(owner), undefined);
        stop();
        expect(res.status).toBe(200);
        for (const account of [owner, member]) {
          expect(pointerEvents(events.get(account.userId))).toEqual([clearedEvent]);
          expect(accessEvents(events.get(account.userId))).toEqual([{ type: 'space.access_changed', space_id: spaceId }]);
          expect(await getActive(db, account.userId)).toMatchObject({ conversationId: null, cleared: false });
        }
      });
    });

    it('failed event delivery is journaled without failing a committed role change or archive', async () => {
      const owner = await addAccount(pg);
      const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Loud' });
      const member = await addAccount(pg);
      await addMember(db, owner.userId, space.id, member.userId, 'member');
      await point(owner.userId, space.id);
      const app = express();
      app.use(express.json());
      app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer })));
      app.use('/api', createSpacesRouter({
        getDb: () => Promise.resolve(db),
        requireActiveSession: async (_request, _response, next) => {
          next();
        },
        events: {
          publish: () => {
            throw new Error('bus down');
          },
        },
      }));
      const stubServer = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      try {
        const roleRes = await fetch(`http://127.0.0.1:${(stubServer.address() as AddressInfo).port}/api/spaces/${space.id}/members/${member.userId}`, {
          method: 'PATCH',
          headers: { authorization: `Bearer ${await tokenFor(owner)}`, 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'admin' }),
        });
        expect(roleRes.status).toBe(204);
        expect((await getSpace(db, member.userId, space.id)).role).toBe('admin');
        expect(journalLines.some((line) => line.includes('v2.space_access_publish_failed'))).toBe(true);
        const start = journalLines.length;
        const res = await fetch(`http://127.0.0.1:${(stubServer.address() as AddressInfo).port}/api/spaces/${space.id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${await tokenFor(owner)}` },
        });
        expect(res.status).toBe(200);
        const logged = journalLines.slice(start).map((line) => JSON.parse(line) as { event: string });
        expect(logged.map((entry) => entry.event)).toContain('v2.active_space_clear_failed');
        expect(journalLines.slice(start).join('\n')).not.toContain(owner.userId);
      } finally {
        await new Promise<void>((resolve) => stubServer.close(() => resolve()));
      }
    });
  });
});
