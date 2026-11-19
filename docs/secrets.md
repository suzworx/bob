# Secrets

How Bob stores, reads and rotates secrets. Names and placeholders only: this file never holds a value.

## Principles

- Secrets live in exactly two kinds of place: your local, git-ignored env files (`.env`,
  `.env.supabase`, `.env.github`) and your hosting platform's secret store. Nothing else.
- Every committed template (`.env*.example`) lists names with empty values;
  `scripts/env-files.test.ts` keeps the templates in step with the code that reads them.
- Never pass a secret value as a command-line argument: argv lands in shell history and process
  lists. Prefer stdin or an env file. Print names, counts and booleans, never values.
- `npm run validate` scans the staged diff for credential-shaped content (`scripts/validate.mjs`,
  `secretPatterns`) and refuses to pass when it finds one.
- The server never logs a secret, a URL or a credential (`docs/log-reference.md`).

## Where each secret goes

| Secret | Where |
| --- | --- |
| `AI_GATEWAY_API_KEY` | API server. Use a separate, spend-capped key for development. |
| `BOB_DATABASE_URL` | API server: the `bob_server` role through the Supabase session pooler ([deploy.md](deploy.md)). |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | API server (the publishable key is public by design). |
| `DEVICE_SHARED_SECRET` | API server and the Cardputer's `include/secrets.h`; optional, legacy devices only. |
| `BOB_NOTIFY_EMAIL_SECRET` / `NOTIFY_EMAIL_SECRET` | API server / Supabase function secrets; the same bytes. |
| `SEND_EMAIL_HOOK_SECRET`, `WAITLIST_CODE_PEPPER`, `BOB_SMTP_*` | Supabase function secrets (`.env.supabase.example`). |
| `APNS_*` | API server ([ios-push-notifications.md](ios-push-notifications.md)). |
| `BOB_GOOGLE_*` | API server ([google-connect.md](google-connect.md)). |
| `BOB_FW_SIGNING_KEY` | GitHub Actions secret for the firmware release job (`.env.github.example`). |

## Rotation

For any provider that allows two live credentials, rotate without downtime:

1. Create the new credential at the provider.
2. Set it everywhere it is read (the table above), then restart or redeploy the consumers.
3. Verify each consumer works with the new value (health check, a real request).
4. Revoke the old credential at the provider.

Credentials that cannot overlap (for example the `bob_server` database password) cause a short
outage: change the password, update `BOB_DATABASE_URL`, and redeploy the API immediately.

The firmware signing key is special: devices trust only the public keys compiled into
`apps/cardputer/include/fw_keys.h`. Generate a new pair with `node scripts/release/fw-keys.mjs gen`,
ship firmware that trusts both old and new public keys, switch the private key in the release job's
secret, and drop the old public key only after every device runs that firmware.
