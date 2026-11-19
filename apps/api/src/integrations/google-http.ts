import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import { createGmailClient, type GmailClient } from './google-connect.ts';
import { GoogleConsentOriginError, type createGoogleConnectionService } from './google-connection-service.ts';
import { GoogleCredentialError, resolveGoogleCredential } from './google-credentials.ts';
import { notifySecurityEvent } from '../notifications/notify.ts';
import { recipientEmail, sendTemplateEmail } from '../notifications/email-client.ts';
import { moduleJournal } from '../platform/logger.ts';
import { StoreError, type Db } from '../platform/db/db.ts';
import {
  deleteGoogleAccount,
  getGoogleAccount,
  getSelectedGoogleAccount,
  listGoogleAccounts,
  selectGoogleAccount,
  renameGoogleAccount,
} from './google-store.ts';
import {
  GoogleAccountCreateSchema,
  GoogleAccountIdSchema,
  GoogleAccountUpdateSchema,
  GoogleAccountResponseSchema,
  GoogleAccountsResponseSchema,
  GoogleAuthorizeRequestSchema,
  GoogleAuthorizeResponseSchema,
  GoogleSmokeQuerySchema,
  GoogleSmokeResponseSchema,
} from '../web-schemas.ts';

const journal = moduleJournal('integrations');

interface GoogleAccountsRouterDeps {
  getDb: () => Promise<Db>;
  connection?: ReturnType<typeof createGoogleConnectionService>;
  gmail?: GmailClient;
}

function userId(request: Request): string | null {
  return request.account?.userId ?? null;
}

function invalid(response: Response): void {
  response.status(400).json({ error: { code: 'invalid_request' } });
}

function storeError(error: unknown, response: Response): boolean {
  if (error instanceof StoreError) {
    response.status(500).json({ error: { code: 'store_error' } });
    return true;
  }
  return false;
}

type PublicGoogleAccount = z.infer<typeof GoogleAccountResponseSchema>['account'];
type StoredGoogleAccount = {
  id: string; email: string; name: string | null; selected: boolean; createdAt: number;
  customName?: string | null;
  connectSubject: string | null; authorizationCapabilities: Array<'calendar.read' | 'calendar.write' | 'gmail.read' | 'gmail.draft' | 'gmail.send' | 'gmail.modify'> | null;
};

/** The browser shape of one account; never carries the subject or tokens. */
export function publicGoogleAccount(account: StoredGoogleAccount): PublicGoogleAccount {
  const access = account.authorizationCapabilities ?? [];
  return {
    id: account.id, email: account.email, name: account.name, selected: account.selected, createdAt: account.createdAt,
    customName: account.customName ?? null,
    access, needsReconnect: !account.connectSubject || access.length === 0,
  };
}

/** Mails the owner that googleEmail was unlinked. The row is already deleted,
 *  so the email.notification outbox handler cannot name the address; this is
 *  the only send. Best-effort: never throws. Journals a code and count only. */
async function sendUnlinkedEmail(db: Db, owner: string, googleEmail: string): Promise<void> {
  try {
    const to = await recipientEmail(db, owner);
    if (!to) { journal('v2.google_unlinked_email', { code: 'no_address', count: 0 }); return; }
    await sendTemplateEmail({ template: 'google-account-unlinked', to, data: { googleEmail } });
    journal('v2.google_unlinked_email', { code: 'sent', count: 1 });
  } catch {
    journal('v2.google_unlinked_email', { code: 'send_failed', count: 0 });
  }
}

function connectionError(error: unknown, response: Response): void {
  if (error instanceof GoogleCredentialError) {
    response.status(error.code === 'unavailable' ? 502 : 403).json({ error: { code: error.code } });
    return;
  }
  if (!storeError(error, response)) response.status(502).json({ error: { code: 'unavailable' } });
}

function unconfigured(response: Response): void {
  response.status(503).json({ error: { code: 'connect_not_configured' } });
}

async function finishUnlink(db: Db, owner: string, id: string, email: string, response: Response): Promise<void> {
  const deleted = await deleteGoogleAccount(db, owner, id);
  if (!deleted) { response.status(404).json({ error: { code: 'not_found' } }); return; }
  await notifySecurityEvent(db, owner, 'google_unlinked', id, 1);
  await sendUnlinkedEmail(db, owner, email);
  response.status(204).end();
}

