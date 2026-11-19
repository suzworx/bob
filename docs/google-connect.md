# Google Workspace connection

The API server owns linking, permission checks, provider operations and personal web/device tools. Google
OAuth itself runs through a small, separately deployed bridge endpoint (Vercel Connect with project OIDC)
that the server calls with a shared secret. No extra machine or Redis is required; background sync remains
separate. The integration is optional and stays dormant until configured.

## Configuration

The API server requires these four variables together:

- `BOB_GOOGLE_BRIDGE_URL`: full HTTPS endpoint of the bridge (`.../internal/integrations/google`), without query or embedded credentials.
- `BOB_GOOGLE_BRIDGE_SECRET`: environment-specific random base64url secret, at least 32 characters.
- `BOB_GOOGLE_CLIENT_ID`: Google web client ID, checked against token audience.
- `BOB_GOOGLE_CALLBACK_URLS`: comma-separated exact HTTPS application return URLs, without query, hash or embedded credentials; one per distinct origin.

The bridge requires matching `GOOGLE_CONNECT_BRIDGE_SECRET` and `GOOGLE_CONNECT_CALLBACK_URLS`. Use separate preview/production secrets. Provider credentials stay in Connect. Never copy development OIDC tokens into the server environment. Responses are non-cacheable and errors sanitized. Do not point the bridge URL at a host whose catch-all rewrites proxy to the API itself.

The application callback route can be `/integrations` (preferred), `/settings` or `/gmail`: the Integrations page's Google section reads the returned `state` and completes the connection, and `/settings` and `/gmail` forward a Google return to `/integrations` with the query kept. The server accepts exactly one callback URL per origin and refuses to start with two for the same origin. The authorize endpoint chooses the exact configured entry using the request Origin, rejecting missing or unknown origins before creating an attempt. It does not trust Host, forwarded-host headers or a browser-supplied callback URL. Verify each host's Supabase redirect configuration before enablement.

Apply migrations before deploying code that reads their columns, deploy the bridge before enabling its caller, then set the complete runtime configuration. Missing all four values keeps the adapter dormant; partial configuration fails startup.

Google's authorized redirect URI is `https://connect.vercel.com/callback`, separate from the application return URL. A Google Cloud project in External Testing with the Gmail and Calendar APIs enabled and a few test users is enough for development. Configuration does not prove live authorization.

## Consent and identity

`POST /api/google-accounts/authorize` accepts named `capabilities` and optional owned `reconnectAccountId`. Supported capabilities: `calendar.read`, `calendar.write`, `gmail.read`, `gmail.draft`. The server persists a ten-minute owner-bound attempt with hashed state and an opaque per-connection subject. Response: consent URL and expiry, never tokens or SDK verifiers.

The authenticated browser posts `{state}` to `POST /api/google-accounts/callback`. The server atomically consumes the owner's attempt, retrieves that exact subject's token and verifies Google audience, expiry, stable identity and verified email. Requested scopes do not establish actual grants; operations verify current scopes and ownership. Reconnect cannot replace the stored Google identity.

Explicit `connect_subject` is separate from the legacy installation ID. Legacy rows without a subject cannot authorize provider operations. Tokens remain transient server-side values, excluded from browser responses, models, devices and logs.

The original requested capability set is an internal broker lookup selector, not evidence of permission. The live pilot retrieved a verified token for the original combined Calendar/Gmail request, while default and smaller scope requests returned reconnect-required. Persist the selector from the consumed server-side consent attempt and reuse it when retrieving credentials; independently verify actual Google scopes before each operation. Reconnect replaces the selector only after successful identity verification. Partial consent and token refresh still require live proof; the observed lookup behavior alone does not establish their cause or correctness.

## Scope and release evidence

### Consent and public-launch readiness

The account picker requests `openid` and `email` plus the selected capabilities. `calendar.read` requests `calendar.calendarlist.readonly` and `calendar.events.readonly`; `calendar.write` requests calendar listing and `calendar.events`. `gmail.read` requests `gmail.readonly`; `gmail.draft` requests `gmail.readonly` and `gmail.compose`. These short names use Google's `https://www.googleapis.com/auth/` prefix. Exact consent-screen wording remains to be captured during the live pilot; a configured client does not prove successful consent.

The current External Testing app is limited to configured test users. Google documents seven-day authorizations, including offline refresh tokens, for testing apps requesting these scopes; reconnect is therefore expected during the pilot. See [Google's audience rules](https://support.google.com/cloud/answer/15549945?hl=en). Reconnect selects the existing local account and verifies the same Google identity; choosing another identity must fail rather than replace it.

Google classifies Gmail read and compose scopes as restricted. Public release needs the applicable OAuth verification and, for server-side storage or transmission of restricted data, security assessment; using Connect does not establish that the application has met these requirements. See [Gmail scope requirements](https://developers.google.com/workspace/gmail/api/auth/scopes). The project owner owns the submission and assessment decision; no approval or date is recorded. Workspace administrators may independently block access through [app access controls](https://support.google.com/a/answer/7281227); those policy failures require administrator action, not repeated consent.

Pilot configuration is ready for testing only. Public-launch approval remains unverified and separate from the engineering pilot.

Calendar: bounded reads and ordinary single-event create/update. Gmail: search, thread reads and reply drafts. No sends, attachment downloads, ingestion, attendee or recurring-event writes. Google draft scope permits sending at provider level but the product exposes no send operation. Read/write consent choices are separate.

Selected Google calendars appear alongside native events with source identity and partial-failure reporting. Tools are private-conversation only; provider-content turns are durably excluded from automatic memory extraction.

Before release: full repository validation, bridge tests/build, migrations before configuration, deployed OIDC/bridge proof, two Google accounts and two application owners. Verify parallel callbacks, wrong-owner/replay rejection, separate data, reconnect, revoke-one-preserves-other, personal web/device tools and agenda. Use isolated test events and reply drafts, never email sends. Verify draft Message-ID retention and unknown-write reconciliation. Mocks and skipped tests do not establish live readiness. Production rollout remains disabled pending this evidence.
