/**
 * Test-only surface of @bob/ai (`@bob/ai/testing`): eval scorers, game engine
 * internals, memory extractor internals and content packs. Production code in
 * apps/api must import from `@bob/ai`, never from here.
 */
export * from './index.ts';
export {
  HONEST_ACTIONS_RULE,
  agentInstructions,
  dateContextLine,
} from './prompts.ts';
export {
  EMBEDDING_DIM,
  EMBEDDING_MODEL_ID,
} from './embeddings.ts';
export {
  bandForAge,
  gameErrSchema,
  gameOkSchema,
  gameViewSchema,
  playerAgeSchema,
  type GameDefinition,
  type GameView,
  type StartOptions,
} from './games/engine.ts';
export {
  containsBlockedWord,
  wordFilter,
} from './games/word-filter.ts';
export {
  type KidSafeReason,
} from './games/kid-safe.ts';
export {
  LINE_CHARS,
  RIDDLES_PER_GAME,
  RIDDLE_PACK,
  initRiddles,
  judgeGuess,
  reduceRiddles,
  riddleById,
  riddlePackSchema,
  sayStep,
  wrapLines,
  type RiddleAction,
  type RiddlesState,
} from './games/animal-riddles.ts';
export {
  COMMANDS_PER_ROUND,
  SIMON_CUES,
  SIMON_PACK,
  SIMON_SAYS_META,
  commandId,
  commandLine,
  eligible,
  initSimon,
  openCommand,
  reduceSimon,
  saySimon,
  simonHostNotes,
  simonPackSchema,
  simonScores,
  simonTools,
  type SimonAction,
  type SimonState,
  type SimonStep,
} from './games/simon-says.ts';
export {
  answersDirectly,
  extractionAccuracy,
  falseAddRate,
  firstToolMatch,
  noToolFalseCall,
  overCall,
  recallPrecision,
  namesRealAbilities,
  noIdentityLeak,
  reconciliationCorrect,
  toolArgsMatch,
  usesStructure,
  type MemoryOpLike,
} from './eval-scorers.ts';
export {
  completeTaskInputSchema,
  createEventInputSchema,
  createTaskInputSchema,
  listAgendaInputSchema,
  listTasksInputSchema,
  localCreateEventInputSchema,
  localCreateTaskInputSchema,
  updateTaskInputSchema,
} from './productivity-tools.ts';
export {
  registerGame,
  unregisterGame,
  type GameMeta,
} from './games/registry.ts';
export {
  mulberry32,
  rngAt,
  type Rng,
} from './games/rng.ts';
export {
  ENGINE_TOOL_NAMES,
  gameErr,
  gameErrOf,
} from './games/engine-tools.ts';
export {
  completeActionInputSchema,
  completeActionOutputSchema,
  forgetInputSchema,
  forgetOutputSchema,
  listActionsInputSchema,
  listActionsOutputSchema,
  rememberInputSchema,
  rememberOutputSchema,
  type CompleteActionOutput,
  type ForgetOutput,
  type ListActionsOutput,
  type RememberOutput,
} from './memory-tools.ts';
export {
  DUPLICATE_MIN_CONTAINMENT,
  EVIDENCE_MIN_COVERAGE,
  MEMORY_EXTRACT_SYSTEM_PROMPT,
  buildPrompt,
  extractionEnvelopeSchema,
  groundedInUser,
  memoryExtractionSchema,
  memoryOpSchema,
  narrowsMemory,
} from './memory-extractor.ts';
export {
  isSecretLike,
} from './memory-safety.ts';
export {
  type VoiceOutput,
} from './voice-tools.ts';
export { default as riddlesJson } from './games/content/animal-riddles.json' with { type: 'json' };
export { default as simonJson } from './games/content/simon-says.json' with { type: 'json' };
export { BOB_MAX_AGENT_STEPS, agentStopWhen } from './agents.ts';

export { withinWordBudget } from './eval-scorers.ts';
