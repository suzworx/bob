# `notify-email` — app notification mail

The one way the API sends email about things that happen in the app: a space
invite, a mention, a reminder, a calendar change, a paired device. The API
names a template from the shared catalog (`_shared/email/catalog.ts`) and
supplies its data; this function builds the content, renders it through the
email design system (`_shared/email/render.ts`) and sends it over the shared
SMTP transport (`_shared/mailer.ts`).

Auth and security mail (`auth-*`, `security-*`) is sent only by `send-email`,
the Send Email Hook, and waitlist mail (`waitlist-*`) only by `waitlist`. This
function refuses those ids, so its secret can never be used to mint a sign-in
code email.

## Request

```
POST {SUPABASE_URL}/functions/v1/notify-email
Authorization: Bearer <NOTIFY_EMAIL_SECRET>

{ "template": "<id>", "to": "<address>", "data": { ... } }
```

- Body at most 16 KB, a JSON object.
- `to` looks like an address and is at most 254 characters.
- Every key in the template's `required` list must be a non-empty string (or a
  number where the template takes one). URLs and `*Label` fields are built by
  the caller.

| Status | Body                                        | When                                           |
| ------ | ------------------------------------------- | ---------------------------------------------- |
| 200    | `{ "ok": true }`                            | Sent                                           |
| 400    | `{ "ok": false, "error": "bad_request" }`   | Not JSON, wrong shape, bad address, too large  |
| 400    | `{ "ok": false, "error": "unknown_template" }` | No such id, or an `auth-*`/`security-*`/`waitlist-*` id |
| 400    | `{ "ok": false, "error": "missing_field" }` | A required data key is absent or empty         |
| 401    | `{ "ok": false, "error": "unauthorized" }`  | Missing or wrong bearer                        |
| 405    | `{ "ok": false, "error": "method_not_allowed" }` | Anything but POST                         |
| 502    | `{ "ok": false, "error": "send_failed" }`   | SMTP rejected or failed                        |

The bearer is compared in constant time (SHA-256 of both sides, then a fixed
32-byte comparison). Log lines carry the template id and the outcome only —
never an address, a name or any data.

## Secrets

| Secret                            | Required | Notes                                                                 |
| --------------------------------- | -------- | --------------------------------------------------------------------- |
| `NOTIFY_EMAIL_SECRET`             | **yes**  | Long random string, shared with the API as `BOB_NOTIFY_EMAIL_SECRET`. |
| `BOB_SMTP_USERNAME` / `BOB_SMTP_PASSWORD` | yes | The one Bob PurelyMail mailbox, shared with `send-email` and `waitlist`. |
| `BOB_SMTP_FROM`                   | no       | Sender address, shown as `Bob`; defaults to `BOB_SMTP_USERNAME`.      |
| `BOB_SMTP_HOST` / `BOB_SMTP_PORT` | no       | Transport overrides, see `_shared/mailer.ts`.                         |

```bash
supabase secrets set NOTIFY_EMAIL_SECRET="$(openssl rand -hex 32)"
```

No BCC is added to notification mail.

## Deploy

CI deploys it with the other functions. JWT verification is off
(`[functions.notify-email] verify_jwt = false` in `supabase/config.toml`): the
caller is the API server, not a signed-in user, and the bearer secret is the
gate.

## Test

```bash
deno test --no-check --allow-read --allow-env supabase/functions/notify-email/handler.test.ts
```
