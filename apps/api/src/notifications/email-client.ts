/** The API's one way out to email: POSTs a catalog template id, an address and
 *  the template's data to the notify-email Supabase function, which renders and
 *  sends it. Unconfigured (no BOB_NOTIFY_EMAIL_URL / BOB_NOTIFY_EMAIL_SECRET)
 *  every send is a journaled no-op, so local dev and tests never mail anyone.
 *  Journal lines carry the template id and a status code only -- never an
 *  address, a name or any template data. */
import { moduleJournal } from '../platform/logger.ts';
import { asServer, type Db } from '../platform/db/db.ts';
import { traceWorkflow, type SetWorkflowOutcome } from '../platform/observability/workflow-diagnostics.ts';

const journal = moduleJournal('notifications');

const SEND_TIMEOUT_MS = 10_000;
const DEFAULT_APP_URL = 'https://app.heybob.xyz';

/** A send that notify-email refused or that never reached it. code is a short
 *  machine code (`http_<status>`, `timeout`, `network`), never a message. */
export class EmailSendError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`email send failed: ${code}`);
    this.name = 'EmailSendError';
    this.code = code;
  }
}

export function emailConfigured(): boolean {
  return Boolean(process.env.BOB_NOTIFY_EMAIL_URL && process.env.BOB_NOTIFY_EMAIL_SECRET);
}

/** An absolute web-app URL for a ui-v2 path (BOB_APP_URL, trailing slash ignored). */
export function appUrl(path: string): string {
  const base = (process.env.BOB_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Resolves on 2xx; throws EmailSendError otherwise. */
export async function sendTemplateEmail(input: {
  template: string;
  to: string;
  data: Record<string, unknown>;
}): Promise<void> {
  return traceWorkflow('email-send', {}, (outcome) => sendTemplateEmailWork(input, outcome));
}

async function sendTemplateEmailWork(input: {
  template: string; to: string; data: Record<string, unknown>;
}, outcome: SetWorkflowOutcome): Promise<void> {
  const url = process.env.BOB_NOTIFY_EMAIL_URL;
  const secret = process.env.BOB_NOTIFY_EMAIL_SECRET;
  if (!url || !secret) {
    outcome('skipped');
    journal('v2.email_skipped', { template: input.template, reason: 'not_configured' });
    return;
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ template: input.template, to: input.to, data: input.data }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    const code = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      ? 'timeout'
      : 'network';
    return sendFailed(input.template, code);
  }
  // The body is drained so the connection is released; its content is not logged.
  await response.arrayBuffer().catch(() => undefined);
  if (!response.ok) return sendFailed(input.template, `http_${response.status}`);
  journal('v2.email_sent', { template: input.template });
}

/** Journals a failed send and throws EmailSendError from inside its span, so
 *  the span ends at ERROR level (traceSpan never exports the error itself). */
function sendFailed(template: string, code: string): never {
  journal('v2.email_send_failed', { template, code });
  throw new EmailSendError(code);
}

/** The account's identity email, or null when there is none. Reads auth.users
 *  through the bob_private.user_email definer (EXECUTE is granted to the
 *  server role only), so pass the RAW Db, not one inside withUser. */
export async function recipientEmail(db: Db, userId: string): Promise<string | null> {
  const rows = await asServer(db, (server) =>
    server.query<{ email: unknown }>('SELECT bob_private.user_email($1::uuid) AS email', [userId]),
  );
  const email = rows[0]?.email;
  return typeof email === 'string' && email.includes('@') ? email : null;
}
