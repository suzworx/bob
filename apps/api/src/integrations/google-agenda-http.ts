import type { Request, Response } from 'express';
import type { GoogleAgendaProjector } from './google-agenda-service.ts';
import type { GoogleAgendaProjection } from './google-agenda-schemas.ts';

/** Keep native agenda available when the provider cannot be read. */
export async function projectGoogleAgendaForRequest(
  project: GoogleAgendaProjector, userId: string, window: { from: number; to: number }, request: Request, response: Response,
): Promise<GoogleAgendaProjection & { remote_unavailable?: true }> {
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  const close = (): void => { if (!response.writableEnded) abort(); };
  request.on('aborted', abort);
  response.on('close', close);
  try {
    if (request.aborted || response.destroyed) abort();
    controller.signal.throwIfAborted();
    return await project(userId, window, controller.signal);
  } catch {
    return { remote_items: [], sources: [], remote_unavailable: true };
  } finally {
    request.off('aborted', abort);
    response.off('close', close);
  }
}
