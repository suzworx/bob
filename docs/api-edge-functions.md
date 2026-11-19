# Supabase Edge Function API

The [OpenAPI document](../apps/api/src/web-edge-api-docs.json) covers the four first-party functions in `supabase/functions/`. They are deployed at `https://<project-ref>.supabase.co/functions/v1` and run separately from the Express API. Open `/docs/edge` for the read-only Swagger UI, or fetch `/openapi-edge.json` from the API server. Set the `projectRef` server variable to the target Supabase project before using another OpenAPI viewer.

| Function | Caller | Authentication |
| --- | --- | --- |
| `POST /waitlist` | Public waitlist page | None; the function applies its own body and abuse limits. |
| `POST /invite-account` | Bob API | `Authorization: Bearer <NOTIFY_EMAIL_SECRET>` |
| `POST /notify-email` | Bob API | `Authorization: Bearer <NOTIFY_EMAIL_SECRET>` |
| `POST /send-email` | Supabase Auth Send Email Hook | Standard Webhooks `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers over the raw body. |

`verify_jwt = false` for all four functions in `supabase/config.toml`; that setting does not make the three service endpoints public. The API service bearer and Auth hook signing secret belong only to their callers. The `send-email` payload contains sign-in codes and links, so its examples and logs must never include live values.

The three service operations are for server callers. `/docs/edge` disables Try it out; browser requests are not their intended call path.

The OpenAPI document describes callable HTTP operations. Supabase Auth and PostgREST are vendor APIs with their own contracts, and the Cardputer WebSocket uses the OLX2 protocol in `apps/api/src/voice/protocol.ts`.
