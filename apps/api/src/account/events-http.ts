/**
 * GET /api/events (T029, specs/008-supabase-auth-pairing, contracts/account-events.md):
 * a Server-Sent Events stream over a fetch stream so the bearer JWT rides the
 * Authorization header (R7). It is mounted under the /api JWT guard and the route
 * itself runs requireActiveSession, so a signed-out session cannot hold it open.
 *
 * Framing is the standard SSE block: `event:` / `id:` (a per-stream sequence,
 * diagnostics only — clients never resume from it) / one `data:` line carrying
 * the event's ids-and-metadata-only payload. A `: ping` comment is written every
 * 25 s to keep intermediaries from closing an idle connection, and the stream is
 * closed when the token's `exp` passes. The subscription and timers are torn down
 * on close or error.
 */
import { Router, type Request, type Response } from 'express';
import { requireActiveSession, isWebSessionActive } from '../platform/http/auth-guard.ts';
import type { AccountEvent } from './events-bus.ts';
import type { Db } from '../platform/db/db.ts';

/** Comment-line heartbeat interval (contract: 25 s). */
const EVENT_HEARTBEAT_MS = 25_000;

interface WebEventsDeps {
  getDb: () => Promise<Db>;
  /** The per-account bus the stream subscribes to (getAccountEvents() in prod). */
  events: { subscribe: (userId: string, fn: (event: AccountEvent) => void) => () => void };
  /** Test seam; defaults to the 25 s contract value. */
  heartbeatMs?: number;
}

/** Builds the /api/events router; mount it under /api behind the JWT guard. */
export function createWebEventsRouter(deps: WebEventsDeps): Router {
  const { getDb, events } = deps;
  const heartbeatMs = deps.heartbeatMs ?? EVENT_HEARTBEAT_MS;
  const router = Router();
  router.get('/', requireActiveSession(getDb), (request: Request, response: Response) => {
    const account = request.account;
    if (!account) {
      response.status(401).json({ error: { code: 'invalid_token' } });
      return;
    }
    response.status(200);
    response.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Per-account isolated: this listener only ever sees the authenticated
    // account's events (FR-008), so a stream never carries another account's.
    // Subscribe before flushHeaders so a client that connects on the first
    // flushed byte can never miss an event published immediately after.
    let sequence = 0;
    let closed = false;
    const write = (chunk: string): void => {
      if (closed || response.writableEnded) return;
      response.write(chunk);
    };
    const unsubscribe = events.subscribe(account.userId, (event: AccountEvent) => {
      sequence += 1;
      write(`event: ${event.type}\nid: ${sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    response.flushHeaders();
    // A proxy may hold the response until the first body byte, so the client's
    // "stream open" catch-up would wait for the first event; an SSE comment
    // (ignored by clients) opens the stream through every hop at once.
    write(': open\n\n');

    let checkingSession = false;
    let sessionDeadline: ReturnType<typeof setTimeout> | null = null;
    const heartbeat = setInterval(async () => {
      if (closed || checkingSession) return;
      checkingSession = true;
      sessionDeadline = setTimeout(() => response.end(), 5_000);
      sessionDeadline.unref?.();
      const active = await isWebSessionActive(getDb, account);
      clearTimeout(sessionDeadline);
      sessionDeadline = null;
      checkingSession = false;
      if (closed) return;
      if (!active) {
        response.end();
        return;
      }
      write(': ping\n\n');
    }, heartbeatMs);
    heartbeat.unref?.();

    // Close the stream when the token's exp passes (plan §E); the client is
    // expected to reconnect with a fresh token. A closed stream is normal.
    const expiryMs = Math.max(0, account.exp * 1000 - Date.now());
    const expiryTimer = setTimeout(() => {
      write(': expired\n\n');
      response.end();
    }, expiryMs);
    expiryTimer.unref?.();

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(expiryTimer);
      if (sessionDeadline !== null) clearTimeout(sessionDeadline);
      unsubscribe();
    };
    response.on('close', cleanup);
    response.on('error', cleanup);
    request.on('close', cleanup);
  });
  return router;
}