export function createGoogleAccountsRouter(deps: GoogleAccountsRouterDeps | (() => Promise<Db>)): Router {
  const resolved = typeof deps === 'function' ? { getDb: deps } : deps;
  const connection = resolved.connection;
  const gmail = resolved.gmail ?? createGmailClient();
  const router = Router();
  router.use((_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });

  router.get('/', async (request, response) => {
    const owner = userId(request);
    if (!owner) { response.status(401).json({ error: { code: 'invalid_token' } }); return; }
    try {
      const accounts = await listGoogleAccounts(await resolved.getDb(), owner);
      response.json(GoogleAccountsResponseSchema.parse({ accounts: accounts.map(publicGoogleAccount) }));
    } catch (error) {
      if (!storeError(error, response)) throw error;
    }
  });

  router.post('/authorize', async (request, response) => {
    const owner = userId(request);
    const parsed = GoogleAuthorizeRequestSchema.safeParse(request.body);
    if (!owner) { response.status(401).json({ error: { code: 'invalid_token' } }); return; }
    if (!parsed.success) { invalid(response); return; }
    if (!connection) { unconfigured(response); return; }
    try {
      const authorization = await connection.authorize(owner, parsed.data.capabilities, parsed.data.reconnectAccountId, request.get('Origin'));
      response.json(GoogleAuthorizeResponseSchema.parse(authorization));
    } catch (error) {
      if (error instanceof GoogleConsentOriginError) { invalid(response); return; }
      connectionError(error, response);
    }
  });

  router.post('/callback', async (request, response) => {
    const owner = userId(request);
    const parsed = GoogleAccountCreateSchema.safeParse(request.body);
    if (!owner) { response.status(401).json({ error: { code: 'invalid_token' } }); return; }
    if (!parsed.success) { invalid(response); return; }
    if (!connection) { unconfigured(response); return; }
    try {
      const account = await connection.complete(owner, parsed.data.state);
      await notifySecurityEvent(await resolved.getDb(), owner, 'google_linked', account.id, 1);
      response.status(201).json(GoogleAccountResponseSchema.parse({ account: publicGoogleAccount(account) }));
    } catch (error) { connectionError(error, response); }
  });

  router.patch('/:id', async (request, response) => {
    const owner = userId(request);
    if (!owner) { response.status(401).json({ error: { code: 'invalid_token' } }); return; }
    const id = GoogleAccountIdSchema.safeParse(request.params.id);
    const parsed = GoogleAccountUpdateSchema.safeParse(request.body);
    if (!id.success || !parsed.success) { invalid(response); return; }
    const account = await renameGoogleAccount(await resolved.getDb(), owner, id.data, parsed.data.customName);
    if (!account) { response.status(404).json({ error: { code: 'not_found' } }); return; }
    response.json(GoogleAccountResponseSchema.parse({ account: publicGoogleAccount(account) }));
  });

  router.post('/:id/select', async (request, response) => {
    const owner = userId(request);
    if (!owner) { response.status(401).json({ error: { code: 'invalid_token' } }); return; }
    const id = GoogleAccountIdSchema.safeParse(request.params.id);
    if (!id.success) { invalid(response); return; }
    const account = await selectGoogleAccount(await resolved.getDb(), owner, id.data);
    if (!account) { response.status(404).json({ error: { code: 'not_found' } }); return; }
    response.json(GoogleAccountResponseSchema.parse({ account: publicGoogleAccount(account) }));
  });

  router.get('/smoke', async (request, response) => {
    const owner = userId(request);
    const parsed = GoogleSmokeQuerySchema.safeParse(request.query);
    if (!owner) { response.status(401).json({ error: { code: 'invalid_token' } }); return; }
    if (!parsed.success) { invalid(response); return; }
    const account = await getSelectedGoogleAccount(await resolved.getDb(), owner);
    if (!account) { response.status(404).json({ error: { code: 'not_found' } }); return; }
    if (!connection) { unconfigured(response); return; }
    try {
      const token = await resolveGoogleCredential(await resolved.getDb(), connection.resolve, owner, account.id, 'gmail.read');
      const result = await gmail.smoke(token, parsed.data.limit);
      response.json(GoogleSmokeResponseSchema.parse({ account: publicGoogleAccount(account), mailbox: { email: result.email }, messages: result.messages }));
    } catch (error) { connectionError(error, response); }
  });

  router.delete('/:id', async (request, response) => {
    const owner = userId(request);
    if (!owner) { response.status(401).json({ error: { code: 'invalid_token' } }); return; }
    const id = GoogleAccountIdSchema.safeParse(request.params.id);
    if (!id.success) { invalid(response); return; }
    const existing = await getGoogleAccount(await resolved.getDb(), owner, id.data);
    if (!existing) {
      response.status(404).json({ error: { code: 'not_found' } }); return;
    }
    if (!connection) { unconfigured(response); return; }
    try { await connection.revoke(owner, id.data); } catch (error) { connectionError(error, response); return; }
    await finishUnlink(await resolved.getDb(), owner, id.data, existing.email, response);
  });

  return router;
}
