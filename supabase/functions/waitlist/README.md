# `waitlist` — public waitlist, no auth account

Two endpoints for the landing page: request a six-digit code, then verify it.

```
POST { action: "request", email, source? }  -> { ok: true }
POST { action: "verify",  email, code }     -> { ok: true, verified: bool }
```

## Why this exists instead of Supabase Auth's OTP

The obvious way to prove someone owns an address is `signInWithOtp`, but that
needs `shouldCreateUser`, which needs `[auth] enable_signup` — and Bob is
invite-only by design. `scripts/invite-only.test.ts` pins that switch to
`false`, forbids `signUp()` in the UI, and requires every `signInWithOtp()` to
pass `shouldCreateUser: false`. A marketing list is not a good enough reason to
retire that.

So **nothing here creates an `auth.users` row**. A waitlist entry is a row in
`bob.waitlist` and nothing more; nobody on the list can obtain a JWT. Members
become real accounts later through the existing admin-API invite flow, which is
what a waitlist is for.

A useful side effect: because no new principal can authenticate, opening the
waitlist does not widen what `/api/*` will accept, so the JWT guard needs no
change.

## Deploy

```bash
supabase functions deploy waitlist --no-verify-jwt
```

`--no-verify-jwt` because callers are anonymous visitors. The function is still
not an open door: it only ever writes to its own table and emails the address it
was given. A separate notice goes to the configured administrator only after first verification.

## Secrets

| Secret                            | Required | Notes                                                                                                                                                  |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WAITLIST_CODE_PEPPER`            | **yes**  | Long random string. Mixed into the code hash so a stolen database dump alone can't precompute the 10⁶ digests. Rotating it invalidates all live codes. |
| `SUPABASE_SERVICE_ROLE_KEY`       | yes      | Injected by the platform. The only way to reach the table.                                                                                             |
| `SUPABASE_URL`                    | yes      | Injected by the platform.                                                                                                                              |
| `BOB_SMTP_USERNAME` / `BOB_SMTP_PASSWORD` | yes      | The one Bob PurelyMail mailbox every function sends through; required.                                                                                                                  |
| `WAITLIST_NOTIFY_EMAIL`          | no | Single bare email address receiving each first verified signup. Unset disables delivery; missing or invalid configuration logs a fixed failure code without undoing verification. |
| `WAITLIST_ALLOWED_ORIGIN`         | no       | Optional additional exact CORS origin. Bob (`https://www.heybob.xyz`) and Bob (`https://www.heybob.xyz`) are always allowed during the transition.                                                   |

```bash
supabase secrets set WAITLIST_CODE_PEPPER="$(openssl rand -hex 32)"
```

## How the code is protected

- **Stored as `sha256(code || pepper)`**, never in clear — this table is the one
  place a backup could otherwise leak live credentials.
- **Server-side digest comparison**, with no user-controlled digest comparison or timing oracle.
- **`crypto.getRandomValues`**, not `Math.random()`.
- **10-minute expiry**, **5 attempts**, then the code is dead. Five guesses out
  of 10⁶ is the whole budget.
- **60-second resend cooldown** per address, checked before anything is sent or
  written — so hammering the endpoint neither mails the address repeatedly nor
  resets a live code.
- **Cleared on success**, so it can't be replayed.
- **Cleared on failed delivery**, so a transient SMTP error can be retried immediately.
- **Bounded and strictly validated requests**, with a constrained source label.

## The endpoint is not an address oracle

`request` answers `{ ok: true }` whether the address was new, already on the
list, or inside its cooldown. `verify` answers `{ verified: false }` for a wrong
code, an expired one, one that ran out of attempts, and an address that was
never sent one. Only a genuinely correct code answers differently, so the
endpoint can't be used to test whether someone signed up.

## Mail it sends

- `waitlist-code` — the six-digit code, on `request`.
- `waitlist-joined` — a welcome ("You're on the list", with what happens next),
  on the `verify` that returns `verified: true`. `waitlist_confirm` answers
  `verified` only while `verified_at` is still null, so that is the first
  verification of the address and the welcome goes out once. It is
  best-effort: a failed send is logged (without the address) and does not
  change the response.

- `waitlist-admin-joined` — a separate Bob message to `WAITLIST_NOTIFY_EMAIL` on
  the first successful verification only. Includes the subscriber address and
  a link to `https://app.heybob.xyz/admin`, never their code or verification
  secrets. A code request, rejected verification, or `already_verified` result
  sends no admin notice. The welcome and admin notice run independently, so
  either can fail without suppressing the other or undoing verification.
  Delivery is best-effort with no automatic retries or durable queue: SMTP or
  recipient-configuration failures log only `waitlist: admin notification failed`.
  Repeating verification does not resend a failed notification.

All three are declared in `supabase/functions/_shared/email/templates/waitlist.ts`
and rendered by the shared email design system (`_shared/email/render.ts`).

There is deliberately **no BCC** on these mails, unlike the auth hook: a
waitlist code is not a credential for any existing account, and mirroring every
one into a mailbox would be needless exposure.

## Reading the list

The table has no PostgREST endpoint (the `bob` schema isn't exposed) and RLS
is forced with zero policies, so use the dashboard SQL editor or `psql` as the
owner:

```sql
select email, source, created_at from bob.waitlist where verified_at is not null order by created_at desc;
```

`verified_at is not null` is the important part — an unverified row is only ever
someone who typed an address, not someone who proved they own it.

## Bob replacement rollout

Apply the Bob returning-subscriber migration before deploying the function. Existing rows, source labels, signup dates and verification dates stay intact. A returning subscriber must enter a fresh valid code: the RPC returns `already_verified`, the public response is still `{ ok: true, verified: true }`, and neither a second welcome nor an admin notification is sent. Successful codes are consumed under the existing row lock.

Waitlist subjects, HTML and text use Bob branding and www.heybob.xyz. They go through the shared mailer's one Bob mailbox: required `BOB_SMTP_USERNAME` and `BOB_SMTP_PASSWORD`, optional bare-address `BOB_SMTP_FROM` (defaults to the Bob username), display name Bob, `BOB_SMTP_HOST`/`BOB_SMTP_PORT` defaulting to smtp.purelymail.com:465 with TLS. Replies default to the Bob sender. Missing Bob credentials fail closed. `send-email` and `notify-email` send through the same mailbox. Unapproved origins receive no Access-Control-Allow-Origin header; CORS is a browser policy, not authentication.

Validate with `npx deno test --node-modules-dir=none --allow-env --allow-read supabase/functions/waitlist/handler.test.ts supabase/functions/_shared/email` and run `verification.test.sql` against an isolated PostgreSQL database after the initial waitlist and Bob migrations. Never apply the test fixture to production.
