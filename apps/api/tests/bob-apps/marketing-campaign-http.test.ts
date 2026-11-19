import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createMarketingCampaignRouter } from '../../src/bob-apps/marketing-campaign-http.ts';
import { createMarketingRouter } from '../../src/bob-apps/marketing-http.ts';
import { addMember, createSpace, ensurePrivateSpace, revokeMember } from '../../src/spaces/store.ts';
import { createThread } from '../../src/conversations/thread-store.ts';
import { withUser } from '../../src/platform/db/db.ts';
import { createLocalVerifier } from '../../src/account/auth.ts';
import { createJwtWebAuthGuard, isWebSessionActive } from '../../src/platform/http/auth-guard.ts';
import { signToken, testIssuer, testJwks } from '../support/test-auth.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import {
  CampaignListResponseSchema, CampaignResponseSchema, DraftListResponseSchema, DraftResponseSchema, MarketingOverviewResponseSchema,
  MarketingReceiptResponseSchema,
  CreateCampaignRequestSchema,
} from '../../src/web-schemas.ts';

let pg: TestDb; let server: Server; let origin: string;
interface Owner { bearer: string; installationId: string; appId: string; userId: string }

beforeAll(async () => {
  pg = await createTestDb();
  const app = express(); app.use(express.json());
  app.use(createJwtWebAuthGuard(createLocalVerifier({ jwks: testJwks, issuer: testIssuer }), [], (account) => isWebSessionActive(async () => asDb(pg), account)));
  app.use('/api/bob-apps', createMarketingRouter({ getDb: async () => asDb(pg) }));
  app.use('/api/bob-apps', createMarketingCampaignRouter({ getDb: async () => asDb(pg) }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  origin = `http://127.0.0.1:${address.port}/api/bob-apps`;
});
afterAll(async () => { server?.close(); if (pg) await closeTestDb(pg); });

async function request(path: string, method = 'GET', body?: unknown, bearer?: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method,
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
/** A fresh owner with a live Marketing installation, provisioned through the real U2 install and activate routes. */
async function provision(): Promise<Owner> {
  const account = await addAccount(pg);
  const bearer = await signToken({ userId: account.userId, sessionId: account.sessionId });
  const installed = await request('/marketing/install', 'POST', { packageId: 'bob-marketing', mutationId: randomUUID() }, bearer);
  const { installation } = await installed.json() as { installation: { id: string; appId: string; revision: number } };
  const active = await request(`/marketing/installations/${installation.id}/lifecycle`, 'POST',
    { operation: 'activate', expectedRevision: installation.revision, mutationId: randomUUID() }, bearer);
  expect(active.status).toBe(200);
  return { bearer, installationId: installation.id, appId: installation.appId, userId: account.userId };
}
const campaignBody = { name: 'Spring beta', goal: 'beta_interest', channels: ['instagram', 'linkedin'] };
const base = (owner: Owner) => `/marketing/installations/${owner.installationId}`;

it('validates shared wire contracts and UTF-8 limits without a Node Buffer global', () => {
  vi.stubGlobal('Buffer', undefined);
  try {
    expect(CreateCampaignRequestSchema.safeParse({ ...campaignBody, goalNote: 'Hello', mutationId: randomUUID() }).success).toBe(true);
    expect(CreateCampaignRequestSchema.safeParse({ ...campaignBody, goalNote: '🙂'.repeat(126), mutationId: randomUUID() }).success).toBe(false);
  } finally { vi.unstubAllGlobals(); }
});

it('selects a saved campaign only inside the authenticated owner private conversation', async () => {
  const owner = await provision();
  const stranger = await provision();
  const conversationId = `conv_${randomUUID()}`;
  const space = await ensurePrivateSpace(asDb(pg), owner.userId);
  await withUser(asDb(pg), owner.userId, (tx) => tx.query('insert into bob.conversations(id,user_id,space_id,title) values($1,$2,$3,$4)', [conversationId, owner.userId, space.id, 'Test']));
  const path = `${base(owner)}/conversations/${conversationId}/selection`;
  expect((await request(path, 'GET', undefined, owner.bearer)).status).toBe(200);
  expect(await (await request(path, 'GET', undefined, owner.bearer)).json()).toEqual({ campaign: null });
  const created = MarketingReceiptResponseSchema.parse(await (await request(`${base(owner)}/campaigns`, 'POST', { ...campaignBody, mutationId: randomUUID() }, owner.bearer)).json()).receipt;
  const selection = { campaignId: created.campaignId, mutationId: randomUUID() };
  const selected = await request(path, 'POST', selection, owner.bearer);
  expect(selected.status).toBe(200);
  expect(MarketingReceiptResponseSchema.parse(await selected.json()).receipt).toMatchObject({ kind: 'campaign.select', campaignId: created.campaignId });
  expect(await (await request(path, 'GET', undefined, owner.bearer)).json()).toMatchObject({ campaign: { id: created.campaignId } });
  expect((await request(path, 'GET', undefined, stranger.bearer)).status).toBe(404);
  expect((await request(path, 'POST', { ...selection, userId: stranger.userId }, owner.bearer)).status).toBe(400);
  await withUser(asDb(pg), owner.userId, (tx) => tx.query('update bob.conversations set archived_at=now() where id=$1', [conversationId]));
  expect((await request(path, 'GET', undefined, owner.bearer)).status).toBe(404);
  expect((await request(path, 'POST', selection, owner.bearer)).status).toBe(404);
});

it('reads shared campaign selections per person and denies mismatched audiences', async () => {
  const db = asDb(pg);
  const owner = await addAccount(pg);
  const member = await addAccount(pg);
  const outsider = await addAccount(pg);
  const ownerToken = await signToken({ userId: owner.userId, sessionId: owner.sessionId });
  const memberToken = await signToken({ userId: member.userId, sessionId: member.sessionId });
  const outsiderToken = await signToken({ userId: outsider.userId, sessionId: outsider.sessionId });
  const space = await createSpace(db, owner.userId, { kind: 'group', name: 'Shared Marketing' });
  await addMember(db, owner.userId, space.id, member.userId, 'member');
  const installed = await request('/marketing/install', 'POST', { packageId: 'bob-marketing', spaceId: space.id, mutationId: randomUUID() }, ownerToken);
  expect(installed.status).toBe(201);
  const { installation } = await installed.json() as { installation: { id: string; revision: number } };
  expect((await request(`/marketing/installations/${installation.id}/lifecycle`, 'POST', { operation: 'activate', expectedRevision: installation.revision, mutationId: randomUUID() }, ownerToken)).status).toBe(200);
  const thread = await createThread(db, owner.userId, { spaceId: space.id, title: 'Our posts' });
  const prefix = `/marketing/installations/${installation.id}`;
  const path = `${prefix}/conversations/${thread.id}/selection`;
  const empty = await request(path, 'GET', undefined, memberToken);
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ campaign: null });
  const campaigns: string[] = [];
  for (const bearer of [ownerToken, memberToken]) {
    const response = await request(`${prefix}/campaigns`, 'POST', { ...campaignBody, mutationId: randomUUID() }, bearer);
    expect(response.status).toBe(201);
    const id = MarketingReceiptResponseSchema.parse(await response.json()).receipt.campaignId;
    if (!id) throw new Error('campaign missing');
    campaigns.push(id);
    expect((await request(path, 'POST', { campaignId: id, mutationId: randomUUID() }, bearer)).status).toBe(200);
  }
  expect(await (await request(path, 'GET', undefined, ownerToken)).json()).toMatchObject({ campaign: { id: campaigns[0] } });
  expect(await (await request(path, 'GET', undefined, memberToken)).json()).toMatchObject({ campaign: { id: campaigns[1] } });
  expect((await request(path, 'POST', { campaignId: null, mutationId: randomUUID() }, memberToken)).status).toBe(200);
  expect(await (await request(path, 'GET', undefined, memberToken)).json()).toEqual({ campaign: null });
  expect(await (await request(path, 'GET', undefined, ownerToken)).json()).toMatchObject({ campaign: { id: campaigns[0] } });
  const privateSpace = await ensurePrivateSpace(db, owner.userId);
  const privateConversation = `private_${randomUUID()}`;
  await withUser(db, owner.userId, (tx) => tx.query('insert into bob.conversations(id,user_id,space_id,title) values($1,$2,$3,$4)', [privateConversation, owner.userId, privateSpace.id, 'Personal']));
  const otherSpace = await createSpace(db, owner.userId, { kind: 'group', name: 'Other Marketing' });
  const otherThread = await createThread(db, owner.userId, { spaceId: otherSpace.id, title: 'Other posts' });
  for (const id of [privateConversation, otherThread.id]) expect((await request(`${prefix}/conversations/${id}/selection`, 'GET', undefined, ownerToken)).status).toBe(404);
  expect((await request(path, 'GET', undefined, outsiderToken)).status).toBe(404);
  await revokeMember(db, owner.userId, space.id, member.userId);
  expect((await request(path, 'GET', undefined, memberToken)).status).toBe(404);
});

it('answers 401 without a live session and for a revoked session, on reads and writes alike', async () => {
  const owner = await provision();
  expect((await request(`${base(owner)}/overview`)).status).toBe(401);
  const stale = await signToken({ userId: randomUUID(), sessionId: randomUUID() });
  expect((await request(`${base(owner)}/campaigns`, 'GET', undefined, stale)).status).toBe(401);
  expect((await request(`${base(owner)}/campaigns`, 'POST', { ...campaignBody, mutationId: randomUUID() })).status).toBe(401);
});

it('creates a campaign once per mutation ID, replays the stored receipt and refuses changed intent under the same ID', async () => {
  const owner = await provision();
  const mutationId = randomUUID();
  const first = await request(`${base(owner)}/campaigns`, 'POST', { ...campaignBody, mutationId }, owner.bearer);
  expect(first.status).toBe(201);
  const receipt = MarketingReceiptResponseSchema.parse(await first.json()).receipt;
  expect(receipt).toMatchObject({ kind: 'campaign.create', revision: 1 });
  const replay = await request(`${base(owner)}/campaigns`, 'POST', { ...campaignBody, mutationId }, owner.bearer);
  expect(MarketingReceiptResponseSchema.parse(await replay.json()).receipt).toEqual(receipt);
  const changed = await request(`${base(owner)}/campaigns`, 'POST', { ...campaignBody, name: 'Changed', mutationId }, owner.bearer);
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ error: { code: 'mutation_conflict' } });
  const detail = CampaignResponseSchema.parse(await (await request(`${base(owner)}/campaigns/${receipt.campaignId}`, 'GET', undefined, owner.bearer)).json());
  expect(detail.campaign).toMatchObject({ name: 'Spring beta', revision: 1, channels: ['instagram', 'linkedin'], status: 'draft' });
});

