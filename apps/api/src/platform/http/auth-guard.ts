/**
 * The JWT guard middleware every /api/* route runs behind, and the typed verification failure the verifiers throw.
 * Code motion from account/auth.ts (issue #625): the guard is shared infrastructure, the verifiers
 * (Supabase JWKS, the loopback test issuer) and the sign-in routes stay in the Identity module.
 */
import type { NextFunction, Request, Response } from 'express';
import { withCorrelation } from '@bob/ai';
import { moduleJournal } from '../logger.ts';
import { requestCorrelation, stampActiveConversation } from '../observability/conversation-correlation.ts';
import { asServer, type Db } from '../db/db.ts';

const journal = moduleJournal('platform');

/** The verified identity the JWT guard attaches to the request (web-auth.md
 *  "Verification"): account uuid, session uuid, and token expiry. */
export interface AccountContext {
  userId: string;
  sessionId: string;
  exp: number;
}

/** Why a bearer token was refused. `missing_token` is a guard-level state and
 *  is never produced by a verifier. */
type AuthRejectionReason = 'invalid_token' | 'expired_token';

/** Verifies a bearer JWT locally and returns the account it authenticates.
 *  Throws TokenVerificationError on any failure. */
export type TokenVerifier = (token: string) => Promise<AccountContext>;

/** Typed verification failure carrying the wire reason; jose errors are
 *  mapped here so the guard never inspects library error objects. */
export class TokenVerificationError extends Error {
  readonly reason: AuthRejectionReason;

  constructor(reason: AuthRejectionReason) {
    super(`token verification failed: ${reason}`);
    this.name = 'TokenVerificationError';
    this.reason = reason;
  }
}

declare global {
  namespace Express {
    interface Request {
      /** Set by createJwtWebAuthGuard when the bearer token verified. */
      account?: AccountContext;
    }
  }
}

const UNAUTHORIZED_MESSAGE = 'A valid bearer token is required.';

function reject(response: Response, code: 'missing_token' | 'invalid_token' | 'expired_token'): void {
  response.status(401).json({ error: { code, message: UNAUTHORIZED_MESSAGE } });
}

/**
 * A single guard exemption: a request matching `method` and `pattern` (tested
 * against request.path AS SEEN AT THE GUARD'S MOUNT POINT -- e.g. mounted at
 * /api, "/^\/invitations\/[^/]+\/?$/" matches /api/invitations/<token> but not
 * /api/invitations/<token>/accept) bypasses the JWT guard entirely and reaches
 * its route with no request.account set. Kept generic and passed in at the
 * mount site (server.ts) rather than hardcoded here, so this guard stays a
 * reusable, router-agnostic primitive; the specific route it exempts is
 * server.ts's decision, made where every router is already wired together.
 */
interface GuardExemption {
  method: string;
  pattern: RegExp;
}

/**
 * Express middleware guarding every /api/* route (T010): reads the bearer
 * token from the Authorization header only -- never query, path, or body --
 * verifies it locally and sets req.account on success. Refusals are 401 with
 * the wire codes from contracts/web-auth.md "Responses" and a metadata-only
 * v2.auth_rejected journal line (no token, prefix, claim, or email).
 *
 * `exemptions` (default none) lets the mount site carve out specific
 * unauthenticated routes -- e.g. GET /api/invitations/:token, the
 * account-less invitation preview (contracts/api.md "Unauthenticated-safe
 * preview") an invited person who may have no account at all must be able to
 * reach -- without weakening the guard for every other /api/* route or
 * teaching this generic guard about any one router's paths.
 */
export function createJwtWebAuthGuard(
  verifier: TokenVerifier,
  exemptions: readonly GuardExemption[] = [],
  checkActive?: (account: AccountContext) => Promise<boolean>,
): (request: Request, response: Response, next: NextFunction) => Promise<void> {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (exemptions.some(({ method, pattern }) => method === request.method && pattern.test(request.path))) {
      next();
      return;
    }
    const header = request.get('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!provided) {
      journal('v2.auth_rejected', { surface: 'web', reason: 'missing_token' });
      reject(response, 'missing_token');
      return;
    }
    try {
      request.account = await verifier(provided);
      await verifyAdmission(request.account, checkActive);
    } catch (error) {
      const reason = error instanceof TokenVerificationError ? error.reason : 'invalid_token';
      journal('v2.auth_rejected', { surface: 'web', reason });
      reject(response, reason);
      return;
    }
    // Identity is known now: the request root and everything below it carry the user, client session and the
    // explicit/client conversation. The active-pointer fallback is looked up without waiting and stamped on the root.
    const correlation = requestCorrelation(request);
    if (correlation.userId !== undefined && correlation.conversationId === undefined) stampActiveConversation(correlation.userId);
    withCorrelation(correlation, () => next());
  };
}

/**
 * Stronger check for sensitive routes (web-auth.md "requireActiveSession"):
 * runs after the JWT guard and confirms the session is still active via
 * bob_private.session_active, so a revoked or signed-out session is refused
 * even while its access token is unexpired. Failure is 401 invalid_token.
 */
export function requireActiveSession(
  getDb: () => Promise<Db>,
): (request: Request, response: Response, next: NextFunction) => Promise<void> {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const account = request.account;
    if (!account) {
      reject(response, 'invalid_token');
      return;
    }
    const active = await isWebSessionActive(getDb, account);
    if (!active) {
      reject(response, 'invalid_token');
      return;
    }
    next();
  };
}


/** Fresh bound identity check shared by request admission and stream heartbeats. */
export async function isWebSessionActive(getDb: () => Promise<Db>, account: AccountContext): Promise<boolean> {
  try {
    const rows = await asServer(await getDb(), server => server.query<{ session_active: boolean }>(
      'select bob_private.web_session_active($1::uuid,$2::uuid) as session_active',
      [account.userId, account.sessionId],
    ));
    return rows[0]?.session_active === true;
  } catch {
    return false;
  }
}

async function verifyAdmission(account: AccountContext, check?: (account: AccountContext) => Promise<boolean>): Promise<void> {
  if (check && !await check(account)) throw new TokenVerificationError('invalid_token');
}
