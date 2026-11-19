/**
 * The dependencies of the API process (issue #618): the database, the device
 * registry, the memory embedder, the memory extraction worker, the timer
 * scheduler hook and the turn pipeline's own set. `createAppDeps()` is the one
 * place production code resolves the process-wide singletons (`getDb()`,
 * `getDeviceSessions()`); the composition root (server.ts)
 * build it once and hand it down, and every other module receives what it needs
 * as an argument. Tests build their own with `createAppDeps()` after pointing
 * the shared database at a test instance (`setSharedDb`).
 */
import { AI_STUB_MODE, createEmbedder, createRoutineSummary, registerObservableGauge, scriptedStubAllowed, type Embedder } from '@bob/ai';
import { agentConfigFromEnv, selectAgentLive } from './voice/agent-adapters.ts';
import { getDeviceSessions, type DeviceSessions } from './voice/device-sessions.ts';
import { selectSpeech, speechConfigFromEnv, speechTurnFns } from './voice/speech-adapters.ts';
import { timersChanged, type TimerSchedulerRef } from './voice/device-tools.ts';
import { withTtsCache } from './voice/speech-cache.ts';
import { withSpeechAssetsFromEnv } from './voice/speech-assets.ts';
import { type AgentPort } from './voice/agent-port.ts';
import { type SpeechPort } from './voice/speech-port.ts';
import { type TurnDeps } from './voice/turn/deps.ts';
import { startEarlyPrep } from './voice/turn/generate.ts';
import { onSpeculationEvent } from './voice/turn/speculate.ts';
import { withEmbeddingCache } from './memory/embedding-cache.ts';
import { type MemoryExtractionWorker } from './memory/extract.ts';
import { getAccountEvents } from './devices/pairing-service.ts';
import { getDb, type Db } from './platform/db/db.ts';
import { createTurnMetricRecorder, type TurnMetricRow } from './platform/observability/turn-metrics.ts';
import type { GoogleTurnTools } from './integrations/google-tools.ts';
import type { createGoogleAgendaService } from './integrations/google-agenda-service.ts';
import type { createGoogleConnectionService } from './integrations/google-connection-service.ts';
import { createGoogleRuntime } from './integrations/google-runtime.ts';
import { createRoutineDigest } from './routines/digest.ts';
import type { RoutineJobQueue } from './platform/jobs/routine-queue.ts';
import { createInsightRefresh } from './integrations/insight-refresh.ts';
import { listRoutineResults } from './routines/run-store.ts';
import { listGoogleCalendarSelections } from './integrations/google-calendar-selection-store.ts';
import { createAppTurnExtension, type AppTurnExtension } from './bob-apps/app-turn-extension.ts';
import { saveAppIdea } from './workflows/workflow-app-idea.ts';

export interface AppDeps {
  /** Configured only with verified Google grants; shared by web and device. */
  googleTools?: GoogleTurnTools;
  googleAgenda?: ReturnType<typeof createGoogleAgendaService>;
  googleConnection?: ReturnType<typeof createGoogleConnectionService>;
  routineDigest?: ReturnType<typeof createRoutineDigest>;
  routineJobs?: RoutineJobQueue;
  insightRefresh?: ReturnType<typeof createInsightRefresh>;
  /** The installed apps' one turn extension point (spec 015 U1): device, web and thread turns reach apps only through it. */
  appTurnTools: AppTurnExtension;
  /** The shared database handle, resolved when first needed. */
  getDb(): Promise<Db>;
  /** Speech in and out (ADR 0002): the device turn and the browser voice routes share it. */
  speech: SpeechPort;
  /** The connected-device registry. */
  deviceSessions: DeviceSessions;
  /** The memory embedder, built once per deps instance and only when first used. */
  embedder(): Embedder;
  /** The background extraction worker (T012); the composition root sets it when memory is on. */
  memoryWorker?: MemoryExtractionWorker;
  /** The running timer scheduler's reschedule hook; null until started and after stop. */
  timerScheduler: TimerSchedulerRef;
  /** The timer tools' onChange: re-arms the scheduler and pushes timers_state. */
  timersChanged(userId?: string): Promise<void>;
  /** The agent port every agent caller (device turn, web chat, invocations) asks; stub, scripted stub or real is decided once, in createAppDeps. */
  agent: AgentPort;
  /** What the voice turn pipeline needs (STT, TTS, agent factory, event bus, ...). */
  turn: TurnDeps;
  /** Fire-and-forget per-turn metrics recorder; never throws into a turn. */
  recordTurnMetric(row: TurnMetricRow): void;
}

