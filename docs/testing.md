# Testing the api

`npx vitest run --root apps/api` runs the api suite (`npm run test:unit` is the same through npm).
Root `npm test` only typechecks. Run a subset with
`npx vitest run --root apps/api tests/<file>.test.ts`.

## The test database

Tests run on **real Postgres**: the local Supabase stack in Docker (`supabase_db_<project>`,
`127.0.0.1:54322`), the one engine development and HIL use too. The harness lives in
`apps/api/tests/support/`:

- `test-db.ts`: `createTestDb()` gives each test file its **own database**, connected as the
  production role `bob_server` (no RLS bypass). `addAccount` / `addSession` create auth rows
  through the `bob_private.ensure_test_session` definer. `withAdminAuth` is the only way a fixture
  may touch `auth.*` as the superuser. `asDb(testDb)` is the app's `Db` port over it
  (`setSharedDb(Promise.resolve(asDb(testDb)))` shares it with `getDb()`); it tracks every query
  until it settles, and `closeTestDb` waits for them before it drops the database. Importing it sets
  `BOB_DATABASE_URL`, when unset, to a loopback URL nothing listens on: the local-database gates
  (system-test sign-in, the dev account) pass, and a `getDb()` that bypassed `setSharedDb` fails
  loudly. `server.close()` on a `createV2Server()` server also drains its memory extraction worker.
- `pg-template.ts`: builds the migration-complete **template** that every per-test database is
  cloned from (`CREATE DATABASE ... TEMPLATE`), so migrations run once per checkout, not once per
  file.

### How the template is built

1. The name is `bob_tmpl_<hash>`. The hash covers the build recipe plus the name **and content**
   of every file in this checkout's `supabase/migrations/`. A branch that adds or edits a migration
   gets its own template, and never reuses another checkout's.
2. The Supabase-owned base schemas (`auth`, `storage`) are read from the live `postgres` database
   with a schema-only `pg_dump` (inside the db container, via `docker exec`). **That dump is
   read-only.**
3. Every migration file is replayed in order on top of that dump, in one `psql` session with
   `ON_ERROR_STOP`. A failure names the migration that broke.

The template never depends on which migrations the live database happens to have. The live
database is shared by every worktree on the machine, so it can be behind your branch (`relation
bob.timers does not exist`) or ahead of it (another branch's tables). The harness **never
writes** to the live schema: it does not run `supabase migration up`. If the stack is down it runs
`supabase start`. On a fresh volume that step applies the migrations as part of the stack's own
boot.

## Parallel runs

Many suites can run at once on one machine (several worktrees, several agents), and each suite
runs many vitest workers.

| Shared thing | How it is isolated |
| --- | --- |
| The template | `publishTemplate` holds a Postgres advisory lock keyed by the template name. The first process builds; the others block on the lock, then reuse the result. Different templates build in parallel. |
| A half-built template | The build happens in `<name>_build` and is renamed into place atomically, so the final name never exists before its schema does. A `_build` found while holding the lock is a dead builder's leftover and is dropped. A failed build drops its own `_build`. |
| Per-test databases | They are named `bob_test_<pid>_<rand>` and dropped on teardown. At startup each process drops leftovers whose pid is no longer running. It never drops a database a live run owns. |
| The `bob_server` password | It is one role for the whole cluster. The password lives in the **main checkout's** `data/offline.env` (`scripts/offline-env.mjs`), shared by all worktrees. The first writer creates it exclusively (`flag: 'wx'`). |

Tests themselves must not assume timing: await the promise you started (e.g. keep the
`processTurn` promise and `await` it) rather than `vi.waitFor` with its 1 s default. Under a full
parallel suite a real-Postgres turn can take longer than a second.

The harness's own guarantees are tested in `apps/api/tests/pg-template.test.ts` (hash, lock,
stale-build recovery) and `apps/api/tests/support/test-db.test.ts` (isolation, role, RLS,
teardown).

## Resetting

Templates are keyed by content, so old ones are never reused, but they are not deleted
automatically. To list what the harness owns:

```sh
docker exec supabase_db_Bob psql -U postgres -tAc \
  "select datname from pg_database where datname like 'bob\_t%' order by 1"
```

To reset, stop every running test suite first, then drop the templates and per-test databases (the
next run rebuilds its template in a few seconds):

```sh
docker exec supabase_db_Bob psql -U postgres -tAc \
  "select format('drop database if exists %I with (force);', datname) from pg_database
   where datname like 'bob\_tmpl\_%' or datname like 'bob\_test\_%'" \
  | docker exec -i supabase_db_Bob psql -U postgres
```

This touches only the harness's own databases. The live `postgres` database and its data are left
alone. If `password authentication failed for user "bob_server"` appears, make sure the main
checkout's `data/offline.env` exists and that no worktree holds a different copy that an old
harness might use.
