---
name: bob-schema
description: Bob schema consolidation. Use to consolidate, merge, fold or denormalize tables, plan a schema refactor, drop a table, write an expand/contract migration, or dry run a schema change before any migration is written (Supabase Postgres, supabase/migrations).
---

# Bob: schema consolidation

Load `bob-dev` first. Stage A writes nothing; Stage B ships through small units of work.

## Load these skills

- `bob-plan` (Stage B briefs), `supabase-postgres-best-practices`, `dry-run-gate`.
- The rule: prefer composition and denormalization ([agent-contract.md](../bob-dev/references/agent-contract.md)).
  A new table needs a stated reason: a real one-to-many with its own lifecycle, RLS through
  `bob_private.is_space_member`, an `on delete cascade` that erasure depends on, or a queue. User references stay
  rows, never JSONB or arrays.

## Stage A: dry run (read-only, no edits)

1. Inventory every current table from `origin/main` migrations: create minus drop
   (`git ls-tree -r --name-only origin/main -- supabase/migrations`, then `git show origin/main:<path>`).
2. Per table record: owner, cardinality, readers and writers, RLS, FKs and the cascades erasure needs, and prod row
   counts when the owner supplies them.
   - Find readers and writers with `git grep` over `apps/api/src`, `tests/integration`, `tests/scenarios`,
     `apps/ui-v2/e2e` and `scripts`. Grep the BARE table name too: code builds names like `bob.${table}`.
3. Classify each candidate with the patterns below.
4. Output one ranked table: tables, target shape, evidence (file:line), blockers, size, verdict (do / maybe / no).

Done when every table is in the inventory with a verdict, and every verdict cites file:line evidence.

## Consolidation patterns

| Pattern | Use when | Not when |
| --- | --- | --- |
| (a) One row per owner becomes columns on the owner row or `bob.user_state` | the data is 1:1 with the owner and read with it | the row is written on a hot path the owner row also serves (contention), or it has its own RLS audience |
| (b) Same concept becomes one table plus a `kind` column with kind-scoped checks | the rows share a lifecycle and shape (reminder, timer, alarm) | the kinds need different RLS, retention or required columns |
| (c) Sibling link tables become one table with typed nullable FKs (`event_id`, `task_id`, `reminder_id`) and `check (num_nonnulls(...) = 1)` | the links point at different parents. Real FKs and cascades are KEPT | the parent set is open-ended. Unenforced polymorphic `resource_type/resource_id` stays out (#757 and the 014 LLD rule it out) |
| (d) 1:1 side table becomes columns on the parent | the side row never outlives the parent. Keep a public id column if the side id is in an API contract | the side table has its own RLS or is large and rarely read |
| (e) Dead table is dropped | no reader or writer remains in the inventory, and the owner approves | any code, test or script still names it |
| (f) JSONB document column | a group of fields belongs to one row, is read and written as a whole, holds NO references to other rows (above all no user ids), needs no per-field FK, unique or cascade, and is validated by a Zod schema at the API boundary. Back it in the database with a CHECK on shape: `jsonb_typeof(col) = 'object'`, required keys via `col ?& array[...]`, a bounded `pg_column_size`. Index what you query with a GIN index or an expression index `(col->>'key')`. Bob examples: recurrence rules (`reminders.rrule` already is), recurrence exceptions on an event, per-game state, provider metadata, sparse optional settings that would otherwise add many nullable columns | it holds user or row references (cascade lost; erasure breaks), the database must enforce per-field constraints or uniqueness, one key is updated hot by many writers (the whole value is rewritten), or the fields are filtered or sorted on in most queries (use columns) |

`pg_jsonschema` is not used: plain CHECKs need no extension and cover the shape checks above.

Anti-patterns:

- REFERENCES in JSONB or arrays (user ids, row ids): the `on delete cascade` is lost, so erasure leaves orphans.
  Reference-free documents are fine, see row (f).
- Folding tables with different RLS audiences, for example actor-only provenance such as `publications`.
- Folding into a hot row that many writers update.

## Stage B: plan and ship

Follow [references/playbook.md](references/playbook.md); each lesson there is a rule with its reason. Name these
units, one objective each, with `needs:` in this order:

1. Snapshots: contract snapshot tests on current behaviour.
2. Expand, with backfill and security-definer copies. The store switch ships in the SAME PR as its expand.
3. Read filters (`kind = ...`) before any data moves into a shared table.
4. Contract (the drop) as its own PR, with a maintainer's approval.

Done when the contract PR is merged and the playbook's real-path proof has passed.

Previous stage: `bob-plan`. Next stages: `bob-develop`, then `bob-validate`, then `bob-release`.
