# Bob UI Catalog

Every ui-v2 screen and component as it renders, next to the Astryx component or template it uses or should use,
with the design findings and DRY/KISS/YAGNI flags behind each recommendation.

## What is here

- `registry.json` (generated, committed): every React component in `apps/ui-v2/src` with file, line, size,
  whether it is exported, the Astryx modules and local components it renders, and who renders it; plus every
  module in the installed `@astryxdesign/core` and where it is used. Built by `scripts/ui-catalog/registry.mjs`.
- `mapping.json` (curated, committed): findings, per-page proposals (screen states, matching Astryx templates,
  changes), per-component recommendations, and future templates.

The rendered catalog (`index.html` plus `img/`) is not committed: it is built into `data/ui-catalog/`.

## Build it locally

```bash
npm run dev:offline -- --stub-ai   # the stack first; leave it running
npm run ui:catalog                 # in another terminal
```

`npm run ui:catalog` (`scripts/ui-catalog/run.mjs`) checks the API and web server answer, seeds the demo family
(`npm run seed:demo`, idempotent), regenerates the registry, captures with Playwright
(`scripts/ui-catalog/capture.mjs`, signed in as the demo owner), and builds `data/ui-catalog/index.html`
(`scripts/ui-catalog/build.mjs`). It prints the path and a one-line summary.

- `--skip-astryx` skips the Astryx Storybook and template previews (an external site; captures are best effort,
  and a missing image shows as a placeholder).
- `BOB_CATALOG_WEB` and `BOB_CATALOG_API` override `http://localhost:5173` and `http://localhost:7444`.

## In CI

`.github/workflows/ui-catalog.yml` builds the catalog nightly and on demand (Actions, "UI catalog", Run
workflow) and uploads it as the `ui-catalog` artifact (2 days; an upload failure, e.g. a full storage quota, is non-fatal). It is not part of CI, so it never blocks a merge
or a deploy (#1031). A failed or timed-out nightly run opens one "Nightly UI catalog failing" issue, and the next
green run closes it. The registry check below still gates every merge.

## Keep it current

- A ui-v2 change that adds, removes, renames or rewires a component updates `registry.json`:
  `npm run ui:catalog:registry`. `npm run check:ui-catalog` (part of `npm run check` and validate) fails when the
  committed registry is stale, has fewer than 50 components or marks no Astryx module used, when a
  `mapping.components` key is not a registry component, or when a mapping page file does not exist.
- A change to what a screen should become updates `mapping.json`. Page `files` are relative to `apps/ui-v2`.
