/**
 * Net error handler for the /api routers (issue #152): anything a route does
 * not map itself becomes a 500 with the documented wire body and a GENERIC
 * message -- no driver text, no SQL, no table or constraint names, no stack.
 * The per-router mapping (StoreError / StoreNotFoundError / StoreConflictError
 * and the role-refusal branches) is the first net and is preserved; this
 * middleware is mounted AFTER all /api routes and only ever runs for an error
 * that escaped a route.
 *
 * Principle II applies to responses as well as logs: the caller learns that an
 * internal error occurred, never why or where. The real error goes to the
 * journal as metadata only -- an event name, the HTTP method as the operation,
 * and the error name -- never the message, never SQL, never the request URL.
 */
import type { ErrorRequestHandler } from 'express';
import { moduleJournal } from '../logger.ts';

const journal = moduleJournal('platform');

/** The one place a wildcard /api error lands: a generic 500. */
export const webErrorHandler: ErrorRequestHandler = (error, request, response, next) => {
  if (response.headersSent) {
    // The response already started; sending a JSON error now would corrupt it
    // (ERR_HTTP_HEADERS_SENT). Let Express's terminal handling close the wire.
    next(error);
    return;
  }
  const name = error instanceof Error ? error.name : 'UnknownError';
  // Operation = the HTTP verb, a bounded label; the request path/URL is a URL
  // and is deliberately not journalled. No message, no stack, no identifiers.
  journal('v2.web_error', { error: name, operation: request.method });
  response.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
};