/**
 * Correction (014, follow-on to the S14-T015 gate): GET /api/invitations/:token
 * is written as the one account-less route under /api (web-spaces.ts,
 * contracts/api.md "Unauthenticated-safe preview") -- an invited person who is
 * not yet a member, and may have no account at all, must be able to load it
 * from an email link. But server.ts mounted createSpacesRouter entirely BEHIND
 * the blanket `/api` JWT guard, so the guard rejected the request with 401
 * missing_token before the route ever ran. web-spaces.test.ts's own preview
 * test never caught this: it builds a bare test app and always sends a bearer
 * token on every request, including this one ("it works with a token (the
 * guard) and returns metadata only" -- the file's own comment), so it never
 * exercised the no-token case the contract actually requires.
 *
 * This test boots the REAL createV2Server() (the exact mount order server.ts
 * wires, not a bespoke bare app) and asserts the behavioural contract that
 * matters: the preview answers with no Authorization header at all, and
 * accepting -- which binds the invitation to a real account -- still refuses
 * an unauthenticated caller.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createV2Server } from '../../src/server.ts';
import { closeDb, setSharedDb } from '../../src/platform/db/db.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { createInvitation } from '../../src/spaces/invitations.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb, withAdminAuth } from '../support/test-db.ts';

let server: Server | null = null;
let pg: TestDb | null = null;

async function boot(): Promise<{ baseUrl: string }> {
  const created = await createV2Server();
  server = created.server;
  await new Promise<void>((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  const address = created.server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  if (pg) await closeTestDb(pg).catch(() => undefined);
  pg = null;
  await closeDb().catch(() => undefined);
  delete process.env.BOB_V2_HOST;
});

describe('GET /api/invitations/:token guard exemption (issue correction)', () => {
  it('answers the thin preview with NO Authorization header, while accept still 401s', async () => {
    process.env.BOB_V2_HOST = '127.0.0.1';
    pg = await createTestDb();
    // previewInvitation's definer reads auth.users.raw_user_meta_data for
    // inviter_display_name; real Supabase has the column.
    const db = asDb(pg);
    setSharedDb(Promise.resolve(db));

    const ownerId = randomUUID();
    await addAccount(pg, { id: ownerId });
    await withAdminAuth(pg, (admin) => admin.setProfile(ownerId, { email: 'owner@example.com' }));
    const space = await createSpace(db, ownerId, { kind: 'group', name: 'Guarded Preview' });
    const { token } = await createInvitation(db, ownerId, space.id, {
      email: 'guest@example.com',
      role: 'member',
    });

    const { baseUrl } = await boot();

    // No Authorization header at all -- exactly the request an invite link in
    // an email produces.
    const preview = await fetch(`${baseUrl}/api/invitations/${token}`);
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as { preview: Record<string, unknown> };
    expect(body.preview).toEqual({
      space_name: 'Guarded Preview',
      space_kind: 'group',
      inviter_display_name: 'owner@example.com',
      exposes_history: true,
      role: 'member',
      expires_at: expect.any(Number),
    });
    // The response shape is a security boundary (it is the one route an
    // unauthenticated caller can reach): no member list, no email addresses,
    // no space content beyond these six fields.
    expect(Object.keys(body.preview).sort()).toEqual(
      ['expires_at', 'exposes_history', 'inviter_display_name', 'role', 'space_kind', 'space_name'].sort(),
    );

    // Accepting binds the invitation to a real account and must stay
    // authenticated -- the guard exemption is scoped to GET only.
    const accept = await fetch(`${baseUrl}/api/invitations/${token}/accept`, { method: 'POST' });
    expect(accept.status).toBe(401);
    const acceptBody = (await accept.json()) as { error: { code: string } };
    expect(acceptBody.error.code).toBe('missing_token');
  });
});
