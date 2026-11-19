import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/auth/use-session';

/**
 * The invite-acceptance flow (spec 014, S03; contract apps/api/src/spaces/http.ts
 * "GET/POST /invitations/:token[/accept]"). GET .../invitations/:token is the
 * thin, unauthenticated-safe preview -- the one route a non-member may reach --
 * and returns only `{ space_name, space_kind, inviter_display_name,
 * exposes_history }`, never space content and never a space id. It currently
 * sits behind the blanket /api JWT guard and 401s for a signed-out caller (a
 * parallel task fixes that); this hook degrades honestly either way rather
 * than showing a blank page or spinning forever -- see `sign_in_required`.
 *
 * POST .../accept is always authenticated. Its response is `{ status:
 * outcome }` for every outcome, success or failure alike (web-spaces.ts
 * ACCEPT_STATUS) -- there is no `{ error: { code } }` envelope for a business
 * outcome, only for the two guard checks (missing account -> 401, malformed
 * token -> 400) that run before the store is even consulted.
 *
 * Four situations are kept distinct on purpose rather than collapsed into one
 * "something went wrong" -- they mean different things to the person reading
 * the screen:
 *   - not_usable: the token is unknown, expired, revoked or already used. The
 *     preview route returns a bare 404 for all of these (the server does not
 *     say which), so neither can this hook. Only a 404 means this.
 *   - sign_in_required: a 401 from either call.
 *   - wrong_account: a 403 on accept (email_mismatch) -- the invitation was
 *     issued to a different address than the signed-in account. A forwarded
 *     link is the common real case; naming it plainly avoids a confusing dead
 *     end.
 *   - network_error: the request itself failed, or the server answered with
 *     something neither of the above (a 500 store_error, an unparsable body)
 *     -- worth a retry either way.
 */

export type InvitationPreviewDto = {
  space_name: string;
  space_kind: string;
  inviter_display_name: string;
  exposes_history: boolean;
  /** Absent when the API predates the offered-role field. */
  role?: 'admin' | 'member';
  /** Epoch milliseconds. Absent when the API predates the expiry field. */
  expires_at?: number;
};

type InvitationErrorKind =
  | 'not_usable'
  | 'sign_in_required'
  | 'wrong_account'
  | 'network_error';

type InvitationError = {
  kind: InvitationErrorKind;
  message: string;
};

/** POST .../accept's outcome codes, verbatim from web-spaces.ts ACCEPT_STATUS.
 *  Kept as-is (not remapped into `error`) so a caller can tell a fresh accept
 *  apart from "you were already in" -- the only signal available for that,
 *  since the accept response never carries a space id. */
type AcceptOutcome =
  | 'accepted'
  | 'already_accepted'
  | 'already_member'
  | 'expired'
  | 'revoked'
  | 'email_mismatch'
  | 'not_found';

const ACCEPT_OUTCOMES: readonly AcceptOutcome[] = [
  'accepted',
  'already_accepted',
  'already_member',
  'expired',
  'revoked',
  'email_mismatch',
  'not_found',
];

const SUCCESS_OUTCOMES: readonly AcceptOutcome[] = ['accepted', 'already_accepted', 'already_member'];

const NOT_USABLE_MESSAGE =
  "This invitation can't be used. It may have expired, been revoked, or already been used.";
const SIGN_IN_MESSAGE = 'Sign in to continue.';
const WRONG_ACCOUNT_MESSAGE =
  'This invitation was sent to a different account. Sign in with that account, or ask for a new invite.';
const NETWORK_ERROR_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

function isAcceptOutcome(value: unknown): value is AcceptOutcome {
  return typeof value === 'string' && (ACCEPT_OUTCOMES as readonly string[]).includes(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

type UseInvitationResult = {
  preview: InvitationPreviewDto | null;
  loading: boolean;
  error: InvitationError | null;
  accepting: boolean;
  /**
   * Resolves to a space id on success. The current accept contract
   * (web-spaces.ts) returns only `{ status }` -- no space id -- so this
   * resolves to null on every success today; a caller should fall back to
   * the family space list rather than a specific space until that lands.
   */
  accept: () => Promise<string | null>;
  /** The last accept() outcome, so a caller can render "already a member"
   *  distinctly from a fresh accept. Null until accept() has resolved once. */
  outcome: AcceptOutcome | null;
  /** Re-runs the preview fetch -- the only affordance for a network failure
   *  at load time, before any Accept control exists to retry from. */
  retry: () => void;
};

export function useInvitation(token: string): UseInvitationResult {
  const [preview, setPreview] = useState<InvitationPreviewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<InvitationError | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [outcome, setOutcome] = useState<AcceptOutcome | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const loadPreview = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    setOutcome(null);
    try {
      const response = await fetchWithAuth(`/api/invitations/${tokenRef.current}`);
      if (response.status === 401) {
        setPreview(null);
        setError({ kind: 'sign_in_required', message: SIGN_IN_MESSAGE });
        return;
      }
      if (response.status === 404) {
        setPreview(null);
        setError({ kind: 'not_usable', message: NOT_USABLE_MESSAGE });
        return;
      }
      // Only a definitive 404 proves the token is unusable; any other failure
      // (5xx, unexpected status) or a malformed body is transient and retryable.
      const body = response.ok
        ? ((await readJson(response)) as { preview?: InvitationPreviewDto } | null)
        : null;
      if (!body?.preview) {
        setPreview(null);
        setError({ kind: 'network_error', message: NETWORK_ERROR_MESSAGE });
        return;
      }
      setPreview(body.preview);
    } catch {
      setPreview(null);
      setError({ kind: 'network_error', message: NETWORK_ERROR_MESSAGE });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPreview();
    // Re-run whenever the token itself changes; loadPreview reads it through
    // tokenRef so its own identity stays stable.
  }, [loadPreview, token]);

  const accept = useCallback(async (): Promise<string | null> => {
    setAccepting(true);
    setError(null);
    try {
      const response = await fetchWithAuth(`/api/invitations/${tokenRef.current}/accept`, {
        method: 'POST',
      });
      if (response.status === 401) {
        setError({ kind: 'sign_in_required', message: SIGN_IN_MESSAGE });
        return null;
      }
      const body = (await readJson(response)) as { status?: unknown } | null;
      const status = isAcceptOutcome(body?.status) ? body.status : null;
      if (status === 'email_mismatch') {
        setError({ kind: 'wrong_account', message: WRONG_ACCOUNT_MESSAGE });
        return null;
      }
      if (status !== null && SUCCESS_OUTCOMES.includes(status)) {
        setOutcome(status);
        // No space id on the wire (see accept()'s doc comment above) -- the
        // caller falls back to the family space list.
        return null;
      }
      if (status === 'expired' || status === 'revoked' || status === 'not_found') {
        setError({ kind: 'not_usable', message: NOT_USABLE_MESSAGE });
        return null;
      }
      // An unrecognised status, a non-JSON body, or a bare 500 store_error --
      // none of those are a business outcome we can name, so treat them the
      // same as a transport failure: worth a retry, not a dead end.
      setError({ kind: 'network_error', message: NETWORK_ERROR_MESSAGE });
      return null;
    } catch {
      setError({ kind: 'network_error', message: NETWORK_ERROR_MESSAGE });
      return null;
    } finally {
      setAccepting(false);
    }
  }, []);

  return {
    preview,
    loading,
    error,
    accepting,
    accept,
    outcome,
    retry: () => void loadPreview(),
  };
}