/** The `device.connected` gauge: live open device sockets as two series (`paired` true/false). Registered once per process. */
export function registerDeviceConnectedGauge(sessions: DeviceSessions): void {
  registerObservableGauge('device.connected', () => {
    const { paired, unpaired } = sessions.connectedCounts();
    return [{ value: paired, attributes: { paired: 'true' } }, { value: unpaired, attributes: { paired: 'false' } }];
  });
}

export function createAppDeps(options: Pick<AppDeps, 'googleTools' | 'googleAgenda' | 'googleConnection' | 'routineDigest' | 'insightRefresh'> = {}): AppDeps {
  const google = createGoogleRuntime(getDb);
  const googleTools = options.googleTools ?? google?.tools;
  const googleAgenda = options.googleAgenda ?? google?.agenda;
  const googleConnection = options.googleConnection ?? google?.connection;
  const routineDigest = options.routineDigest ?? (google && !AI_STUB_MODE
    ? createRoutineDigest({ gmail: google.gmail, summarize: createRoutineSummary() }) : undefined);
  const insightRefresh = options.insightRefresh ?? (google ? createInsightRefresh({
    selectedCalendars: async (owner, accountId) => (await listGoogleCalendarSelections(await getDb(), owner))
      .filter(selection => selection.account_id === accountId).map(selection => selection.calendar_id),
    calendar: google.calendar,
    history: async (owner, accountId) => listRoutineResults(await getDb(), owner, accountId),
  }) : undefined);
  let embedder: Embedder | null = null;
  const embedderOnce = (): Embedder => {
    // BOB_EMBED_CACHE=on (default off): repeated memory queries skip the embed round trip.
    embedder ??= process.env.BOB_EMBED_CACHE === 'on' ? withEmbeddingCache(createEmbedder()) : createEmbedder();
    return embedder;
  };
  // ADR 0002: which speech adapter answers (provider or stub) is decided here, once.
  const speechConfig = speechConfigFromEnv(AI_STUB_MODE, process.env);
  const selected = selectSpeech(speechConfig);
  // BOB_TTS_CACHE=on (default off): repeated short phrases skip the provider. Stubbed TTS is already free.
  const cached = process.env.BOB_TTS_CACHE === 'on' && !speechConfig.stubTts ? withTtsCache(selected) : selected;
  // BOB_SPEECH_ASSETS_DIR or _URL (+ _BUILD; default unset): exact template replies in the
  // pack's voice assemble reviewed PCM clips server-side, then encode once; anything else falls back.
  const speech = withSpeechAssetsFromEnv(cached, process.env);
  // ADR 0002: which agent adapter answers (real, stub or scripted stub) is decided here; the scripted opt-in is re-read per call, as it always was.
  const agent = selectAgentLive(() => agentConfigFromEnv(AI_STUB_MODE, scriptedStubAllowed()));
  const deviceSessions = getDeviceSessions();
  registerDeviceConnectedGauge(deviceSessions);
  const timerScheduler: TimerSchedulerRef = { reschedule: null };
  const changed = (userId?: string): Promise<void> => timersChanged({ registry: deviceSessions, getDb, scheduler: timerScheduler }, userId);
  const recordTurnMetric = createTurnMetricRecorder(getDb);
  const appTurnTools = createAppTurnExtension(saveAppIdea);
  const turn: TurnDeps = {
    googleTools,
    appTurnTools,
    getDb,
    recordTurnMetric,
    embedder: embedderOnce,
    ...speechTurnFns(speech),
    agent,
    accountEvents: getAccountEvents,
    deviceSessions,
    timersChanged: changed,
    startEarlyPrep: (session, turnRef) => { startEarlyPrep(turn, session, turnRef); },
    onEndOfTurn: (session, turnRef, event, hypothesis) => { onSpeculationEvent(turn, session, turnRef, event, hypothesis); },
  };
  return { appTurnTools, getDb, speech, agent, deviceSessions, embedder: embedderOnce, timerScheduler, timersChanged: changed, turn, recordTurnMetric, googleTools, googleAgenda, googleConnection, routineDigest, insightRefresh };
}
