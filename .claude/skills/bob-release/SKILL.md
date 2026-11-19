---
name: bob-release
description: "Bob release stage. Use to commit, open a PR, merge, ship or release Bob work: small commits by objective, a PR to the base branch, attestation, watching CI, squash-merge when green and validated, closing stories, and the release checks."
---

# Bob: release

Load `bob-dev` first. You need a unit that passed `bob-validate` and `bob-review`.

## Load these skills

- `commit`: split the changes into small commits, one per objective, with `feat:`/`fix:`/`docs:`/`test:`/`chore:`.
- `gh-cli`: take the PR from opened to merged under the base branch's ruleset.
- `resolving-merge-conflicts` if the branch conflicts with the base branch.

## Steps

1. Commit in small commits by objective (`commit` skill). Never commit `.env`, keys, prompts, audio or PII.
2. Push the branch and open a PR to the base branch ([facts.md](../bob-dev/references/facts.md#branches):
   `gh pr create --base main`), filling in `.github/pull_request_template.md`: what changed, why, the
   issue, and the verification (commands, exit statuses, one number each).
3. Optionally attest after the push: `npm run attest`, and `node scripts/device-attest.mjs` after a firmware
   HIL pass ([shared-hardware.md](../bob-dev/references/shared-hardware.md)).
4. Watch the PR until CI is green and review comments are answered.
5. Squash-merge once CI is green and the change is validated and reviewed. Ask a maintainer first if it
   touches data, secrets, auth or a destructive migration.
6. Close a story only when every acceptance item has passed on the real path. Otherwise leave it open and
   say what is owed.

## Releases

- `npm run release:check` before cutting a release or deploying.
- `/deploy-ready` (`.claude/commands/deploy-ready.md`) for a GO / NO-GO verdict.
- A merge to `main` cuts a firmware release from CI (`.github/workflows/ci.yml`, job `release`).

## Done when

- the PR is squash-merged with CI green;
- stories are closed only with every acceptance item passed.
