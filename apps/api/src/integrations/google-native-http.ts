import { Router, type Response } from 'express';
import type { Db } from '../platform/db/db.ts';
import { requireActiveSession } from '../platform/http/auth-guard.ts';
import { route, sendError } from '../platform/http/route.ts';
import { publicGoogleAccount } from './google-http.ts';
import type { createGoogleNativeService } from './google-native-service.ts';
import { GoogleNativeUnavailable, type GoogleNativeResult } from './google-native-store.ts';
import { GoogleNativeAuthorizeSchema, GoogleNativeAuthorizationSchema, GoogleNativeProofSchema,
  GoogleNativeResultSchema, GoogleNativeReturnSchema } from './google-native-schemas.ts';

function errorResponse(error: unknown, response: Response): void {
  sendError(response,error instanceof GoogleNativeUnavailable ? 404 : 502,
    error instanceof GoogleNativeUnavailable ? error.code : 'unavailable');
}
function sendResult(result: GoogleNativeResult, response: Response): void {
  const body = result.status === 'completed' ? { ...result, account: publicGoogleAccount(result.account) } : result;
  response.status(result.status === 'processing' ? 202 : 200).json(GoogleNativeResultSchema.parse(body));
}

export function createGoogleNativeRouter(deps: { getDb: () => Promise<Db>; connection?: ReturnType<typeof createGoogleNativeService> }): Router {
  const router = Router();
  router.use((_request,response,next) => { response.setHeader('Cache-Control','no-store'); next(); });
  router.use(requireActiveSession(deps.getDb));
  router.post('/authorize',route({ body: GoogleNativeAuthorizeSchema },async ({ body,userId },request,response) => {
    if (!deps.connection) { sendError(response,503,'native_return_unavailable'); return; }
    const sessionId = request.account?.sessionId;
    if (!sessionId) { sendError(response,401,'invalid_token'); return; }
    try { response.json(GoogleNativeAuthorizationSchema.parse(await deps.connection.authorize(userId,sessionId,body))); }
    catch (error) { errorResponse(error,response); }
  }));
  for (const action of ['complete','cancel'] as const) {
    router.post(`/${action}`,route({ body: GoogleNativeProofSchema },async ({ body,userId },request,response) => {
      if (!deps.connection) { sendError(response,503,'native_return_unavailable'); return; }
      const sessionId = request.account?.sessionId;
      if (!sessionId) { sendError(response,401,'invalid_token'); return; }
      try { sendResult(await deps.connection[action](userId,sessionId,body),response); }
      catch (error) { errorResponse(error,response); }
    }));
  }
  return router;
}

/** Public navigation only: never consumes state, chooses an account, or exchanges
 * credentials. Authentication and app-held proof are required by completion. */
export function createGoogleNativeReturnRouter(): Router {
  const router = Router();
  router.get('/api/google-accounts/native/return',(request,response) => {
    response.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
    const parsed = GoogleNativeReturnSchema.safeParse(request.query);
    if (!parsed.success) { sendError(response,400,'invalid_request'); return; }
    const target = new URL('app.bob.oauth://google/callback');
    target.searchParams.set('state',parsed.data.state);
    target.searchParams.set('outcome',parsed.data.error === undefined ? 'returned'
      : parsed.data.error === 'access_denied' ? 'cancelled' : 'failed');
    response.status(303).setHeader('Location',target.href).end();
  });
  return router;
}
