# API reference

Start the API and open `http://localhost:7444/docs` for the interactive HTTP reference, or fetch `http://localhost:7444/openapi.json` for the OpenAPI 3.1 document. The HTTP operations come from the server's mounted Express route inventory, so the reference changes with route registration. The Swagger UI JavaScript and CSS are served locally. Its **Authorize** button accepts a Supabase account access token for `/api/*` operations, while firmware downloads require a paired `olxd_` device token. Authorizing in the browser does not save the token across reloads.

The reference shows request schemas from the Zod validators and response schemas from shared contract DTOs and explicit handler mappings. Protected API calls still enforce the server's JWT, session, role, rate and ownership checks; opening the public documentation does not grant access. Local system-test `/api/test-token` returns 404 outside its loopback test configuration.

The separately deployed Supabase functions have a [read-only reference](api-edge-functions.md) at `/docs/edge` and a separate `/openapi-edge.json` document. The Cardputer `/v2/cardputer` endpoint upgrades to WebSocket and exchanges OLX2 binary frames, so it is not a callable HTTP operation in Swagger. See `apps/api/src/voice/protocol.ts` for its wire contract. Supabase Auth and PostgREST use their own provider contracts.
