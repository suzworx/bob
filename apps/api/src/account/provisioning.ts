/** Makes sure an invited address has an Bob account, so the invitee can sign
 *  in with an emailed code (signups stay off) and accept. The API holds no
 *  service-role key, so it POSTs `{ email }` to the invite-account Supabase
 *  function, which creates a confirmed account or reports that one exists.
 *  Same bearer as notify-email (BOB_NOTIFY_EMAIL_SECRET); no secret of its own.
 *  The URL is BOB_INVITE_ACCOUNT_URL, else BOB_NOTIFY_EMAIL_URL with its
 *  trailing `/notify-email` replaced by `/invite-account` (both functions live
 *  under the same functions base). Unconfigured, every call is a journaled
 *  'skipped'. Never throws. Journal lines carry the outcome only -- never the
 *  address. */
import { moduleJournal } from '../platform/logger.ts';

const journal = moduleJournal('account');

const PROVISION_TIMEOUT_MS = 10_000;

type ProvisionOutcome = 'created' | 'exists' | 'skipped' | 'failed';

/** The invite-account URL, or null when neither it nor a derivable notify-email URL is set. */
export function inviteAccountUrl(): string | null {
  const override = process.env.BOB_INVITE_ACCOUNT_URL;
  if (override) return override;
  const notify = process.env.BOB_NOTIFY_EMAIL_URL;
  if (!notify) return null;
  const derived = notify.replace(/\/notify-email\/?$/, '/invite-account');
  return derived === notify ? null : derived;
}

/** Creates a confirmed account for the address when it has none. Never throws. */
export async function ensureInviteeAccount(email: string): Promise<ProvisionOutcome> {
  const url = inviteAccountUrl();
  const secret = process.env.BOB_NOTIFY_EMAIL_SECRET;
  if (!url || !secret) {
    journal('v2.invitee_account', { outcome: 'skipped', reason: 'not_configured' });
    return 'skipped';
  }
  let outcome: ProvisionOutcome;
  let code: string | undefined;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as { ok?: unknown; created?: unknown } | null;
    if (response.ok && body?.ok === true && typeof body.created === 'boolean') {
      outcome = body.created ? 'created' : 'exists';
    } else {
      outcome = 'failed';
      code = response.ok ? 'bad_response' : `http_${response.status}`;
    }
  } catch (error) {
    outcome = 'failed';
    code = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      ? 'timeout'
      : 'network';
  }
  journal('v2.invitee_account', code ? { outcome, code } : { outcome });
  return outcome;
}
