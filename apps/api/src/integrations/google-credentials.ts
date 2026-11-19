import { z } from 'zod';
import { StoreError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { getGoogleAccount } from './google-store.ts';

const capabilitySchema = z.enum(['calendar.read', 'calendar.write', 'gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify']);
export type GoogleCapability = z.infer<typeof capabilitySchema>;
const failureCode = z.enum(['reconnect_required', 'permission_required', 'unavailable']);

/** Only these content-free failures may cross the credential adapter seam. */
export class GoogleCredentialError extends Error {
  readonly code: z.infer<typeof failureCode>;
  constructor(code: z.infer<typeof failureCode>) {
    const safeCode = failureCode.safeParse(code).data ?? 'unavailable';
    super(`google_credentials_${safeCode}`);
    this.name = 'GoogleCredentialError';
    this.code = safeCode;
  }
}

/** Server-only credential boundary. The injected implementation must verify
 * the exact provider identity and actual current grant for this capability,
 * including revocation/expiry. Local account metadata is not grant evidence.
 * There is deliberately no default adapter: the existing metadata-only
 * Connect adapter does not satisfy this contract. Broker/OAuth choice remains
 * a separate deployment decision. Never return this token to a tool or HTTP caller.
 */
export type GoogleCredentialResolver = (input: {
  userId: string;
  accountId: string;
  providerAccountId: string;
  installationId: string;
  connectSubject: string | null;
  capability: GoogleCapability;
  signal?: AbortSignal;
}) => Promise<string>;

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StoreError('google_credentials_cancelled');
}

/** Some credential SDKs cannot cancel their underlying request. Bound the
 * caller's wait anyway, consuming any later resolution/rejection safely. */
async function exchange(resolver: GoogleCredentialResolver, input: Parameters<GoogleCredentialResolver>[0]): Promise<string> {
  const { signal } = input;
  if (!signal) return resolver(input);
  checkAbort(signal);
  let rejectCancelled: (reason: Error) => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
  const onAbort = (): void => { rejectCancelled(new StoreError('google_credentials_cancelled')); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const result = Promise.resolve().then(() => { checkAbort(signal); return resolver(input); });
    return await Promise.race([result, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Resolve an explicit owned account on each call; never select an implicit
 * account or cache tokens. Recheck after the asynchronous credential exchange
 * so disconnect/relink during that exchange cannot authorize a stale account.
 */
export async function resolveGoogleCredential(
  db: Db, resolver: GoogleCredentialResolver, userId: string, accountId: string,
  capability: GoogleCapability, signal?: AbortSignal,
): Promise<string> {
  checkAbort(signal);
  if (!z.string().uuid().safeParse(accountId).success || !capabilitySchema.safeParse(capability).success) {
    throw new StoreError('google_credentials_invalid_input');
  }
  const account = await getGoogleAccount(db, userId, accountId);
  if (!account) throw new StoreNotFoundError('google_account_not_found');
  checkAbort(signal);
  let token: string;
  try {
    token = await exchange(resolver, { userId, accountId, providerAccountId: account.accountId,
      installationId: account.installationId, connectSubject: account.connectSubject, capability, signal });
  } catch (error) {
    checkAbort(signal);
    throw new GoogleCredentialError(error instanceof GoogleCredentialError ? error.code : 'unavailable');
  }
  checkAbort(signal);
  if (typeof token !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token) || token.length > 16384) {
    throw new StoreError('google_credentials_invalid_response');
  }
  const current = await getGoogleAccount(db, userId, accountId);
  if (!current || current.accountId !== account.accountId || current.installationId !== account.installationId
    || current.connectSubject !== account.connectSubject
    || JSON.stringify(current.authorizationCapabilities) !== JSON.stringify(account.authorizationCapabilities)) {
    throw new StoreNotFoundError('google_account_not_found');
  }
  checkAbort(signal);
  return token;
}
