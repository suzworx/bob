/**
 * Barrel for @bob/ai: re-exports agents, tools, schemas, and config.
 * Consumed by apps/api, which imports this raw TypeScript source.
 */
export { bobAgent, chatModel, gateway, assistantTools, logAgentConfig, type CreateBobAgentOptions } from './agents.ts';
export {
  currentDateTimeTool,
  synthesizeSpeech,
  transcribeAudio,
  capSpeechInput,
} from './tools.ts';
export * from './schemas.ts';
export {
  createTimerTools,
  parseTimerDuration,
  speakDuration,
  speakTimer,
  speakTimerName,
  timerViewSchema,
  type CancelTimerInput,
  type TimerCallbacks,
  type TimerToolOutput,
  type TimerView,
} from './timer-tools.ts';
export {
  createDeviceTools,
  DEVICE_MODES,
  EXPRESS_EMOTIONS,
  EXPRESS_MAX_SECONDS,
  speakVolume,
  type DeviceCallbacks,
  type DeviceToolMode,
  type DeviceToolOutput,
  type ExpressEmotion,
  type ExpressInput,
  type SetModeInput,
  type SetVolumeInput,
} from './device-tools.ts';
export { BOB_SYSTEM_TEST_MODE, AI_STUB_MODE, BOB_STT_LANGUAGE, MAX_TTS_INPUT_CHARS } from './config.ts';
export { isProviderError, providerErrorStatus } from './errors.ts';
export { keyFingerprint, liveKeyRefusal, productionKeyRefusal, refuseProductionKey } from './key-guard.ts';
export { debugLog, debugTimed, isDebugEnabled, isFrameDebugEnabled, isPayloadDebugEnabled, setDebugSink } from './debug.ts';
export type { DebugFields } from './debug.ts';
export { recordObservationMetrics, registerObservableGauge, recordTraceSignal, type MetricAttributes, type ObservationMetricName, type ObservationMetricSample } from './observation-metrics.ts';
export { conversationAttributes, currentCorrelation, currentDiagnosticTraceId, NO_CONVERSATION, updateActiveSpanMetadata, withDiagnosticContextObserver } from './telemetry-metadata.ts';
export {
  agentTelemetry,
  bindDiagnosticContext,
  flushTelemetry,
  initTelemetry,
  observabilityEnvironment,
  onTelemetryError,
  openSpan,
  setActiveConversationResolver,
  toSpanAttrs,
  toTraceAttrs,
  traceEvaluation,
  traceSpeechUsage,
  traceSpan,
  workflowTraceId,
  withCorrelation,
  withTraceContext,
  withDetachedTelemetryContext,
  type ConversationSource,
  type OpenSpan,
  type TraceAttrs,
  type ObservabilityContext,
  type BobSurface,
  type SpanAttrs,
  type SpeechUsage,
} from './telemetry.ts';
export {
  endsAtSentence,
  isEnglish,
  lengthCap700,
  noMarkdown,
  toolNameMatch,
  VOICE_REPLY_MAX_CHARS,
  type ScorerResult,
} from './eval-scorers.ts';
export { judge, judgeOutputSchema, type JudgeInput, type JudgeOptions, type JudgeResult } from './eval-judge.ts';

// --- public API used by apps/api ---
export {
  createEmbedder,
  type Embedder,
} from './embeddings.ts';
export {
  AI_GATEWAY_API_KEY,
  BOB_STT_MODEL,
  BOB_TTS_MODEL,
  BOB_TTS_VOICE,
  BOB_TTS_VOICE_BOB_REFUSED,
  scriptedStubAllowed,
  ttsVoiceFor,
  TTS_TIMEOUT_MS,
} from './config.ts';
export {
  openTranscriptStream,
  type StreamTranscript,
  type TranscriptStream,
} from './stream-transcribe.ts';
export {
  createBobAgent,
  TURN_PROFILES,
  type TurnMode,
} from './agents.ts';
export {
  createMemoryTools,
  type ActionItemCandidate,
  type ActionItemView,
  type CompleteActionCallbackResult,
  type CompleteActionInput,
  type ForgetCallbackResult,
  type ForgetInput,
  type ListActionsInput,
  type MemoryToolCallbacks,
  type RememberCallbackResult,
  type RememberInput,
} from './memory-tools.ts';
export {
  LOCAL_WALL_TIME_SHAPE,
  createProductivityTools,
  createSpaceMemberTools,
  localTimeDuesEnabled,
  type AgendaItem,
  type CompleteTaskInput,
  type CreateEventInput,
  type CreateTaskInput,
  type ListAgendaInput,
  type ListTasksInput,
  type ProductivityCallbacks,
  type NotifyEmailCallbackResult,
  type NotifyEmailInput,
  type SpaceMemberCallbacks,
  type SpaceMemberLine,
  type TaskSummary,
  type UpdateTaskInput,
} from './productivity-tools.ts';
export {
  bandSchema,
  gameIdSchema,
  playerSchema,
  type Band,
  type GameCallbacks,
  type GameId,
  type GameSnapshot,
  type Player,
} from './games/engine.ts';
export {
  kidSafeText,
} from './games/kid-safe.ts';
export {
  GameRefusedError,
  GameStaleError,
  createEngineTools,
  guardOffScript,
  offScriptGameReply,
  type EngineCallbacks,
  type EngineRefusal,
  type OpenGame,
} from './games/engine-tools.ts';
export {
  allowedGames,
  getGame,
  registeredGames,
} from './games/registry.ts';
export {
  BOB_AGENT_INSTRUCTIONS,
  resolveTimeZone,
  taskContextText,
  type CoreTaskContext,
} from './prompts.ts';
// Loading the module registers the Marketing delegate with specialists.ts (the agent core names no app).
export { marketingTaskContext, marketingToolNames } from './marketing-agent.ts';
export {
  secretReason,
} from './memory-safety.ts';
export { canonicalMemoryVoice } from './memory-style.ts';
export { createMemoryJudge, type MemoryJudge, type MemoryJudgeVerdict } from './memory-judge.ts';
export { createMemoryGate, MEMORY_GATE_THRESHOLD, memoryGateMode, type MemoryGate } from './memory-gate.ts';
export {
  createMemoryExtractor,
  findDuplicate,
  sensitiveCategory,
  type ExistingMemory,
  type ExtractInput,
  type ExtractResult,
} from './memory-extractor.ts';
export {
  AmbiguousReminderError,
  createVoiceTools,
  type CreateReminderInput,
  type HourlyRepeat,
  type ReminderLine,
  type Repeat,
  type VoiceCallbacks,
} from './voice-tools.ts';
export {
  createScriptedStubAgent,
} from './stub-agent.ts';
export { deriveIntent, TOOL_INTENT, type TurnIntent } from './intents.ts';
export { createRoutineSummary } from './routine-summary.ts';
export { bobMarketingPack } from './marketing-pack.ts';
export { marketingPhaseSkills, marketingPhases, type MarketingPhase } from './marketing-skills.ts';