it('answers stale revisions with a conflict and unknown or other-owner campaigns with not found', async () => {
  const owner = await provision();
  const stranger = await provision();
  const created = MarketingReceiptResponseSchema.parse(await (await request(`${base(owner)}/campaigns`, 'POST', { ...campaignBody, mutationId: randomUUID() }, owner.bearer)).json()).receipt;
  const patch = (expectedRevision: number) => request(`${base(owner)}/campaigns/${created.campaignId}`, 'PATCH',
    { name: 'Renamed', expectedRevision, mutationId: randomUUID() }, owner.bearer);
  expect((await patch(1)).status).toBe(200);
  const stale = await patch(1);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: 'revision_conflict' } });
  const crossOwner = await request(`${base(owner)}/campaigns/${created.campaignId}`, 'GET', undefined, stranger.bearer);
  expect(crossOwner.status).toBe(404);
  const crossInstallation = await request(`${base(stranger)}/campaigns/${created.campaignId}`, 'GET', undefined, owner.bearer);
  expect(crossInstallation.status).toBe(404);
  expect((await request(`${base(owner)}/campaigns/${randomUUID()}`, 'GET', undefined, owner.bearer)).status).toBe(404);
});
it('saves a plan section, creates and edits drafts with DTO round trips, and rejects unknown references and Instagram text', async () => {
  const owner = await provision();
  const campaign = MarketingReceiptResponseSchema.parse(await (await request(`${base(owner)}/campaigns`, 'POST', { ...campaignBody, mutationId: randomUUID() }, owner.bearer)).json()).receipt;
  const section = await request(`${base(owner)}/campaigns/${campaign.campaignId}/sections`, 'POST',
    { section: 'brief', content: 'Early beta interest only.', expectedRevision: 1, mutationId: randomUUID() }, owner.bearer);
  expect(section.status).toBe(200);
  expect(MarketingReceiptResponseSchema.parse(await section.json()).receipt).toMatchObject({ kind: 'campaign.section', revision: 2 });
  const draftPath = `${base(owner)}/drafts`;
  const draftBody = { campaignId: campaign.campaignId, channel: 'linkedin', format: 'text', body: 'Hello', cta: 'waitlist', approvedAssetIds: [], claimIds: ['mission.lightens-moods'], mutationId: randomUUID() };
  const created = await request(draftPath, 'POST', draftBody, owner.bearer);
  expect(created.status).toBe(201);
  const draftId = MarketingReceiptResponseSchema.parse(await created.json()).receipt.draftId as string;
  expect((await request(draftPath, 'POST', { ...draftBody, channel: 'instagram', format: 'text', mutationId: randomUUID() }, owner.bearer)).status).toBe(400);
  expect(await (await request(draftPath, 'POST', { ...draftBody, claimIds: ['claim.invented'], mutationId: randomUUID() }, owner.bearer)).json())
    .toMatchObject({ error: { code: 'invalid_reference' } });
  const read = DraftResponseSchema.parse(await (await request(`${draftPath}/${draftId}`, 'GET', undefined, owner.bearer)).json());
  expect(read.draft).toMatchObject({ state: 'needs_check', contentRevision: 1, cta: 'waitlist', body: 'Hello' });
  const stale = await request(`${draftPath}/${draftId}`, 'PATCH', { expectedContentRevision: 9, body: 'Late', mutationId: randomUUID() }, owner.bearer);
  expect(stale.status).toBe(409);
  const edited = await request(`${draftPath}/${draftId}`, 'PATCH', { expectedContentRevision: 1, body: 'Edited', mutationId: randomUUID() }, owner.bearer);
  expect(MarketingReceiptResponseSchema.parse(await edited.json()).receipt).toMatchObject({ kind: 'draft.update', revision: 2 });
  const listed = DraftListResponseSchema.parse(await (await request(`${draftPath}?campaignId=${campaign.campaignId}`, 'GET', undefined, owner.bearer)).json());
  expect(listed.items).toEqual([expect.objectContaining({ id: draftId, state: 'needs_check', contentRevision: 2 })]);
  expect(listed.nextCursor).toBeNull();
});

