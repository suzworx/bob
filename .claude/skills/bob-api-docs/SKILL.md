---
name: bob-api-docs
description: Maintain Bob Swagger and OpenAPI documentation when HTTP routes, schemas, authentication, or Supabase Edge Functions change.
---

# Bob API docs

The HTTP reference is generated, not hand-written: `http://localhost:7444/docs` (Swagger UI) and
`/openapi.json` come from the mounted Express route inventory, with request schemas from the Zod
validators and response schemas from the shared contract DTOs (`apps/api/src/platform/http/api-docs.ts`).
The Supabase Edge Functions have their own read-only document, `apps/api/src/web-edge-api-docs.json`,
served at `/docs/edge` and `/openapi-edge.json`.

When a change touches HTTP routes, schemas, authentication or an edge function:

1. Keep every new or changed route's request validator a Zod schema, and give its response a DTO or an
   explicit handler mapping so the reference shows it.
2. Update `apps/api/src/web-edge-api-docs.json` when an edge function's request, response or auth changes.
3. Update the prose in `docs/api.md` and `docs/api-edge-functions.md` when behaviour a caller relies on changes.
4. Start the API (`npm run dev:offline -- --stub-ai`) and open `/docs` to confirm the change renders.
5. Run the API docs tests with the rest of `npm run test:unit`.
