import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { StoreNotFoundError, StoreError } from '../platform/db/db.ts';
import { route, sendError } from '../platform/http/route.ts';
import { GoogleCredentialError } from './google-credentials.ts';
import type { createGoogleAgendaService } from './google-agenda-service.ts';
import { GoogleCalendarSelectionInputSchema, GoogleCalendarSelectionsResponseSchema, GoogleCalendarListResponseSchema } from './google-agenda-schemas.ts';

const params = z.object({ accountId: z.string().uuid() }).strict();
const query = z.object({ pageToken: z.string().min(1).max(4096).optional() }).strict();
function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreNotFoundError) { sendError(response, 404, 'google_account_not_found'); return; }
  if (error instanceof GoogleCredentialError) { sendError(response, error.code === 'unavailable' ? 503 : 403, error.code); return; }
  const invalid = new Set(['google_selection_invalid', 'google_selection_limit', 'google_calendar_selection_unavailable']);
  if (error instanceof StoreError && invalid.has(error.message)) { sendError(response, 400, error.message); return; }
  sendError(response, 503, 'google_calendar_unavailable');
}
async function cancellable<T>(request: Request, response: Response, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  const close = (): void => { if (!response.writableEnded) abort(); };
  request.on('aborted', abort);
  response.on('close', close);
  try { return await action(controller.signal); }
  finally { request.off('aborted', abort); response.off('close', close); }
}

/** Mount beneath /api/google-accounts, behind the existing authenticated API guard. */
export function createGoogleCalendarRouter(deps: { service: ReturnType<typeof createGoogleAgendaService> }): Router {
  const router = Router();
  router.get('/:accountId/calendars', route({ params, query, mapError }, async ({ userId, params, query }, request, response) => {
    const result = await cancellable(request, response, (signal) => deps.service.listCalendars(userId, params.accountId, query, signal));
    response.set('Cache-Control', 'no-store').json(GoogleCalendarListResponseSchema.parse(result));
  }));
  router.put('/:accountId/calendars/selection', route({ params, body: GoogleCalendarSelectionInputSchema, mapError }, async ({ userId, params, body }, request, response) => {
    const result = await cancellable(request, response, (signal) => deps.service.selectCalendars(userId, params.accountId, body, signal));
    response.set('Cache-Control', 'no-store').json(GoogleCalendarSelectionsResponseSchema.parse(result));
  }));
  return router;
}
