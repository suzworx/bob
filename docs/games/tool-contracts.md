# Games epic (#460): engine and tool contracts

Games follow the same pattern as `apps/ai/src/timer-tools.ts` and `voice-tools.ts`:
- `tool()` with a strict Zod `inputSchema` and `outputSchema`, over **injected callbacks**. apps/ai
  owns no SQL.
- apps/api binds the callbacks to one account, one conversation and one device. No input names an
  account, a game session or a player's age.
- A rejected callback becomes `{ ok: false, reason, say }` and is never thrown.
- **No phrase rules.** Nothing matches the transcript. The model picks a tool from its description,
  and the server decides everything else: scores, turns, whether an answer is correct, and when a
  game ends.

## 1. Engine

**Modules.**
- `apps/ai/src/games/engine.ts`: pure types plus `GameDefinition`.
- `apps/ai/src/games/<game>.ts`: a pure reducer, its tools and its content pack.
- `apps/api/src/core/game-store.ts`: SQL under `withUser`.
- `apps/api/src/core/game-tools.ts`: binds the callbacks and picks the scope.

```ts
interface GameDefinition<S> {
  id: GameId; bands: Band[]; minPlayers: number; maxPlayers: number;
  init(opts: StartOptions, rng: Rng): S;                     // pure
  view(s: S, players: Player[]): GameView;                   // pure, drives both screens
  tools(cb: GameCallbacks<S>): Record<string, Tool>;         // only while this game runs
}
type GameId = 'animal_riddles' | 'simon_says' | 'family_quiz' | 'twenty_questions' | 'silly_stories';
type Band = 'little' | 'kid' | 'grown';
```

Reducers are pure, and all randomness comes from `mulberry32(seed)`, with the seed stored in the
row. Replay is therefore the same seed plus the same actions, which gives both the test oracle and
"play again, same questions".

**State**, in table `bob.game_sessions` (migration, RLS by `user_id`): `id uuid`, `user_id`,
`conversation_id` (required), `device_id` (null on web), `game`, `status active|paused|ended`,
`seed int`, `players jsonb`, `turn_index int`, `scores jsonb`, `state jsonb` (per game, validated
by that game's Zod schema on every read), `version int` (optimistic lock; every write is
`where version = $n`), `started_at`, `last_turn_at`, `ended_at`, `end_reason`.
- A partial unique index allows one non-ended game per conversation.
- `players` holds `{ name (1..20, first name or nickname), band, team? }`. It is deleted on end:
  `players` is set to `[]` and the scores are kept by position only (safety.md S3).

**Lifecycle and timeouts** (applied lazily on the next turn, so no scheduler is needed):
- active → paused after **10 min** without a game turn, or on `pause_game`.
- paused → ended after **24 h**.
- Once the daily limit is reached, `end_reason='time_limit'` (safety.md).
- Silence within a turn follows the D5/D6 rule in conversational-loop.md: after 2 silent drops the
  device closes the mic, and the game stays active until the 10 min pause.

**Scope.** In `buildTurnCapabilities` (`apps/api/src/turn.ts`) and the web chat equivalent, the
server reads the conversation's non-ended game first:

| state | game tools the model sees | other tools |
| --- | --- | --- |
| no game | `start_game`, `list_games` | all normal tools |
| paused game | `start_game`, `list_games`, `resume_game`, `stop_game` | all normal tools |
| active game | engine controls plus **that game's tools only** | `currentDateTime`, `set_volume`. **No** memory, notes, search, inbox, reminders or productivity tools (safety.md S3) |

A game turn needs at most 2 tool calls. That fits `BOB_MAX_AGENT_STEPS = 6` in
`apps/ai/src/agents.ts`. The per-game host notes ride in the tool output, not in the system prompt,
so `BOB_AGENT_INSTRUCTIONS` stays byte-stable for the cache-v1 layout.

**Shared output.** Every game tool returns one of two shapes:

```ts
const gameViewSchema = z.object({
  game: gameIdSchema, title: z.string().max(20), status: z.enum(['intro','prompt','feedback','between','ended','paused']),
  line1: z.string().max(40), line2: z.string().max(40).optional(),        // big text on the device
  icon: iconIdSchema.optional(),                                           // enum of bundled 48x48 sprites
  turn: z.string().max(20).optional(),                                     // whose turn, by name
  scores: z.array(z.object({ name: z.string().max(20), points: z.number().int() })).max(6),
  progress: z.object({ n: z.number().int(), of: z.number().int() }).optional(),
  hints: z.object({ used: z.number().int(), of: z.number().int() }).optional(),
}).strict();
const gameOkSchema = z.object({
  ok: z.literal(true),
  say: z.string().max(600),          // speak this, reworded freely; facts and results never change
  speak_verbatim: z.boolean(),       // true: content that must be read as written (story, riddle)
  expect_reply: z.boolean(),         // true: the device opens the mic after playback (D6)
  host_notes: z.string().max(300).optional(), // what to do next, e.g. "wait for their guess"
  view: gameViewSchema,
}).strict();
const gameErrSchema = z.object({ ok: z.literal(false), say: z.string().max(200),
  reason: z.enum(['no_game','wrong_game','not_allowed','time_limit','quiet_hours','bad_input',
    'not_your_turn','stale','store_down']) }).strict();
```

