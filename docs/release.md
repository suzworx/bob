# Releases

A release is a versioned GitHub Release that summarises the functionality that
landed on `main` since the previous release. Releases replace reading a stream
of PRs one by one: each release says what was added, fixed, and changed.

## Version rules

Versions follow [SemVer](https://semver.org/). The next version is derived from
the conventional commits since the last `vX.Y.Z` tag, highest bump wins:

| Commit | Bump |
| --- | --- |
| `type!:` or a `BREAKING CHANGE:` body | major (minor while major is `0`) |
| `feat:` | minor |
| `fix:`, `perf:`, `refactor:`, `docs:`, `revert:` | patch |
| `chore:`, `test:`, `ci:`, `style:`, `build:` | none |

With no tag, the first release is `0.1.0`.

A release is cut automatically: when a push to `main` passes CI, the `release`
job computes the next version, generates the notes, and creates the GitHub
Release with the firmware binary attached. CI never pushes commits back.

Main runs overlap (one per commit). When an earlier commit's run tags a release
after a later run has built its firmware, that firmware reports a version that is
already taken (#345), so the later run's `release` job skips with a notice instead
of failing, and the next `main` run releases those commits along with its own.
Likewise, if two overlapping runs compute the same version, the first to create
the tag wins and the other skips.

## Protected main

`main` should be protected by a GitHub ruleset that allows changes only via pull
request. Every change then reaches `main` through a pull request, and direct
pushes and force pushes are refused.

Branch naming is free; the PR title must be a conventional commit (the `pr-title`
check) because it drives the version bump. The `release` job is unaffected: it only
creates a tag and a GitHub Release with `gh release create`; it never pushes commits
to `main`.

To see or change the rule: GitHub → Settings → Rules → Rulesets, or
`gh api repos/<owner>/<repo>/rulesets`.

## Writing commits and PR titles

Commit subjects and PR titles must be conventional commits:

```
type(scope)!: description
```

- `type` is one of `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `chore`,
  `ci`, `build`, `style`, `revert`.
- `scope` is optional and lowercase, e.g. `feat(api):`.
- `!` marks a breaking change; an optional `BREAKING CHANGE:` body line does the
  same.
- The description is lowercase and imperative.

The `PR Title` workflow fails any pull request whose title does not match. The
release notes use the subject, the short sha, and a `#N` PR link when one can be
derived from a merge commit or a `(#N)` suffix.

## Previewing notes locally

```
node scripts/release/release-notes.mjs --preview
```

`--preview` prints the notes for commits not yet in a release. Without
`--preview`, notes are generated for the last tag..HEAD range. To see the
version decision as JSON:

```
node scripts/release/next-version.mjs --json
```

## Where releases live

Notes and the `firmware.bin` asset live on the repository's GitHub Releases
page. Download the firmware from the release that matches the version you run.

## Firmware updates

Today Cardputers are flashed over USB only. The release asset
`bob-cardputer-vX.Y.Z.bin` is the app image, and it is also the future
over-the-air payload. The design is decided in
[`docs/cardputer/ota-decision.md`](cardputer/ota-decision.md):

- **Delivery:** the device pulls a signed image over HTTPS from the API.
- **Channels:** `dev`, then `beta`, then `stable`, with a staged rollout.
- **Rollback:** the device rolls back on its own if the new image fails to reach `welcome` or fails its self-test.
- **Gate:** no firmware reaches `beta` or `stable` without a HIL attestation of that exact binary (#347).
- **Recovery:** USB with a web flasher.

None of this is built yet. See the record's "Follow-up work".

## Manual retry

If the automatic release step fails, retry it by hand: open the `CI` workflow
in the Actions tab, choose **Run workflow** on `main` (`workflow_dispatch`), and
let the `release` job run again.