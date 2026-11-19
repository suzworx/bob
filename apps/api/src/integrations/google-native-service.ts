import type { z } from 'zod';
import type { Db } from '../platform/db/db.ts';
import type { GoogleBridge } from './google-bridge.ts';
import { getGoogleAccount } from './google-store.ts';
import { verifyGoogleGrant } from './google-grant.ts';
import { GoogleNativeAuthorizeSchema, GoogleNativeAuthorizationSchema, type GoogleNativeProof } from './google-native-schemas.ts';
import { abandonGoogleNativeAttempt, cancelGoogleNativeAttempt, claimGoogleNativeAttempt, createGoogleNativeAttempt,
  finishGoogleNativeAttempt, GoogleNativeUnavailable, type GoogleNativeResult } from './google-native-store.ts';

interface Options { db: Db; bridge: GoogleBridge; clientId: string; callbackUrl: string; verify?: typeof verifyGoogleGrant }

async function boundedGrant(work: (signal: AbortSignal) => ReturnType<typeof verifyGoogleGrant>): ReturnType<typeof verifyGoogleGrant> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve,reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('google_authorization_timeout')); },30_000);
  });
  try { return await Promise.race([work(controller.signal),deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}

export function createGoogleNativeService(options: Options): {
  authorize: (owner: string, sessionId: string, input: z.infer<typeof GoogleNativeAuthorizeSchema>) => Promise<z.infer<typeof GoogleNativeAuthorizationSchema>>;
  complete: (owner: string, sessionId: string, proof: GoogleNativeProof) => Promise<GoogleNativeResult>;
  cancel: (owner: string, sessionId: string, proof: GoogleNativeProof) => Promise<GoogleNativeResult>;
} {
  const callback = new URL(options.callbackUrl);
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash
    || callback.pathname !== '/api/google-accounts/native/return') throw new Error('google_native_callback_invalid');
  const verify = options.verify ?? verifyGoogleGrant;
  return {
    async authorize(owner,sessionId,input) {
      const attempt = await createGoogleNativeAttempt(options.db,owner,sessionId,input);
      const url = new URL(callback); url.searchParams.set('state',attempt.state);
      try {
        const authorization = await options.bridge.authorize(attempt.connect_subject,attempt.capabilities,url.href);
        return GoogleNativeAuthorizationSchema.parse({ attemptId: attempt.id, state: attempt.state,
          url: authorization.url, expiresAt: new Date(attempt.expires_at).getTime() });
      } catch (error) {
        await abandonGoogleNativeAttempt(options.db,owner,sessionId,attempt.id);
        throw error;
      }
    },
    async complete(owner,sessionId,proof) {
      const claim = await claimGoogleNativeAttempt(options.db,owner,sessionId,proof);
      if ('result' in claim) return claim.result;
      const attempt = claim.claimed;
      try {
        const grant = await boundedGrant(async (signal) => {
          const existing = attempt.reconnect_account_id ? await getGoogleAccount(options.db,owner,attempt.reconnect_account_id) : null;
          if (attempt.reconnect_account_id && (!existing || existing.connectSubject !== attempt.connect_subject)) throw new GoogleNativeUnavailable();
          const token = await options.bridge.token(attempt.connect_subject,attempt.capabilities,signal);
          return verify(token.token,{ expectedClientId: options.clientId, expectedProviderAccountId: existing?.accountId, signal });
        });
        return await finishGoogleNativeAttempt(options.db,owner,sessionId,proof,grant);
      } catch (error) {
        if (error instanceof GoogleNativeUnavailable) throw error;
        return finishGoogleNativeAttempt(options.db,owner,sessionId,proof,null);
      }
    },
    cancel: (owner,sessionId,proof) => cancelGoogleNativeAttempt(options.db,owner,sessionId,proof),
  };
}
