# ADR 0002: Ports for the swappable seams

Status: **partly built** (SpeechPort #627/#661, AgentPort #662, ToolProvider registry and the inbox NotifyChannel #663; spike #627, epic #611; shapes platform epic #584). Owner review required.

AgentPort as built (#662): the port is a small factory over the agent objects the three callers already hold, not the `generate`/`stream` shape sketched below: `kind`, `base()`, `create(options)`, `createInvocation(options)`, `withOfferedTools(agent, tools)`. `selectAgentLive(() => agentConfigFromEnv(AI_STUB_MODE, scriptedStubAllowed()))` is built once in `createAppDeps()` and re-reads the scripted opt-in on every call, as the web chat always did (tests flip `BOB_AI_STUB` at runtime). The device turn (`TurnDeps.agent`), web chat (`AppDeps.agent`) and invocations (`agent` in the router deps, through a local structural type so `conversations` never imports `voice`) no longer check the stub flag. Adapters: real, canned stub, scripted stub. An eval adapter is not built (evals build agents through the real adapter's factories); the `generate`/`stream` unification stays open because `streamAgent` owns the stream loop.

## Context

A port is worth its ceremony only where an implementation is really swapped. Bob has four such
seams, all concrete imports today:

| Seam | Today | Swapped for |
| --- | --- | --- |
| AI agent | `@bob/ai` `createBobAgent` / `bobAgent` over the AI Gateway; stub mode is `if (AI_STUB_MODE)` in `turn.ts` (`runAgent`, `streamAgent`), `web-chat.ts`, `core/invocations.ts` (`createAgent = AI_STUB_MODE ? createStubAgent : createBobAgent`) | stub, scripted stub (#550), eval, live; model/provider changes (#394) |
| Speech | `audio.ts` -> `transcribeAudio` / `synthesizeSpeech` in `apps/ai/src/tools.ts`, which itself checks `AI_STUB_MODE` and `BOB_SYSTEM_TEST_REAL_TTS` | provider bake-offs, on-device or offline speech |
| Tools | five families, each a `bind*Tools` in `apps/api/src/core/` plus a `create*Tools` in `apps/ai/src/`, assembled by hand three times (`turn.ts` `buildTurnCapabilities`, `web-chat.ts`, `core/invocations.ts`) | #584: first-party and third-party apps on one model |
| Notify | `core/notify.ts` writes inbox rows through `enqueueNotifications`; the outbox worker (`outbox-module.ts`) fans out to email/push; device announcements go through `core/device-sessions.ts` | push for iOS, SMS |

Rules that apply to all ports: the `*-port.ts` files in `apps/api/src/voice/` hold interfaces and value types only, imports
nothing from `core/`, `store/`, `web-*.ts`, `session.ts`, `turn.ts` or `server.ts`, and adapters
live beside their port or in the module that owns the provider. Nothing in a port or adapter logs
audio, transcripts, agent text, credentials, URLs or prompts.

## Decision

### 1. One interface per seam (`apps/api/src/voice/*-port.ts`)

```ts
// speech.ts  (BUILT in this PR)
interface SpeechPort {
  transcribe(pcm: Buffer): Promise<SttResult>;        // PCM16 16 kHz mono in
  synthesizePcm(text: string): Promise<TtsResult>;    // PCM16 16 kHz mono out
  synthesizeMp3(text: string): Promise<TtsMp3Result>; // 16 kHz mono 32 kbps out
}

// agent.ts  (designed, not built)
interface AgentPort {
  generate(input: AgentInput): Promise<AgentOutput>;
  stream(input: AgentInput, onText: (delta: string) => void): Promise<AgentOutput>;
}
// AgentInput = { messages, tools, instructions, signal? }. AgentOutput = today's AgentResult
// (text, toolCalls, usage, finishReason, stub?). The port hides ToolLoopAgent and the Gateway.

// tools.ts  (designed, not built; section 3)
interface ToolProvider {
  manifest: ToolManifest;
  createTools(ctx: ToolContext): Record<string, Tool> | Promise<Record<string, Tool>>;
}

// notify.ts  (designed, not built)
interface NotifyChannel {
  readonly id: 'inbox' | 'email' | 'push' | 'device' | 'sms';
  send(notification: OutboundNotification): Promise<DeliveryOutcome>; // never throws
}
// DeliveryOutcome is core/notify.ts's existing delivered | muted | failed | none.
```

`AgentPort` deliberately mirrors what `turn.ts` and `web-chat.ts` already do with an agent, so the
first adapter is a wrapper, not a redesign. `NotifyChannel` sits **behind** the existing mute and
preference check and the outbox; it is the fan-out step, not the producer API (`notifyTaskAssigned`
and friends stay as they are).

### 2. Adapters that exist today, and where they are wired

| Port | Adapters today | Wired in |
| --- | --- | --- |
| Speech | provider (`createProviderSpeech`, `voice/audio/stt-tts.ts` over the Gateway), stub (`createStubSpeech`, same pipeline over a canned provider) | `app-deps.ts` -> `selectSpeech(speechConfigFromEnv(AI_STUB_MODE, process.env))` (built) |
| Agent | Gateway agent (`createBobAgent`), canned stub (`System test response: ...`), scripted stub (`createScriptedStubAgent`, refused when `BOB_PRODUCTION=1`) | `TurnDeps.agent`, chosen by `selectAgent(config)`; `web-chat` and `invocations` take the same port |
| Tools | the five first-party families (below) | a `ToolRegistry` built at boot, held in `AppDeps` |
| Notify | inbox rows (`enqueueNotifications`), email and push (outbox worker), device announcement | `AppDeps.notify: NotifyChannel[]`, iterated by the outbox fan-out |

**Composition root.** Today there is no `AppDeps`. `server.ts` wires globals and `turn.ts` reaches
for module imports. The PoC adds `turn-deps.ts`, whose `turnDeps` object is the only thing
`turn.ts` calls for STT and TTS. The issue text names `turn/deps.ts`; that file does not exist on
`main3` because the turn split (#620) has not landed. `turn-deps.ts` moves there with it. When
`AppDeps` exists it owns `createTurnDeps(...)`; the shape `{ stt, ttsPcm, ttsMp3 }` does not change.
Tests build `createTurnDeps(fake)` directly.

### 3. Stub mode becomes "wire the stub adapter"

The rule: **a flag is read in exactly one place per seam, at the composition root, and turned into
an adapter.** No call path tests a stub flag.

Speech (done): `speechConfigFromEnv(AI_STUB_MODE, env)` returns `{ stubStt, stubTts }`
(`BOB_AI_STUB` and `BOB_SYSTEM_TEST` stub both; `BOB_SYSTEM_TEST_REAL_TTS=1` keeps TTS real).
`selectSpeech(config)` returns the adapter. The stub adapter is `voice/audio/stt-tts.ts`'s pipeline over a canned
provider, so WAV wrapping, resampling, MP3 encoding and `audio.*` debug events are identical, and
a check against the old in-`@bob/ai` stub shows byte-identical PCM and MP3. The per-call env
knobs (`BOB_SYSTEM_TEST_TRANSCRIPT`, `BOB_SYSTEM_TEST_TTS_SECONDS`) are still read per call.

Agent (next): `selectAgent({ stub: 'off' | 'canned' | 'scripted' })` replaces the three
`AI_STUB_MODE` branches. `web-chat`'s `createSystemTestResponse` early return is the hardest case:
it bypasses the store entirely (contracts/chat-stream.md test 13), so the canned stub adapter must
be allowed to say "no persistence", or that branch stays and is called out.

Done (#661): the browser routes (`/api/voice`, `/api/speech`) call `SpeechPort.transcribeEncoded` /
`synthesizeEncoded` from `AppDeps.speech`, and the `AI_STUB_MODE` checks and the duplicated stub WAV
generator are gone from `apps/ai/src/tools.ts`. The stub now lives only in `ports/speech-adapters.ts`.

### 4. ToolProvider (what #584 needs)

```ts
interface ToolManifest {
  id: string;                    // namespaced, e.g. 'bob.timers' (first-party) or 'com.acme.flights'
  version: string;               // semver
  kind: 'builtin' | 'connector' | 'tool' | 'experience';
  scopes: ToolScope[];           // what it may touch; enforced by the registry, not by the model
  surfaces: ('cardputer' | 'web-chat' | 'web-voice')[];
  needs: ('memory' | 'space' | 'device')[]; // ctx pieces it requires; missing => provider is skipped, never throws
  order: number;                 // tool-list position, see below
}
type ToolScope = 'timers' | 'reminders' | 'tasks' | 'notes' | 'calendar' | 'memory'
               | 'device.control' | 'voice.query' | 'games' | 'space.read' | 'space.write';
interface ToolContext {          // one shape for every surface; replaces the three hand-copied builders
  db: Db; userId: string; spaceId: string | null; timeZone: string;
  surface: 'cardputer' | 'web-chat' | 'web-voice';
  device?: DeviceToolTarget; memory?: MemoryToolContext; signal?: AbortSignal;
}
```

A `ToolRegistry` holds providers; `registry.resolve(ctx)` filters by `surfaces`, `needs` and granted
scopes, calls `createTools(ctx)`, merges in `order`, and returns the tool set. `turn.ts`,
`web-chat.ts` and `core/invocations.ts` each call `resolve` instead of assembling tools.

How today's tools register (each provider wraps the existing `bind*Tools` + `create*Tools` pair,
with no change to the tools themselves):

| Provider id | Wraps | Scopes | needs |
| --- | --- | --- | --- |
| `bob.timers` | `bindTimerTools` + `createTimerTools` | `timers` | none |
| `bob.productivity` | `createProductivityTools` over `bindPrivateCallbacks` | `tasks`, `notes`, `calendar`, `reminders`, `space.*` | `space` |
| `bob.voice` | `bindVoiceTools` + `createVoiceTools` | `voice.query` | `space` |
| `bob.device` | `bindDeviceTools` + `createDeviceTools` | `device.control` | `device` |
| `bob.memory` | `createMemoryTools` | `memory` | `memory` |
| `bob.games` | `resolveGameScope` tools (an active game replaces the others; this is a registry rule, `exclusive`) | `games` | `space` |

`order` exists because the `cache-v1` prompt layout (#413) depends on tool position: timers first,
voice and device last after memory. The registry must reproduce today's order exactly, and a test
should pin it. The active-game rule (`keepForActiveGame`) needs an `exclusive` flag or a hook on the
provider; that is an open question, not solved here.

Third-party providers are out of scope for this ADR. #585 decides where their code runs (working
hypothesis: built-ins in-process, third parties as remote MCP). The port only has to be satisfiable
by an adapter that wraps an MCP client; it therefore returns AI SDK `Tool` records, which
`@ai-sdk/mcp` already produces. #586 decides datamarking, the data-flow policy and description
pinning; those are registry-side checks on `resolve` output, and no field is reserved for them here.

### 5. Migration order (each step is its own issue, no behaviour change)

1. `SpeechPort` (this PR). 2. Move `web-voice.ts` onto it and drop the stub branches in `@bob/ai`.
3. `AgentPort` + `selectAgent`. 4. `ToolProvider` + registry with the five first-party providers
(this is #587). 5. `NotifyChannel` with inbox and email adapters, then push.

## Decisions the owner must review

1. **Port location.** Interfaces in `apps/api/src/voice/*-port.ts`, not `apps/ai`, because adapters need the
   api's `Db`, journal and session types. `apps/ai` stays free of `apps/api` (boundary rule 5).
2. **Stub is an adapter, and it lives in `apps/api`**, duplicating the small stub WAV generator for
   now. The alternative (keep stubs in `apps/ai`) leaves the flag checks inside the provider call.
3. **Config is read once, at load**, in `turn-deps.ts` (`AI_STUB_MODE` is already load-time). Tests
   that need a different mode inject an adapter through `createTurnDeps`.
4. **`TurnDeps` is a flat set of functions** (`stt`, `ttsPcm`, `ttsMp3`), not the port object, so
   `turn.ts` call sites and their test mocks change by one identifier.
5. **`ToolProvider` returns AI SDK `Tool` records** and takes a single `ToolContext`; scopes are
   declared in the manifest and enforced by the registry.
6. **Ports are for these four seams only.** No port for the database, clock or logger.

## Not decided

- Where third-party tool code runs, and MCP as-is or as a profile (#585).
- Threat-model mechanisms: datamarking, cross-app write policy, description hashing, consent (#586).
- The manifest schema for app packages (#588): `ToolManifest` above is the in-process subset and
  will be replaced by, or embedded in, it. Field names are provisional.
- The `AgentPort` shape for streaming with tool-call events, and whether the web chat's
  `createSystemTestResponse` early return becomes an adapter or stays.
- How `exclusive` (active game) and `cache-v1` ordering are expressed in the registry.
- Whether `NotifyChannel` gets per-channel user preferences, quiet hours or a retry contract; today
  those live in `store/notifications.ts` and the outbox.
- Per-tenant or per-space adapter choice. Adapters are process-wide here.
- Anything about the `turn.ts` split (#620) beyond the location of `turn-deps.ts`.

## Proof of concept (this PR)

`voice/speech-port.ts` (interface), `voice/speech-adapters.ts` (provider and stub adapters,
`speechConfigFromEnv`, `selectSpeech`), `turn-deps.ts` (composition root), `audio.ts` (pipeline
functions gain an optional provider argument that defaults to today's), `turn.ts` (five call sites
now use `turnDeps`). Tests: `apps/api/tests/voice/speech-port.test.ts`. Journal events are unchanged.
**Not verified:** a real Cardputer turn and a real web voice turn with the real adapter; only the
unit and integration tests were run.

## Update at landing (2026-09-29)

The layout this ADR was drafted against changed under it (epic #611): the turn split (#617), `AppDeps` (#618) and the voice module (#626) all landed first. So the proof of concept is wired differently from the text above: there is no `turn-deps.ts` singleton. `TurnDeps` (`voice/turn/deps.ts`) already carries `stt` / `ttsPcm` / `ttsMp3`, and `createAppDeps()` fills them from the selected `SpeechPort` (`selectSpeech(speechConfigFromEnv(AI_STUB_MODE, process.env))`, read when `AppDeps` is built). The port lives at `voice/speech-port.ts` and its adapters at `voice/speech-adapters.ts`.

Follow-ups (filed as issues): the web voice route onto `SpeechPort` and removal of the stub branches inside `@bob/ai`; `AgentPort` and `selectAgent`; the tool-provider registry and `NotifyChannel`.

## Update at landing of #663 (2026-09-30): ToolProvider registry and NotifyChannel

Built, behaviour unchanged. Status of the four ports: SpeechPort built (#627); ToolProvider registry built (this update); NotifyChannel built for the inbox (this update); AgentPort still designed only.

- **Tools.** `voice/tool-registry.ts` holds `ToolProvider<Ctx>` (`id`, `scopes`, `slot`, `order`, `needs`, `createTools`) and `createToolRegistry`. The context type is a parameter, so the device/web difference in how device tools bind stays explicit in `FirstPartyToolContext.device` (calling device on a turn, every connected device on the web, absent when none). `slot` (`early` / `late`) carries the cache-v1 layout (#413): timers lead, voice then device follow memory. `resolveSync` exists because `webTurnTools` and the turn assembler are synchronous callers. First-party providers `bob.timers`, `bob.voice`, `bob.device` are in `voice/tool-providers.ts`; `turn/tools.ts` and `conversations/chat/tools.ts` resolve through them. Productivity, memory and game tools are NOT providers yet: they resolve a Space or a game scope asynchronously first and the active-game (`exclusive`) rule is still open. `invocations` builds no tool set of this kind. Nothing changed in `app-deps.ts`: the registry is module level, not an `AppDeps` field.
- **Notify.** `notifications/notify.ts` holds `NotifyChannel`, `DeliveryOutcome` and `deliverThrough` (first channel is primary; the rest are best effort and never fail the delivery) and `createInboxChannel`, the mute check plus enqueue and the only adapter so far. Email is not a separate adapter: it rides the same enqueue as an outbox event handled by `createEmailNotificationHandler`. Device announcements are not a `notify.ts` path (they go through `DeviceSessions`). Push and SMS remain to be added as adapters. The port lives in `notifications/`, not `voice/`, so notifications does not import the voice folder.
