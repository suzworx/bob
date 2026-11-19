import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createMarketingConfigRouter } from '../../src/bob-apps/marketing-config-http.ts';
import { changeMarketingLifecycle, installMarketingPackage } from '../../src/bob-apps/marketing-install.ts';
import { readMarketingConfig } from '../../src/bob-apps/marketing-config-store.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, isWebSessionActive } from '../../src/platform/http/auth-guard.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';
import { withUser } from '../../src/platform/db/db.ts';

let pg: TestDb; let server: Server; let origin: string;
const NARROW = { visibleViews: ['campaign', 'results'], contentGrouping: 'channel', defaultChannels: ['linkedin'] };
const bearer = (account: TestAccount) => signToken({ userId: account.userId, sessionId: account.sessionId });

beforeAll(async () => {
  pg = await createTestDb();
  const app = express(); app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer }), [], (account) => isWebSessionActive(async () => asDb(pg), account)));
  app.use('/api/bob-apps/marketing', createMarketingConfigRouter({ getDb: async () => asDb(pg) }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  origin = `http://127.0.0.1:${address.port}/api/bob-apps/marketing`;
});
afterAll(async () => { server?.close(); if (pg) await closeTestDb(pg); });

async function activeInstallation(owner: TestAccount, activate = true): Promise<string> {
  const draft = await installMarketingPackage(asDb(pg), owner.userId, { packageId: 'bob-marketing', mutationId: randomUUID() }, owner.sessionId);
  if (!activate) return draft.id;
  return (await changeMarketingLifecycle(asDb(pg), owner.userId, draft.id, { operation: 'activate', expectedRevision: draft.revision, mutationId: randomUUID() })).id;
}
async function call(path: string, method: string, token: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

it('serves the detail with current config, pending proposals, versions and unavailable dependencies', async () => {
  const owner = await addAccount(pg);
  const id = await activeInstallation(owner);
  const detail = await call(`/installations/${id}/config`, 'GET', await bearer(owner));
  expect(detail.status).toBe(200);
  expect(detail.json).toMatchObject({ installation: { configRevision: 1, config: { contentGrouping: 'none' } }, pending: [], versions: [] });
  expect(detail.json.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'weekly-metrics', status: 'unavailable' })]));
});

it('paginates retained history with a validated bounded revision cursor', async () => {
  const owner = await addAccount(pg); const id = await activeInstallation(owner);
  await withUser(asDb(pg), owner.userId, async (tx) => {
    await tx.query(`insert into bob.marketing_config_versions(user_id,installation_id,revision,config,package_version)
      select user_id,id,generate_series(1,22),config,package_version from bob.bob_app_installations where id=$1`, [id]);
  });
  const token = await bearer(owner);
  const first = await call(`/installations/${id}/config`, 'GET', token);
  expect(first.json).toMatchObject({ nextBeforeRevision: 3 });
  expect(first.json.versions).toHaveLength(20);
  const next = await call(`/installations/${id}/config?beforeRevision=3`, 'GET', token);
  expect(next.json).toMatchObject({ versions: [{ revision: 2 }, { revision: 1 }], nextBeforeRevision: null });
  expect((await call(`/installations/${id}/config?beforeRevision=invalid`, 'GET', token)).status).toBe(400);
  expect((await call(`/installations/${id}/config?beforeRevision=0`, 'GET', token)).status).toBe(400);
});

it('answers 401 for a stale session and 404 for another owner, without naming the installation', async () => {
  const owner = await addAccount(pg); const stranger = await addAccount(pg);
  const id = await activeInstallation(owner);
  expect((await call(`/installations/${id}/config`, 'GET', await signToken({ userId: owner.userId, sessionId: randomUUID() }))).status).toBe(401);
  expect(await call(`/installations/${id}/config`, 'GET', await bearer(stranger))).toMatchObject({ status: 404, json: { error: { code: 'not_found' } } });
});

it('creates a proposal, applies it with its hash, and replays the exact stored response for the same key', async () => {
  const owner = await addAccount(pg);
  const id = await activeInstallation(owner);
  const mutationId = randomUUID();
  const created = await call(`/installations/${id}/config/proposals`, 'POST', await bearer(owner), { mutationId, expectedConfigRevision: 1, config: NARROW });
  expect(created.status).toBe(201);
  const proposal = (created.json.proposal ?? {}) as { id: string; canonicalHash: string };
  expect(created.json).toMatchObject({ proposal: { requiresApply: true, dataImpact: 'none' } });
  const applied = await call(`/installations/${id}/config/apply`, 'POST', await bearer(owner),
    { mutationId: randomUUID(), proposalId: proposal.id, hash: proposal.canonicalHash, expectedConfigRevision: 1 });
  expect(applied.status).toBe(200);
  expect(applied.json).toMatchObject({ receipt: { kind: 'applied', configRevision: 2 } });
  expect(await call(`/installations/${id}/config/proposals`, 'POST', await bearer(owner), { mutationId, expectedConfigRevision: 1, config: NARROW }))
    .toEqual({ status: 201, json: created.json });
  expect((await readMarketingConfig(asDb(pg), owner.userId, id)).installation.configRevision).toBe(2);
});

it('maps tamper to 400, stale and changed-intent to 409, unavailable extensions to 422 and unknown versions to 404', async () => {
  const owner = await addAccount(pg);
  const id = await activeInstallation(owner);
  const token = await bearer(owner);
  const created = await call(`/installations/${id}/config/proposals`, 'POST', token, { mutationId: randomUUID(), expectedConfigRevision: 1, config: NARROW });
  const proposal = (created.json.proposal ?? {}) as { id: string; canonicalHash: string };
  expect(await call(`/installations/${id}/config/apply`, 'POST', token, { mutationId: randomUUID(), proposalId: proposal.id, hash: 'a'.repeat(64), expectedConfigRevision: 1 }))
    .toMatchObject({ status: 400, json: { error: { code: 'invalid' } } });
  expect(await call(`/installations/${id}/config/apply`, 'POST', token, { mutationId: randomUUID(), proposalId: proposal.id, hash: proposal.canonicalHash, expectedConfigRevision: 9 }))
    .toMatchObject({ status: 409, json: { error: { code: 'conflict' } } });
  expect(await call(`/installations/${id}/config/proposals`, 'POST', token, { mutationId: randomUUID(), expectedConfigRevision: 1, config: { ...NARROW, cadence: 'daily' } }))
    .toMatchObject({ status: 422, json: { error: { code: 'unavailable' } } });
  expect(await call(`/installations/${id}/config/restore`, 'POST', token, { mutationId: randomUUID(), versionRevision: 99, expectedConfigRevision: 1 }))
    .toMatchObject({ status: 404, json: { error: { code: 'not_found' } } });
  expect(await call(`/installations/${id}/config/proposals`, 'POST', token, { mutationId: randomUUID(), expectedConfigRevision: 1, config: NARROW, extra: true }))
    .toMatchObject({ status: 400 });
});

it('refuses writes on an inactive draft with a conflict and still answers the read', async () => {
  const owner = await addAccount(pg);
  const id = await activeInstallation(owner, false);
  const token = await bearer(owner);
  expect(await call(`/installations/${id}/config/proposals`, 'POST', token, { mutationId: randomUUID(), expectedConfigRevision: 1, config: NARROW }))
    .toMatchObject({ status: 409, json: { error: { code: 'conflict' } } });
  expect((await call(`/installations/${id}/config`, 'GET', token)).status).toBe(200);
});
