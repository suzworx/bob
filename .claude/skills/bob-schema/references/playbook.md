# Schema consolidation playbook

The migration steps for `bob-schema` Stage B, from #757 (PRs #784-#791). Each rule has its reason.

## 1. Snapshot first

- Write contract snapshot tests before any change (`apps/api/tests/contract/*`, file snapshots). Why: later units
  must leave every `.snap` byte-identical, which is the proof the fold changed no behaviour.
- Normalise uuids and times, and only the asserted sections. Why: over-normalising hides a real change.

## 2. Expand migration (`supabase/migrations/`)

- Additive only. Guard every touch of a table that may be absent with `to_regclass` (#230). Why: fresh and
  restored databases do not all have the same tables.
- Re-runnable backfill: `on conflict`, and fill only null columns. Why: the migration can run twice, and rollout
  writes land between the migration and the code switch.
- A `not null` column needs a default. Why: `scripts/migration-lint.mjs` rejects it otherwise.
- The timestamp sorts after the newest migration on base; merge units in timestamp order. Why: `migration up
  --include-all` and prod apply by name, so an older name skips or fails.

## 3. Security-definer functions

- `erase_account`, purges and clears: copy the NEWEST body verbatim and only add or remove the lines you need.
  Verify with a line diff against the newest body. Why: a stale copy silently drops a later fix.
- Old-table steps become guarded `execute`s (`to_regclass`). Why: the contract then needs no function rewrite.

## 4. RLS and membership

- Check membership with a trigger on the changing column, not in the update policy. Why: a stale pointer must not
  block unrelated writes to the row.
- A policy the old table had and the new home lacks (for example `revoked_at is null`) moves into the store's
  WHERE. Why: otherwise the fold widens access.

## 5. Store switch

- It ships with its expand, in the same PR. Why: an expand alone leaves the data unread, and a switch alone has
  no columns.
- Keep the function signatures. Why: callers and snapshots stay untouched.
- The shared row's writer upserts only its own columns. Why: a full-row upsert overwrites another writer's data.

## 6. Read filters before data moves

- Ship `kind = 'reminder'`-style filters on every reader of a table before any row of another kind lands in it.
  Why: the new rows would otherwise surface in the old feature.

## 7. Gates every unit runs

1. The unit tests.
2. `npx vitest run --config apps/api/vitest.integration.config.ts` (the integration config).
3. `git diff --exit-code origin/main -- apps/api/tests/contract/__snapshots__`.
4. The `.db` tests on the local stack after `npx supabase migration up --local --include-all`.
5. A CONTRACT (drop) unit runs the FULL `npm run test:db` locally, not a subset. Why: on #791 a `.db` test outside
   the subset (`isolation-matrix.db.test.ts`) still listed a dropped table and only CI caught it.

e2e fixtures (`apps/ui-v2/e2e/fixtures.ts`, `runLocalSql`) take exactly ONE SQL statement per call. Why: more
than one fails in the driver.

## 8. Worktree hygiene

- A worktree branched before another merge is rebuilt from `origin/main`: apply ONLY its own diff
  (`git diff <its base>`), then audit with `git diff origin/main --stat` for reverts. Why: a stale base silently
  reverts merged work.
- Run `npm ci` in every new worktree. Why: stale `node_modules` caused false failures.

## 9. Contract (the drop)

- Its own PR, with the `-- bob:contract <why>` line and the owner's approval.
- Confirm prod runs the expand code first: `https://api.heybob.xyz/api/version` reports `schema_status` ok. Why:
  dropping under running old code breaks it.
- Re-copy the rollout's writes before `drop table if exists`. Why: rows written by old code after the backfill
  would be lost.
- Remove the old-table steps from the definers.

## 10. Real-path proof

- `npm run accept:replay -- --only <scenarios>` against `npm run dev:offline`. Why: green units passed against a
  broken seam before.
- Device-facing tables also run the HIL subset: `node scripts/hil/run.mjs --scenario ...` (check the holders in
  [shared-hardware.md](../../bob-dev/references/shared-hardware.md) first).
- Stop only your own dev processes, by PID tree. Why: the machine is shared with other sessions.
