# Hosting the web app separately

By default the API server serves the built web client (`apps/ui-v2/dist`) on the same host
([deploy.md](deploy.md)). This page covers hosting `apps/ui-v2` as a separate static site on
Vercel instead, with `/api/*` proxied to your API server.

## Project settings

Create a Vercel project connected to this repository with Root Directory
`apps/ui-v2`. Enable **Include source files outside of the Root Directory in the
Build Step**. Keep the repository root lockfile: the configured install command
runs `cd ../.. && npm ci`, while `npm run build` runs from the app root and emits
`dist`. Do not use the repository root build command, which includes firmware.

Set `BOB_WEB_BRAND=bob` in the project's build environment. The setting is public
and supplies crawler metadata before JavaScript runs. The app-local `.env.example`
shows the optional development setting. An unset value leaves HTML unchanged for
the server's host-aware metadata. No Supabase service key or other secret belongs
here.

The ordered routes in `apps/ui-v2/vercel.json` send `/api/*` to your API server
with no caching; point that destination at your own API host. Supabase public
configuration still comes from `/api/public-config`. Existing files are served
normally; missing assets return 404 and application deep links receive uncached
HTML. Device WebSockets connect to the API server directly.

## Verification before switching domains

Build, then deploy a preview. Verify root and nested navigation, deep-link
refresh, static assets and missing-asset 404s, metadata without JavaScript, and
direct `index.html` cache headers. Confirm API query strings, authorization
headers, POST bodies and streaming with an authorized test account. Local routing
tests are configuration checks, not proof of Vercel's deployed proxy behavior.

Before assigning production domains, verify Supabase redirect allowlists,
sign-in/password reset, streaming chat, device coexistence and HTTPS. Roll back
by restoring the previous domain mapping.

References: [Vercel monorepos](https://vercel.com/docs/monorepos) and
[monorepo FAQ](https://vercel.com/docs/monorepos/monorepo-faq).

## Frontend releases and source maps

A Vercel build uses its public `VERCEL_GIT_COMMIT_SHA` as the frontend release.
`BOB_WEB_RELEASE` is an explicit override for other builders or reproducible
rebuilds; only lowercase Git SHAs (7 or 40 characters) are accepted and normalized
to seven characters. This identifier is compiled into the browser's RUM/log SDK
version and the `bob-web-release` HTML meta tag. It takes precedence over the
backend's public-config version. With neither build input, the backend-version
fallback applies. RUM still requires the public config; this setting does not
turn monitoring on or expose any server credentials.

Production builds must leave `BOB_SOURCEMAP` unset: hidden source maps still exist
as files and Vercel would serve them if deployed.

A frontend that fails before RUM loads needs an independent check: verify the
frontend HTML release, every entry asset, and a deep link, separately from backend
`/api/version` health.