it('serves bounded lists and an overview with real counts and unavailable analytics, without side effects', async () => {
  const owner = await provision();
  await request(`${base(owner)}/campaigns`, 'POST', { ...campaignBody, mutationId: randomUUID() }, owner.bearer);
  const before = await (await request(`${base(owner)}/overview`, 'GET', undefined, owner.bearer)).json();
  const overview = MarketingOverviewResponseSchema.parse(before).overview;
  expect(overview).toMatchObject({ counts: { campaigns: 1, liveCampaigns: 1, drafts: 0, needsCheck: 0 }, analytics: { status: 'unavailable' } });
  const campaigns = CampaignListResponseSchema.parse(await (await request(`${base(owner)}/campaigns`, 'GET', undefined, owner.bearer)).json());
  expect(campaigns.items).toHaveLength(1);
  const after = await (await request(`${base(owner)}/overview`, 'GET', undefined, owner.bearer)).json();
  expect(after).toEqual(before);
  const unknownQuery = await request(`${base(owner)}/campaigns?owner=${randomUUID()}`, 'GET', undefined, owner.bearer);
  expect(unknownQuery.status).toBe(400);
});

it('keeps reads available for a paused installation while every write answers unavailable', async () => {
  const owner = await provision();
  const campaign = MarketingReceiptResponseSchema.parse(await (await request(`${base(owner)}/campaigns`, 'POST', { ...campaignBody, mutationId: randomUUID() }, owner.bearer)).json()).receipt;
  const installation = await (await request(base(owner), 'GET', undefined, owner.bearer)).json() as { installation: { revision: number } };
  const paused = await request(`${base(owner)}/lifecycle`, 'POST', { operation: 'pause', expectedRevision: installation.installation.revision, mutationId: randomUUID() }, owner.bearer);
  expect(paused.status).toBe(200);
  expect((await request(`${base(owner)}/campaigns/${campaign.campaignId}`, 'GET', undefined, owner.bearer)).status).toBe(200);
  const write = await request(`${base(owner)}/campaigns`, 'POST', { ...campaignBody, mutationId: randomUUID() }, owner.bearer);
  expect(write.status).toBe(503);
  expect(await write.json()).toMatchObject({ error: { code: 'unavailable' } });
});

