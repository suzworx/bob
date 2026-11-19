import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { WebSocketExpress } from 'websocket-express';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { apiModules } from '../../src/api-modules.ts';
import { createAppDeps } from '../../src/app-deps.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, isWebSessionActive } from '../../src/platform/http/auth-guard.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let server: Server;
let origin: string;

beforeAll(async () => {
  pg = await createTestDb();
  const getDb = async () => asDb(pg);
  const app = new WebSocketExpress();
  app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer }), [],
    (account) => isWebSessionActive(getDb, account)));
  // Exercise production registration: adding the review router must reach this test.
  const module = apiModules.find((entry) => entry.name === 'bob-apps');
  if (!module?.mount) throw new Error('Missing production bob-apps module');
  module.mount(app, { ...createAppDeps(), getDb });
  server = app.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  origin = `http://127.0.0.1:${address.port}/api/bob-apps/marketing`;
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pg) await closeTestDb(pg);
});

async function request(path: string, bearer: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function provision() {
  const db = asDb(pg);
  const owner = await addAccount(pg);
  const admin = await addAccount(pg);
  const member = await addAccount(pg);
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Review team' });
  await addMember(db, owner.userId, space.id, admin.userId, 'admin');
  await addMember(db, owner.userId, space.id, member.userId, 'member');
  const ownerToken = await signToken(owner);
  const adminToken = await signToken(admin);
  const memberToken = await signToken(member);
  const installed = await request('/install', ownerToken, 'POST', {
    packageId: 'bob-marketing', spaceId: space.id, mutationId: randomUUID(),
  });
  expect(installed.status).toBe(201);
  const { installation } = await installed.json() as { installation: { id: string; revision: number } };
  const prefix = `/installations/${installation.id}`;
  const activated = await request(`${prefix}/lifecycle`, ownerToken, 'POST', {
    operation: 'activate', expectedRevision: installation.revision, mutationId: randomUUID(),
  });
  expect(activated.status).toBe(200);
  const created = await request(`${prefix}/campaigns`, memberToken, 'POST', {
    name: 'A brighter week', goal: 'beta_interest', channels: ['linkedin'], mutationId: randomUUID(),
  });
  expect(created.status).toBe(201);
  const { receipt } = await created.json() as { receipt: { campaignId: string } };
  const saved = await request(`${prefix}/drafts`, memberToken, 'POST', {
    campaignId: receipt.campaignId, channel: 'linkedin', format: 'text', body: 'A little joy for your day.',
    cta: 'waitlist', approvedAssetIds: [], claimIds: ['mission.lightens-moods'], mutationId: randomUUID(),
  });
  expect(saved.status).toBe(201);
  const draft = await saved.json() as { receipt: { draftId: string } };
  return { owner, ownerToken, adminToken, memberToken, prefix, installationId: installation.id,
    campaignId: receipt.campaignId, draftId: draft.receipt.draftId,
    path: `${prefix}/campaigns/${receipt.campaignId}/review` };
}

it('returns one complete saved review snapshot to an admin', async () => {
  const team = await provision();
  const response = await request(team.path, team.adminToken);
  expect(response.status).toBe(200);
  const { review } = await response.json();
  expect(review).toMatchObject({ installationId: team.installationId, campaignId: team.campaignId,
    state: 'needs_review', canApprove: true, reviewRevision: expect.any(Number), snapshotHash: expect.any(String),
    snapshot: { campaign: { id: team.campaignId, name: 'A brighter week' },
      drafts: [expect.objectContaining({ id: team.draftId, body: 'A little joy for your day.', state: 'needs_check' })] } });
  expect(review).not.toHaveProperty('sessionId');
});

it('lets a member review the same shared work without approval authority', async () => {
  const team = await provision();
  const response = await request(team.path, team.memberToken);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ review: { canApprove: false, state: 'needs_review' } });
});

it('rejects member approval before treating a client target as authority', async () => {
  const team = await provision();
  const response = await request(`${team.path}/approve`, team.memberToken, 'POST', {
    expectedReviewRevision: 1, snapshotHash: '0'.repeat(64), mutationId: randomUUID(),
  });
  expect(response.status).toBe(403);
});

it('rejects an admin stale target with a conflict rather than approving unseen work', async () => {
  const team = await provision();
  const response = await request(`${team.path}/approve`, team.adminToken, 'POST', {
    expectedReviewRevision: 1, snapshotHash: '0'.repeat(64), mutationId: randomUUID(),
  });
  expect(response.status).toBe(409);
});

it('records explicit admin editorial approval while leaving post readiness unchanged', async () => {
  const team = await provision();
  const displayed = await request(team.path, team.adminToken);
  expect(displayed.status).toBe(200);
  const { review } = await displayed.json();
  const approved = await request(`${team.path}/approve`, team.adminToken, 'POST', {
    expectedReviewRevision: review.reviewRevision, snapshotHash: review.snapshotHash, mutationId: randomUUID(),
  });
  expect(approved.status).toBe(200);
  expect(await approved.json()).toMatchObject({ receipt: expect.any(Object), review: { state: 'approved' } });
  const saved = await request(`${team.prefix}/drafts/${team.draftId}`, team.memberToken);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ draft: { state: 'needs_check', contentRevision: 1 } });
});

it('takes session identity from the verified request and refuses a nonexistent session', async () => {
  const team = await provision();
  const stale = await signToken({ userId: team.owner.userId, sessionId: randomUUID() });
  expect((await request(`${team.path}/approve`, stale, 'POST', {
    expectedReviewRevision: 1, snapshotHash: '0'.repeat(64), mutationId: randomUUID(),
  })).status).toBe(401);
});
