# Bob diagrams

Hand-maintained Mermaid diagrams of the system, grouped by app. GitHub renders
Mermaid fenced code blocks natively — there are no image files, no build step,
no dependency.

| File | Covers |
|---|---|
| [api-hld.md](api-hld.md) | `@bob/api`: the `/v2/cardputer` WebSocket route, the `/api/*` HTTP surface, the JWT guard and which routes sit outside it, the session state machine, the store, and where the AI layer is called. |
| [ai-hld.md](ai-hld.md) | `@bob/ai`: `ToolLoopAgent`, the AI Gateway provider, and the three tool groups (base, memory, productivity), including how they reach the agent per-turn via `createBobAgent`. |
| [ui-hld.md](ui-hld.md) | `@bob/ui-v2`: the app shell, the routes, the auth gate, and the two input paths (text and voice). |
| [data-model.md](data-model.md) | Storage refactor (#756): the current two-store message design, the planned unified conversation model with space-scoped memory and unchanged API contracts, and the migration phases. |
| [cardputer-hld.md](cardputer-hld.md) | The Cardputer firmware: capture, the OLX2 frame codec, playback, the `state.h`/`types.h` state machine, and pairing/follow-me wiring. |
| [workflows.md](workflows.md) | SEQUENCE diagrams for the flows that matter: device voice turn, web text turn, web voice turn, device pairing, cross-session memory, and sign-in. |

## Regenerating

These diagrams are **hand-maintained**. When you change the code they
describe, update the matching diagram in the same change — the wire names,
route paths, and event names must stay exactly what the code emits. There is
no generator; verify each Mermaid block parses before merging.

Linked from [docs/architecture.md](../architecture.md) and the repo
[README](../../README.md).