it('projects bounded full-content pages without changing summaries, ownership or paused reads', async () => {
  const owner = await provision();
  const stranger = await provision();
  const created = MarketingReceiptResponseSchema.parse(await (await request(`${base(owner)}/campaigns`, 'POST', { ...campaignBody, mutationId: randomUUID() }, owner.bearer)).json()).receipt;
  const draftPath = `${base(owner)}/drafts`;
  for (let index = 0; index < 21; index += 1) {
    const saved = await request(draftPath, 'POST', { campaignId: created.campaignId, channel: index === 20 ? 'instagram' : 'linkedin', format: 'image', body: `Saved copy ${index}`, altText: 'Original Bob', pillar: 'Joy', approvedAssetIds: ['bob-playful'], claimIds: [], cta: 'none', mutationId: randomUUID() }, owner.bearer);
    expect(saved.status).toBe(201);
  }
  const fullPath = `${draftPath}?campaignId=${created.campaignId}&projection=content`;
  const first = await request(fullPath, 'GET', undefined, owner.bearer);
  expect(first.status).toBe(200);
  const page = await first.json() as { items: Array<{ id: string; body: string }>; nextCursor: string | null };
  expect(page.items).toHaveLength(20);
  expect(page.items.every((item) => item.body.startsWith('Saved copy '))).toBe(true);
  const rest = await (await request(`${fullPath}&cursor=${page.nextCursor}`, 'GET', undefined, owner.bearer)).json() as typeof page;
  expect(rest.items).toHaveLength(1);
  expect(rest.nextCursor).toBeNull();
  expect(new Set([...page.items, ...rest.items].map((item) => item.id)).size).toBe(21);
  const summary = DraftListResponseSchema.parse(await (await request(`${draftPath}?campaignId=${created.campaignId}`, 'GET', undefined, owner.bearer)).json());
  expect(summary.items).toHaveLength(21);
  expect(summary.items[0]).not.toHaveProperty('body');
  const scoped = await (await request(`${fullPath}&channel=instagram`, 'GET', undefined, owner.bearer)).json() as typeof page;
  expect(scoped.items.map((item) => item.body)).toEqual(['Saved copy 20']);
  expect((await request(fullPath, 'GET', undefined, stranger.bearer)).status).toBe(404);
  expect((await request(`${base(stranger)}/drafts?campaignId=${created.campaignId}&projection=content`, 'GET', undefined, owner.bearer)).status).toBe(404);
  expect((await request(`${draftPath}?projection=content`, 'GET', undefined, owner.bearer)).status).toBe(400);
  expect((await request(`${fullPath}&channel=unknown`, 'GET', undefined, owner.bearer)).status).toBe(400);
  expect((await request(`${draftPath}?projection=unknown`, 'GET', undefined, owner.bearer)).status).toBe(400);
  await request(`${base(owner)}/lifecycle`, 'POST', { operation: 'pause', expectedRevision: 2, mutationId: randomUUID() }, owner.bearer);
  expect((await request(fullPath, 'GET', undefined, owner.bearer)).status).toBe(200);
});

