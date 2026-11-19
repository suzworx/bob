# Assistant name selected on Cardputer

The wake-word setting also chooses the assistant's spoken name: Bob selects
Bob; Bob and the legacy Alexa choice select Bob. This is a presentation
preference, not a separate agent, permission set or account identity.

Firmware advertises `assistant_name` in hello. A supporting server acknowledges
`welcome.payload.assistant_name: true`. Only then does firmware include
`turn_start.payload.assistant_name`, restricted to `bob` or `bob`. Older
servers receive the existing empty payload, and older firmware defaults to
Bob without an explicit selected-name instruction, preserving conversational
nicknames on existing devices. Every welcome refreshes negotiation, including reconnects to older
servers.

Push-to-talk, wake and follow-up turns use one builder and snapshot the current
setting when the turn opens. The server pins the mapped name for that turn;
changing a setting cannot rename a reply already in progress. Each new turn
supplies its selection again, so neither a previous Bob turn nor another
device changes the default for this one. Nothing is stored in the account or
conversation, and web chat keeps its existing identity behavior.

Core accepts a typed assistant-name preference, with no knowledge of the
Cardputer, wire fields or wake model. It applies the name consistently to its
base instructions and the final per-turn context. Older conversation history
does not override the selected name, and the assistant should not argue about
a nickname or claim that calling it Bob changes a device setting.

The name also picks the spoken voice. A Bob session's replies, streamed
sentences and announcements use `BOB_TTS_VOICE_BOB` (default `en-US-Sage`,
the humble male voice the owner chose); Bob or no name keeps
`BOB_TTS_VOICE` (default `en-US-Harper`). The TTS cache keys by voice and a
speech-asset pack only serves its own voice, so Bob never plays Harper audio.

## Verification status

Offline regressions cover allowlisted values, capability negotiation, old
clients, reconnect/default isolation, sequential name changes, the Core
factory options and its prepared request. Firmware host tests cover both
wire names and omitted fields for older servers. These checks prove wiring,
not that every live model response follows the instruction.

Capability setup failures retry a minimal agent with the selected name. If
the agent factory itself cannot construct even that minimal agent, the existing
shared singleton remains the final safety fallback and may use the default
name. This exceptional path is not a guarantee of selected-name compliance.

No billed model evaluation is authorized without freshly verified budget
headroom. The backend can deploy independently; existing firmware omits the
preference and keeps conversational nickname handling. Combined firmware HIL,
installation and a spoken Bob/Bob switch check remain pending. Do not claim
a device setting reaches Core until supporting firmware is installed and its
physical switch is verified. Keep private Bob model weights out of public builds.