**Engine tools.** Every input below is a `z.object({...}).strict()`.

| tool | input | behaviour |
| --- | --- | --- |
| `list_games` | `{ band?: Band }` | Games allowed for this account and band, each with a one-line pitch |
| `start_game` | `{ game: GameId, players?: {name,band?}[] (0..6), teams?: boolean, band?: Band, options?: { category?: 'animal'\|'food'\|'object'\|'place'\|'character', theme?: StoryTheme } }` | Checks the parental settings, the time limit and quiet hours. With no players it is one player at the account's max band. A running game in this conversation must be stopped first (`reason:'not_allowed'` plus a `say` offering to stop it) |
| `pause_game` / `resume_game` | `{}` | Resume replays the current prompt |
| `stop_game` | `{ }` | Ends the game and reads the scores. "Stop" and "I'm done" are the model's call, not a phrase rule |
| `game_status` | `{ repeat?: boolean }` | Whose turn it is and the score; `repeat` re-reads the current prompt |
| `play_again` | `{ same_players: boolean }` | Only right after the end. A new seed; `same_players` keeps the names |

**Turn order.** `players[turn_index]` holds the turn, and the engine advances it after each scored
action. A game tool that accepts `player` compares it with the turn holder:
- Simon Says and a quiz steal accept any player.
- Everything else returns `not_your_turn` with a `say` such as "That's Maya's turn, Leo you're next!"

**Voice ID (#461, later).** `GameCallbacks.speaker()` returns the recognised `name | null` from the
turn context. The server sets it, and it is never a model input. When it is non-null it wins over
`player`.

## 2. Launch game tools

**Animal Riddles** (`apps/ai/src/games/animal-riddles.ts`). The pack holds 60 riddles. Each riddle
is `{ id, answer, aliases[], clues[3], sound: earconId, band }`.

| tool | input | output (in `gameOkSchema`) |
| --- | --- | --- |
| `riddle_guess` | `{ guess: z.string().trim().min(1).max(40), player?: z.string().max(20) }` | `result: 'correct'\|'close'\|'wrong'\|'revealed'`. The server normalises the guess (lower case, strip articles, singular form) and checks it against `answer`, the aliases and Levenshtein <= 1 for words of 5+ letters. The 3rd wrong guess reveals the answer and gives no penalty |
| `riddle_hint` | `{}` | The next clue, up to 2. A hint costs nothing for `little` |
| `riddle_skip` | `{}` | Reveals the answer and moves to the next riddle |

**Simon Says** (`simon-says.ts`). The pack holds 80 commands. Each is `{ text, band, calm: boolean }`,
and `calm` commands are the only ones used when the device is in quiet hours.

| tool | input | output |
| --- | --- | --- |
| `simon_next` | `{}` | `command: { text, simon: boolean }`. The engine picks and balances them: about 30% without "Simon says", and never two tricks in a row for `little` |
| `simon_caught` | `{ players?: string[] }` | Marks players out (a no-name confession counts for the whole room); the round ends at one player or 12 commands |

**Family Quiz** (`family-quiz.ts`). The pack holds 600 questions. Each is
`{ id, band, category, q, choices[3..4], answer: index, fact }`, and each player is served questions
from their own band.

| tool | input | output |
| --- | --- | --- |
| `quiz_answer` | `{ choice?: z.enum(['A','B','C','D']), text?: z.string().max(60), player?: string }`, at least one of `choice` or `text` | `result: 'correct'\|'wrong'`, `answer`, `fact`, and the next question already queued in `say`. A wrong answer opens a steal for the other team when `teams` |
| `quiz_pass` | `{}` | Skips; no points |

**20 Questions** (`twenty-questions.ts`). Bob asks the questions. `category` is set at start
(`start_game` gets `options.category: 'animal'|'food'|'object'|'place'|'character'`).

| tool | input | output |
| --- | --- | --- |
| `twenty_ask` | `{ question: z.string().max(120) }` | Records the question and returns `n` of 20. A question fails the kid content filter (safety.md S1) and returns `bad_input` |
| `twenty_answer` | `{ answer: z.enum(['yes','no','sometimes','unknown']) }` | Records the player's answer to the last question |
| `twenty_guess` | `{ guess: z.string().max(40) }` | Counts as a question; `expect_reply` for yes or no |
| `twenty_result` | `{ correct: boolean, secret?: z.string().max(40) }` | Ends the round. `secret` passes the word filter or is dropped |

**Silly Stories** (`silly-stories.ts`). The pack holds 40 templates. Each is
`{ id, band, title, text with {0..n} slots, slots: {kind:'noun'|'verb'|'adjective'|'animal'|'food'|'silly_word'|'number', prompt}[] }`.

| tool | input | output |
| --- | --- | --- |
| `story_word` | `{ word: z.string().trim().min(1).max(24), player?: string }` | Fills the current slot. A word that fails the word filter returns `bad_input` with a cheerful re-ask ("Ooh, let's pick a different one!"). The last slot returns the filled story, `speak_verbatim: true` |
| `story_pick` | `{ theme?: z.enum(['space','animals','school','food','pirates']) }` | Picks a template, only before the first word |