it('shortens full-content pages by serialized bytes and resumes without losing escaped text records', async () => {
  const owner = await provision();
  const created = MarketingReceiptResponseSchema.parse(await (await request(`${base(owner)}/campaigns`, 'POST', { ...campaignBody, mutationId: randomUUID() }, owner.bearer)).json()).receipt;
  const path = `${base(owner)}/drafts`;
  for (let index = 0; index < 8; index += 1) {
    expect((await request(path, 'POST', { campaignId: created.campaignId, channel: 'linkedin', format: 'text', body: '\u0001'.repeat(8000), altText: '\u0001'.repeat(2000), pillar: 'Joy', approvedAssetIds: [], claimIds: [], cta: 'none', mutationId: randomUUID() }, owner.bearer)).status).toBe(201);
  }
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await request(`${path}?campaignId=${created.campaignId}&projection=content${cursor ? `&cursor=${cursor}` : ''}`, 'GET', undefined, owner.bearer);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(256 * 1024);
    const page = JSON.parse(text) as { items: Array<{ id: string; body: string }>; nextCursor: string | null };
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThan(8);
    expect(page.items.every((item) => item.body === '\u0001'.repeat(8000))).toBe(true);
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids).toHaveLength(8);
  expect(new Set(ids).size).toBe(8);
});
