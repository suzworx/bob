import { consentedGoogleCapabilities } from './google-capabilities.ts';
import type { Db } from '../platform/db/db.ts';
import { StoreNotFoundError } from '../platform/db/db.ts';
import type { GoogleBridge } from './google-bridge.ts';
import { createGoogleConsentAttempt, consumeGoogleConsentAttempt } from './google-consent-store.ts';
import { GoogleCredentialError, type GoogleCapability, type GoogleCredentialResolver } from './google-credentials.ts';
import { getGoogleAccount, persistVerifiedGoogleConnection } from './google-store.ts';
import { verifyGoogleGrant } from './google-grant.ts';
import { createGoogleNativeService } from './google-native-service.ts';

interface ConnectionOptions {
  db: Db;
  bridge: GoogleBridge;
  clientId: string;
  callbackUrls: string[];
  nativeCallbackUrl?: string;
  verify?: typeof verifyGoogleGrant;
}

export class GoogleConsentOriginError extends Error {
  constructor() { super('google_consent_origin_invalid'); this.name = 'GoogleConsentOriginError'; }
}

function trustedCallbacks(values: string[]): Map<string, string> {
  if (values.length < 1 || values.length > 10) throw new GoogleCredentialError('unavailable');
  const callbacks = new Map<string, string>();
  for (const value of values) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password || callbacks.has(url.origin)) {
      throw new GoogleCredentialError('unavailable');
    }
    callbacks.set(url.origin, url.href);
  }
  return callbacks;
}

/** All provider selectors are derived from owner-scoped persistent records. */
export function createGoogleConnectionService(options: ConnectionOptions): {
  native?: ReturnType<typeof createGoogleNativeService>;
  authorize: (owner: string, capabilities: GoogleCapability[], reconnectAccountId?: string, origin?: string) => Promise<{ url: string; expiresAt: number }>;
  complete: (owner: string, state: string) => ReturnType<typeof persistVerifiedGoogleConnection>;
  revoke: (owner: string, accountId: string) => Promise<void>;
  capabilities: (owner: string, accountId: string, signal?: AbortSignal) => Promise<GoogleCapability[]>;
  resolve: GoogleCredentialResolver;
} {
  const verify = options.verify ?? verifyGoogleGrant;
  const callbacks = trustedCallbacks(options.callbackUrls);
  return {
    ...(options.nativeCallbackUrl ? { native: createGoogleNativeService({ ...options, callbackUrl: options.nativeCallbackUrl }) } : {}),
    async capabilities(owner, accountId, signal) {
      const account = await getGoogleAccount(options.db, owner, accountId);
      if (!account?.connectSubject || !account.authorizationCapabilities?.length) throw new GoogleCredentialError('reconnect_required');
      const token = await options.bridge.token(account.connectSubject, account.authorizationCapabilities, signal);
      const grant = await verify(token.token, { expectedClientId: options.clientId,
        expectedProviderAccountId: account.accountId, signal });
      const current = await getGoogleAccount(options.db, owner, accountId);
      if (!current || current.connectSubject !== account.connectSubject || current.accountId !== account.accountId
        || JSON.stringify(current.authorizationCapabilities) !== JSON.stringify(account.authorizationCapabilities)) {
        throw new GoogleCredentialError('reconnect_required');
      }
      return consentedGoogleCapabilities(grant.capabilities, account.authorizationCapabilities);
    },
    async authorize(owner, capabilities, reconnectAccountId, origin) {
      const callback = origin === undefined ? undefined : callbacks.get(origin);
      if (!callback) throw new GoogleConsentOriginError();
      const attempt = await createGoogleConsentAttempt(options.db, owner, { capabilities, reconnectAccountId });
      const returnUrl = new URL(callback);
      returnUrl.searchParams.set('state', attempt.state);
      const authorization = await options.bridge.authorize(attempt.subject, attempt.capabilities, returnUrl.href);
      return { url: authorization.url, expiresAt: attempt.expiresAt };
    },
    async complete(owner, state) {
      const attempt = await consumeGoogleConsentAttempt(options.db, owner, state);
      if (!attempt) throw new GoogleCredentialError('reconnect_required');
      const existing = attempt.reconnectAccountId ? await getGoogleAccount(options.db, owner, attempt.reconnectAccountId) : null;
      if (attempt.reconnectAccountId && (!existing || existing.connectSubject !== attempt.subject)) {
        throw new GoogleCredentialError('reconnect_required');
      }
      const token = await options.bridge.token(attempt.subject, attempt.capabilities);
      const grant = await verify(token.token, { expectedClientId: options.clientId, expectedProviderAccountId: existing?.accountId });
      // Partial consent still links the account; actual grants gate each operation.
      return persistVerifiedGoogleConnection(options.db, owner, {
        subject: attempt.subject, providerAccountId: grant.providerAccountId,
        email: grant.email, name: grant.name ?? null, reconnectAccountId: attempt.reconnectAccountId,
        completionHash: attempt.completionHash,
      });
    },
    async revoke(owner, accountId) {
      const account = await getGoogleAccount(options.db, owner, accountId);
      if (!account) throw new StoreNotFoundError('google_account_not_found');
      if (!account.connectSubject) throw new GoogleCredentialError('reconnect_required');
      await options.bridge.revoke(account.connectSubject);
    },
    async resolve(input) {
      const account = await getGoogleAccount(options.db, input.userId, input.accountId);
      if (!account?.connectSubject || !account.authorizationCapabilities?.length || account.accountId !== input.providerAccountId
        || account.installationId !== input.installationId || account.connectSubject !== input.connectSubject) throw new GoogleCredentialError('reconnect_required');
      const token = await options.bridge.token(account.connectSubject, account.authorizationCapabilities, input.signal);
      const grant = await verify(token.token, { expectedClientId: options.clientId,
        expectedProviderAccountId: account.accountId, signal: input.signal });
      if (!consentedGoogleCapabilities(grant.capabilities, account.authorizationCapabilities).includes(input.capability)) throw new GoogleCredentialError('permission_required');
      const current = await getGoogleAccount(options.db, input.userId, input.accountId);
      if (!current || current.connectSubject !== account.connectSubject
        || JSON.stringify(current.authorizationCapabilities) !== JSON.stringify(account.authorizationCapabilities)) {
        throw new GoogleCredentialError('reconnect_required');
      }
      return token.token;
    },
  };
}
