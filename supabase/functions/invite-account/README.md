# `invite-account` — a confirmed account for an invited address

Bob is invite-only: signups are off (`scripts/invite-only.test.ts` pins it),
and sign-in uses `signInWithOtp` with `shouldCreateUser: false`. So a space
admin could invite an address that has no account, and its owner could never
sign in to accept.

When a space invitation goes to such an address, the API calls this function
first. It creates a **confirmed** account for the address through the admin
API (`auth.admin.createUser({ email, email_confirm: true })`). The invitee then
signs in with the emailed code and accepts. Signups stay off everywhere; this
function is the only way an invited address gets an account.

It sends no email. The API sends the space-invite mail through `notify-email`.

## Request

```
POST {SUPABASE_URL}/functions/v1/invite-account
Authorization: Bearer <NOTIFY_EMAIL_SECRET>

{ "email": "<address>" }
```

- Body at most 4 KB, a JSON object.
- `email` is trimmed and lower-cased before use, then must look like an address
  and be at most 254 characters.

| Status | Body                                             | When                                        |
| ------ | ------------------------------------------------ | ------------------------------------------- |
| 200    | `{ "ok": true, "created": true }`                | A new confirmed account was created         |
| 200    | `{ "ok": true, "created": false }`               | The address already has an account          |
| 400    | `{ "ok": false, "error": "bad_request" }`        | Not JSON, wrong shape, bad address, too large |
| 401    | `{ "ok": false, "error": "unauthorized" }`       | Missing or wrong bearer                     |
| 405    | `{ "ok": false, "error": "method_not_allowed" }` | Anything but POST                           |
| 502    | `{ "ok": false, "error": "provision_failed" }`   | The admin API failed                        |

"Already has an account" is recognised by GoTrue's error code
(`email_exists` / `user_already_exists`), never by matching message text.

The bearer is compared in constant time, the same way as `notify-email`
(SHA-256 of both sides, then a fixed 32-byte comparison). Log lines carry the
outcome only — never the address.

## Secrets

| Secret                      | Required | Notes                                                                    |
| --------------------------- | -------- | ------------------------------------------------------------------------ |
| `NOTIFY_EMAIL_SECRET`       | **yes**  | The one shared API → functions bearer, the same one `notify-email` uses. No new secret to manage. |
| `SUPABASE_URL`              | —        | Injected by Supabase.                                                    |
| `SUPABASE_SERVICE_ROLE_KEY` | —        | Injected by Supabase. The API server holds no service-role key, which is why account creation lives here. |

## Deploy

`.github/workflows/supabase.yml` deploys it with the other functions. JWT
verification is off (`[functions.invite-account] verify_jwt = false` in
`supabase/config.toml`): the caller is the API server, not a signed-in user,
and the bearer secret is the gate.

## Test

```bash
DENO_NO_PACKAGE_JSON=1 deno test --allow-read --allow-env supabase/functions/invite-account
```
