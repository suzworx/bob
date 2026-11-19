# Bob SOP: one unit of work, start to finish

The standard operating procedure for one unit of Bob work. Follow it in order; each step names the check
that ends it. Facts (branches, scripts) stay in [facts.md](facts.md); don't copy them here.

## 0. Start (read-only)

1. Re-read [facts.md](facts.md) "Branches". Work in a branch (or worktree) off the base branch.
2. Load the stage skill and the skills the task needs; run `find-skills` for anything new.
3. Check who holds :7444, :7454/:5183 (e2e stack) and the device serial port before starting anything.
   Stop only processes you started, by PID, never by name.

## 1. Plan

1. **Probe first.** Write or run the check that shows the defect *before* changing code. It must fail now.
2. **Enumerate every surface the change touches**, not only the obvious ones (every route component, not
   just the paths in `routes.ts`). A check that skips a surface lets the defect ship there.
3. **Check the library API exists before relying on it.** For Astryx, read the `.d.ts` / `dist` source in
   `node_modules/@astryxdesign/core`.
4. One unit per disjoint set of files; owns list every file the unit may touch, including generated
   catalogs (`ui-action-catalog.json` x2, `docs/ui-v2/ux-catalog/registry.json`) for any UI callback change.

## 2. Implement

1. For delegated work, write a work order from [brief-template.md](brief-template.md): owns, gates, skills,
   KISS/YAGNI/DRY, the write rule, "STOP and report with file:line if X is impossible".
2. Red test first (`tdd`), then the change, then the work order's gates.
3. Last gates: `npm run check:unit-gates`, then `git diff --check`.

## 3. Review

1. `bob-reviewer` (or the checklist by hand) on the diff. Look hard at new assertions: a regex or
   selector that can never match passes vacuously.
2. Drive the real app yourself and screenshot it (for phone UI: the mobile gate with
   `BOB_MOBILE_SWEEP_DIR=<dir>`).

## 4. Integrate and PR

1. After any UI callback change, regenerate the catalogs:
   `npx tsx apps/ui-v2/scripts/generate-ui-action-catalog.ts` and `npm run ui:catalog:registry`.
   A stale registry fails `ui-coverage.test.ts` inside `validate`.
2. `npm run validate` passes. Use the gate commands for subsets; ad-hoc `vitest --root apps/ui-v2`
   misses the workspace setup and shows false failures.
3. Push and open the PR against the base branch, using `.github/pull_request_template.md`.

## 5. Merge and close out

1. Squash-merge once CI is green and review findings are fixed.
2. Comment on the issue with what shipped and the squash sha; close it when every acceptance item passed.
3. Stop your servers (by PID) and remove your worktrees.

## Why each rule exists

| Rule | What it cost when skipped |
| --- | --- |
| Enumerate every route component | A phone check skipped one route and the defect shipped there |
| Check the library API first | A plan asked for a component API Astryx does not expose; a wasted round |
| Regenerate catalogs on integration | `validate` failed on `ui-coverage.test.ts`; an extra validate run |
| Stop servers by PID | Orphan dev servers kept :7444 and blocked the next stack |
