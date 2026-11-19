# `send-email` — Supabase Auth Send Email Hook

With this hook enabled, Supabase stops sending auth mail itself and POSTs every
one here: invites, signup confirmations, magic links, OTPs, password resets and
the `*_notification` security notices. `render.ts` maps each
`email_action_type` to a declared template and renders it with the shared email
design system; the mail goes out through `_shared/mailer.ts` over PurelyMail
SMTP.

## Templates

The words live in `supabase/functions/_shared/email/templates/auth.ts` (the
`auth-*` codes and links) and `templates/security.ts` (the `security-*`
notices); the look lives in `_shared/email/render.ts`. Nothing in this folder
writes HTML.

| `email_action_type`                    | Template                                                 |
| -------------------------------------- | -------------------------------------------------------- |
| `magiclink`, `email`                   | `auth-sign-in-code` (code only, no link)                 |
| `signup`                               | `auth-signup-confirm`                                    |
| `invite`                               | `auth-account-invite`                                    |
| `recovery`                             | `auth-password-reset`                                    |
| `email_change`                         | `auth-email-change-current` + `auth-email-change-new`    |
| `reauthentication`                     | `auth-reauthenticate`                                    |
| `*_notification`                       | the matching `security-*` template                       |
| anything else                          | a generic "something changed" notice (never an error)    |

Secure email change sends **two** messages from one hook call. Per Supabase's
Send Email Hook docs ("Email change behavior and token hash mapping"), `token`
goes to the current address (`user.email`) and `token_new` to the new one
(`user.new_email`); with only one OTP it goes to the new address alone.
`email_changed_notification` goes to `email_data.old_email` when present.

## Brand: Bob or Bob

One hook serves both products. `render.ts` reads the
signed payload's `email_data.redirect_to` and picks **Bob** only when it parses
as a URL with protocol `https:`, hostname exactly `app.heybob.xyz`, no port and
no userinfo (any path, e.g. `/reset`). Anything else is **Bob**: absent,
malformed, `http:`, `heybob.xyz`, `app.heybob.xyz.evil.example`,
`app.heybob.xyz@evil.example`, `user@app.heybob.xyz` and `:8443`. The brand is
never read from `user_metadata`, which the user can edit.

The brand is passed to each template as data (`brand: "bob"`), so only our own
copy changes (subject, heading, body, header and footer
`Bob · www.heybob.xyz`). Codes, verify links (and their `redirect_to`),
addresses and provider names pass through untouched. The brand only chooses
the copy: every message, Bob or Bob, leaves through the one Bob mailbox
(`BOB_SMTP_*`, sender shown as `Bob`), the same one the waitlist and
`notify-email` use. Secure email change sends both messages in the request's
brand, with the token-to-recipient mapping unchanged.

**Redirect allow-list:** GoTrue only forwards a `redirect_to` that is on the
redirect allow-list; otherwise it substitutes `site_url`
(`https://app.heybob.xyz`, unchanged) and the mail is Bob. The hosted project
allows exactly these two Bob entries, no wildcard:

- `https://app.heybob.xyz` (code sign-in sends `emailRedirectTo: window.location.origin`)
- `https://app.heybob.xyz/reset` (password reset sends `redirectTo: <origin>/reset`)

Any future `supabase config push` must keep both, or Bob auth mail silently
reverts to Bob.

Tests (mocked, no mail sent):

```bash
npx --yes deno test --node-modules-dir=none --allow-env --allow-read supabase/functions/send-email/ supabase/functions/_shared/
```

**Limitation:** the `*_notification` security notices usually carry no
`redirect_to`, so they fall back to Bob deterministically even for Bob
accounts. A notice is branded Bob only if Supabase includes a Bob
`redirect_to`.

It supersedes `supabase/templates/magic_link.html` for any action it handles —
Supabase's own templates are not consulted while the hook is on. The static
template is kept as the fallback for if the hook is ever disabled.

## Deploy

```bash
supabase functions deploy send-email --no-verify-jwt
```

`--no-verify-jwt` is required: Supabase Auth authenticates with a Standard
Webhooks signature, not a user JWT. The function verifies that signature itself
before reading any field, so it is not an open relay.

## Secrets

Nothing below is in source. Set them as Edge Function secrets:

```bash
supabase secrets set SEND_EMAIL_HOOK_SECRET='v1,whsec_...' BOB_SMTP_USERNAME='...' BOB_SMTP_PASSWORD='...'
```

| Secret                   | Required | Default               | Notes                                                                                         |
| ------------------------ | -------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `SEND_EMAIL_HOOK_SECRET` | yes      | —                     | From the dashboard when you create the hook. Keep the `v1,whsec_` prefix; the code strips it. |
| `BOB_SMTP_USERNAME`      | yes      | —                     | The one PurelyMail mailbox every function sends through; a send fails (500) without it       |
| `BOB_SMTP_PASSWORD`      | yes      | —                     | Its password or app password                                                                  |
| `BOB_SMTP_FROM`          | no       | `BOB_SMTP_USERNAME`   | Sender address, shown as `Bob`                                                                |
| `BOB_SMTP_HOST`          | no       | `smtp.purelymail.com` |                                                                                               |
| `BOB_SMTP_PORT`          | no       | `465`                 | 465 is implicit TLS; any other port (587) uses STARTTLS                                       |
| `AUTH_EMAIL_BCC`         | no       | empty (no BCC)        | Set only if you want a copy of every auth email — read the warning below first               |

`SUPABASE_URL` is injected by the platform; no need to set it.

## Enable the hook

Dashboard → **Authentication → Hooks → Send Email**, point it at
`https://<ref>.supabase.co/functions/v1/send-email`, and copy the generated
secret into `SEND_EMAIL_HOOK_SECRET`.

`config.toml` carries the equivalent block **commented out on purpose**. An
enabled hook needs `secret = "env(SEND_EMAIL_HOOK_SECRET)"`, and
`supabase start` fails outright when that variable is unset — which it is for
every developer running the stack locally and for CI. Local auth mail goes to
Mailpit, which is what you want locally anyway. Uncomment it only if you set the
variable everywhere the stack starts.

## Failure behaviour

Supabase treats any non-2xx as a failed hook and surfaces the error rather than
reporting a send that never happened. So:

- bad/missing signature → **401**
- no recipient in the payload → **400**
- SMTP send failed → **500**
- delivered → **200 `{}`**

An SMTP failure is never swallowed. A user who never got their code sees an
error instead of a silent dead end.

## ⚠️ A BCC is a standing copy of every credential email

There is no BCC unless `AUTH_EMAIL_BCC` is set. Once set, it puts a copy of
**every** auth email — OTP codes, magic links, invite links, password-reset
links — into one mailbox. Anyone who can read that mailbox can take over any
account on the project, including during the window before a code expires. If
you turn it on:

- that mailbox needs MFA and a strong, unique password;
- it should not be forwarded onward or shared;
- consider narrowing it later to invites only (drop the `bcc` for `signup`,
  `magiclink`, `email`, `recovery` in `index.ts`), which keeps the audit trail
  for the cases you actually want to see without mirroring live credentials.

Unset `AUTH_EMAIL_BCC` to turn it off without a redeploy.

## Local test

```bash
supabase functions serve send-email --no-verify-jwt --env-file supabase/functions/send-email/.env.local
```

A request with no valid signature must come back 401 — that is the check worth
running first.
