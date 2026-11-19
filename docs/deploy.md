# Self-hosting Bob

One always-on host runs the API, the Cardputer WebSocket (`/v2/cardputer`), the
Supabase-backed conversation store, and the built web UI. The `Dockerfile` at
the repo root builds that image; any container platform that can run it with a
health check on `/health` (port 7444) works.

The image sets `BOB_PRODUCTION=1`, so the server **refuses to start** unless
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `BOB_DATABASE_URL` are set
(startup check; `DEVICE_SHARED_SECRET` is required only when
`BOB_LEGACY_DEVICE_OWNER` is set). Set them before the first deploy.

## Steps

1. Create a Supabase project. Replace `your-project-ref` under
   `[remotes.production]` in `supabase/config.toml` with its ref, then
   `npx supabase link --project-ref <ref>`.
2. Apply the schema: `npx supabase db push` (see "Migrations" below), then set
   the `bob_server` password and build the connection string.
3. Deploy the edge functions (`npx supabase functions deploy <name>`), set their
   secrets from `.env.supabase.example`, and push auth config with
   `npx supabase config push --project-ref <ref>`.
4. Build and run the image with the variables in `.env.example` that you need
   (at least `AI_GATEWAY_API_KEY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
   `BOB_DATABASE_URL`).
5. Point your Cardputer at the host ("Device firmware settings" below).

## Environment files

Each platform that needs secrets has a committed template,
`.env.<platform>.example`: names and one-line comments, never values. Copy it to
`.env.<platform>` (git-ignored), fill it in, and run the command in its header.
`scripts/env-files.test.ts` derives the names from the code that reads them
(the workflows, the Supabase functions and `config.toml`), so a template cannot
drift from what its platform needs.

| File | Applies to | Command |
| --- | --- | --- |
| `.env.example` | the API server (local `.env`, or your host's environment) | copy to `.env` |
| `.env.github` | GitHub Actions secrets (only the firmware release signing key) | `gh secret set -f .env.github --repo <owner>/<repo>` |
| `.env.supabase` | Edge Function secrets and the `config.toml` `env(...)` values | `supabase secrets set --env-file .env.supabase --project-ref <ref>` |

`NOTIFY_EMAIL_SECRET` (Supabase) must equal `BOB_NOTIFY_EMAIL_SECRET` on the API
server. Fill a line or delete it: an empty value is stored as empty, not skipped.
See [secrets.md](secrets.md).

## Supabase

### Auth settings (invite-only)

Signups are disabled in `supabase/config.toml` (`enable_signup = false` on
`[auth]`), so nobody can register and accounts are created by invitation only.
The Dashboard toggle is "Allow new users to sign up": keep it **off**.

### Applying migrations

`npx supabase db push` applies `supabase/migrations` to the linked project.
It rejects any migration whose version sorts at or before the newest one the
project already has, so `npm run check:migration-order` checks a branch for
late files before merge (git only, no database).

### Migrations: expand, then contract

A migration must never break the server that is already running. The
new schema and the old code run together for a few minutes on every deploy,
and after a rollback they can run together for much longer.

1. **Expand:** add nullable columns (or `not null default ...`), new tables,
   new indexes, new functions, new policies.
2. **Deploy** code that works with both the old and the new schema.
3. **Backfill.**
4. **Contract:** drop or rename in a later PR, shipped as a separate release,
   approved by a maintainer, with `-- bob:contract <why>` as a line of its own in
   the migration file. A contract step that deletes personal data must name the
   retention decision it carries out.

**The check.** `npm run lint:migrations` (`scripts/migration-lint.mjs`, the
`migrations` job in `ci.yml`) scans the migration files a change **adds**
under `supabase/migrations` and fails on:

| Rule | Statement |
| --- | --- |
| `drop_table` | `DROP TABLE` |
| `drop_column` | `ALTER TABLE ... DROP [COLUMN]` (not `DROP CONSTRAINT/DEFAULT/NOT NULL`) |
| `rename` | `ALTER ... RENAME` |
| `alter_type` | `ALTER TABLE ... ALTER [COLUMN] ... [SET DATA] TYPE` |
| `set_not_null_without_default` | `SET NOT NULL` with no `SET DEFAULT` in the statement |
| `not_null_column_without_default` | `ADD COLUMN ... NOT NULL` with no `DEFAULT` |
| `drop_policy_without_replacement` | `DROP POLICY p ON t` with no `CREATE POLICY p ON t` in the file |
| `disable_rls` | `DISABLE ROW LEVEL SECURITY`, `NO FORCE ROW LEVEL SECURITY` |

Comments, string literals, quoted identifiers and dollar-quoted function
bodies are ignored. Each failure names the file, line, statement and this
section. A file with the contract marker passes, and its findings are listed as
warnings in the job summary. Adding a migration needs no other edit: nothing
pins the schema version in code. Run it locally with `npm run lint:migrations`
(base `origin/main`; set `MIGRATION_LINT_BASE` to change it) or on files:
`node scripts/migration-lint.mjs supabase/migrations/<file>.sql`.

### Deferred constraints

A constraint that the running server's writes would violate is a contract
step too, even if the lint does not flag it: it must wait until that server
can no longer come back.

**`reminders_rrule_object` (RRULE-CHECK-DEFER).**
`20260926100000_reminders_rrule_object` converted the double-encoded reminder
rules to jsonb objects and added `check (rrule is null or jsonb_typeof(rrule) =
'object')`. The older server writes `JSON.stringify(rrule)` into
`$n::jsonb`, which stores a jsonb **string**, so under that CHECK it could not
create or update a recurring reminder during a deploy overlap or for the
whole of a rollback. `20260927020000_defer_rrule_object_check` drops the CHECK
and keeps the conversion. New code writes objects and `normalizeRrule` still
reads strings, so both servers work.

Re-add the CHECK in a **later release**, once no server that writes strings can
serve again and a rollback past it is no longer an option. That migration must first convert any string rows written in
the meantime, then add the CHECK. Validate it as a separate step, so the scan
does not hold a long lock:

```sql
-- bob:contract re-add reminders_rrule_object; the string-writing server can no longer return
update bob.reminders
   set rrule = (rrule #>> '{}')::jsonb
 where jsonb_typeof(rrule) = 'string';

alter table bob.reminders
  drop constraint if exists reminders_rrule_object;

alter table bob.reminders
  add constraint reminders_rrule_object
  check (rrule is null or jsonb_typeof(rrule) = 'object') not valid;

alter table bob.reminders
  validate constraint reminders_rrule_object;
```

After that release, remove the string branch of `normalizeRrule`
(`apps/api/src/reminders/store.ts`) and turn the old-server string-write tests
(`store-reminders.test.ts`, `store-reminders-rrule-object.db.test.ts`) back into
refusal tests.

### Deploy ordering

A change touching `supabase/**` and `apps/api/**` needs two deploys: the
migration (`supabase db push`) and the server image. The server that needs a
migration must not serve before the migration is applied.

`/health` reports the schema on every deployment:

```json
{"ok":true,"protocol":"...","path":"/v2/cardputer","schema_version":"20260926110000","schema_expected":"20260926110000","schema_status":"ok"}
```

`schema_expected` is derived, not pinned: at startup the server takes the
version (filename prefix) of the newest `supabase/migrations/*.sql` shipped with
it. The image carries only their names (`/app/supabase/migrations`, empty files
made by the Dockerfile's `migrations` stage); `.dockerignore` lets only
`supabase/migrations/*.sql` into the build context, never the rest of
`supabase/`. Without that folder `schema_expected` is `null` and the status is
`unknown`.

`schema_status` is `ok`, `schema_behind` (this code needs a migration that is
not applied), `schema_ahead` (the schema is newer than the code: a later deploy
is due, or this is a rollback) or `unknown` (no history readable, or no
migrations shipped). The startup check journals `v2.schema_check` with the same
fields.

**Holding a deploy behind its migration.** Apply migrations before the code
that needs them. As a lock, `BOB_SCHEMA_STRICT=1` turns `schema_behind` into a
503 on `/health`, so a platform that health-checks new deployments keeps the old
one serving until `supabase db push` has landed. Code that reads a new column
can also catch the undefined-column error and degrade the feature, as
`v2.conversation_flags_unavailable` does in `web-conversations.ts` (503
`feature_unavailable`). Strict mode is off by default.

### The `bob_server` password

The migration creates `bob_server` as `login nobypassrls` with **no
password** — the file comments "password set manually after db push". Set one
manually (Dashboard → SQL editor, or psql):

```sql
alter role bob_server password '<your-password>';
```

### Connection string (Supavisor session pooler)

The server reads `BOB_DATABASE_URL` and connects through Supabase's
Supavisor **session pooler** on port **5432** — the session-mode endpoint the
store needs because it keeps prepared statements on (`prepare: true`,
`apps/api/src/platform/db/db.ts`):

```text
postgresql://bob_server.<project-ref>:<your-password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Do not use port **6543**: that is transaction mode, which would need
`prepare: false`, and Supabase removed session mode on 6543 in 2025-02-28.

### One database engine everywhere

There is no stand-in database: development, the test suites and HIL run on the
local Supabase stack in Docker, production on hosted Supabase, all real
Postgres with the same migrations. Without `BOB_DATABASE_URL` the server
refuses to boot (exit 1, journal `v2.database_url_missing`) and says what to
do: run `npm run dev:offline`, or point the URL at the local stack.

### Offline local development (`npm run dev:offline`)

The full app — server, real Supabase (Postgres + auth) in Docker, Studio, and
the web client — runs with no internet except the AI
(`scripts/dev-offline.mjs`). Everything is loopback-only: the script refuses
any Supabase URL that is not `127.0.0.1`/`localhost`/`[::1]`, so it can never
touch the hosted project.

1. **Prerequisites:** Docker Desktop installed and running (`docker info` must
   answer), and the one-time `npm install`.
2. **Run it:** `npm run dev:offline` — it starts the local Supabase stack
   (API 54321, DB 54322, Studio 54323, Mailpit 54324), applies any migrations
   added since the volume was created, stores a per-machine `bob_server`
   password in the git-ignored `data/offline.env`, repairs `auth.users` rows
   with NULL token columns (one such row makes the auth admin API answer 500
   for the whole project), creates a confirmed dev user (`BOB_DEV_EMAIL`,
   default `dev@bob.local`), and runs `dev:all` against the stack with the
   REAL AI Gateway (`AI_GATEWAY_API_KEY` from `.env`). Add `--stub-ai` to stub
   the AI (`BOB_AI_STUB=1`) instead.
3. **Sign in:** the script prints a one-time code. Open the printed URL
   (`http://<lan-ip>:5173`, so a phone or another laptop works too), choose
   **"I already have a code"**, and enter `dev@bob.local` and the code. It is
   single use and expires in an hour; `npm run dev:offline -- --code` prints a
   new one without restarting anything. See "Signing in locally" below.
4. **Stop it:** Ctrl+C stops the dev servers; the Supabase stack stays up
   unless you also pass `--stop` (or run `npm run dev:offline -- --stop`).
   `npm run dev:offline -- --status` shows the stack.

### Signing in locally

Sign in with a **password**: `dev@bob.local` plus `BOB_DEV_PASSWORD` from
`data/offline.env` (gitignored, mode `0o600`). `npm run dev:offline` generates
it on first run, persists it, and re-applies it to the local dev user on every
start, so it survives restarts and database resets. `npm run dev:offline --
--regen-password` rotates it. The value is also exported as `BOB_DEV_PASSWORD`
into the dev-server environment. The script only ever prints the file location,
never the value.

The local email provider is **on** (`[auth.email] enable_signup = true` in
`supabase/config.toml`) so password grants work, while top-level `[auth]`
`enable_signup` stays `false` — no new account can self-register even locally,
and `scripts/invite-only.test.ts` pins that. The hosted project's overrides live under `[remotes.production]` and apply
only on a manual `supabase config push`.

A **one-time code** still works as a fallback: `npm run dev:offline` prints one
on start, and `npm run dev:offline -- --code` prints a fresh one. Both call
the LOCAL `POST /auth/v1/admin/generate_link` and show its `email_otp`; the
sign-in page's "I already have a code" step verifies it. No email is sent and
no redirect is involved, so `additional_redirect_urls` needs no LAN entry.

Signing in from another device on the LAN works because `dev:offline` sets
`BOB_PUBLIC_SUPABASE_URL=http://<lan-ip>:54321`: `/api/public-config` hands
the browser that address, while the server keeps verifying against the
loopback `SUPABASE_URL` — the issuer local Auth stamps into every token. The
Cardputer's pairing URL (`BOB_PAIRING_URL`) is the same LAN host on 5173;
plain `npm run dev` sets it too. On macOS 15+, the browser needs **Privacy &
Security → Local Network** permission, or LAN addresses fail with
`ERR_ADDRESS_UNREACHABLE`.

The data you land on comes from **`supabase/seed.sql`** (dev-only fixture,
re-applied by `npx supabase db reset`): the `dev@bob.local` account, a
`Home` group space and a `Private` space, one thread, four tasks covering
due-today / overdue / no-date / completed, two notes, and one upcoming
calendar event. Browse or edit it in Studio at `http://localhost:54323` —
the tables live under the **`bob`** schema, not `public`.

**Dev sign-in alternative (no Docker):** with `BOB_SYSTEM_TEST=1` on a
loopback bind, the server advertises `devSignIn: true` on `/api/public-config`
(`apps/api/src/account/auth.ts:232-249`) and mounts `POST /api/test-token`
(`server.ts:74-77`); the sign-in page then shows "Dev sign-in (local only)".
This mints a local test JWT — no real accounts, no Docker — and pairs with the
AI stubs (a `BOB_SYSTEM_TEST=1` run already stubs the AI).

## Telemetry

The backend is chosen only by `OTEL_*` variables; no provider is named in code
(model in `docs/observability.md`). Without an OTLP endpoint, tracing is a no-op.

- **Traces.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` (and `OTEL_EXPORTER_OTLP_HEADERS`
  when the backend needs auth) to any OTLP collector.
- **Logs.** The journal is JSON on stdout (`level`, `message`, `trace_id`,
  `span_id`); search it in your platform's log explorer.
- `BOB_OTLP_EXTRA_TRACES_ENDPOINT` / `BOB_OTLP_EXTRA_TRACES_HEADERS`: optional
  second destination for the same scrubbed spans. The header is a secret.
- `BOB_TRACE_PAYLOAD` / `BOB_DEBUG_PAYLOAD`: development-only payload capture.
  With `BOB_PRODUCTION=1` the server refuses to boot when either is `1` and
  journals `v2.payload_flag_error`, so never set them on a deployment.

## Spend control

Set a spend cap on the Vercel AI Gateway (AI Gateway → usage limits) so an
unexpected spike cannot run unbounded, and a usage limit on your host.

## Device firmware settings

In `apps/cardputer/include/secrets.h` (local firmware config, not git; copy
`secrets.example.h`):

```c
#define V2_HOST       "bob.example.com"
#define V2_PORT       443
#define V2_USE_TLS    1
#define DEVICE_SECRET "<the same DEVICE_SHARED_SECRET set on the server>"
```
