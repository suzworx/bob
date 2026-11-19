// Every stage takes TurnDeps instead of a module global, so a test can run it with plain fakes.
import type { Embedder } from '@bob/ai';
import type { AgentPort } from '../agent-port.ts';
import type { transcribePcm } from '../audio/stt-tts.ts';
import type { SpeechPort } from '../speech-port.ts';
import type { EndOfTurnEvent, SttStreamOpener } from './stream-stt.ts';
import type { SessionDto } from '../protocol.ts';
import { type AccountEvents } from '../../account/events-bus.ts';
import type { DeviceSessions } from '../device-sessions.ts';
import type { Db } from '../../platform/db/db.ts';
import type { TurnMetricRow } from '../../platform/observability/turn-metrics.ts';
import type { GoogleTurnTools } from '../../integrations/google-tools.ts';
import type { AppTurnExtension } from '../../bob-apps/app-turn-extension.ts';

export interface TurnDeps {
  googleTools?: GoogleTurnTools;
  /** The installed apps' turn extension (bob-apps/app-turn-extension.ts); absent, a device turn offers no app tools. */
  appTurnTools?: AppTurnExtension;
  /** The shared database handle, resolved when a stage first needs it. */
  getDb(): Promise<Db>;
  /** The memory embedder, built once and reused (never at import time, never per turn). */
  embedder(): Embedder;
  stt: typeof transcribePcm;
  /** Streaming STT opened at turn_start; present only with BOB_STT_STREAMING=1 and real STT. */
  sttStream?: SttStreamOpener;
  /** Text to speech: 16 kHz PCM and MP3, in `voice` when given (a Bob session's), else the default voice. */
  ttsPcm: SpeechPort['synthesizePcm'];
  ttsMp3: SpeechPort['synthesizeMp3'];
  /** The agent port: builds the per-turn agent (memory, capability and late tools, time zone, cache key) and holds the shared base agent. */
  agent: AgentPort;
  /** The account event bus a persisted turn publishes to. */
  accountEvents(): AccountEvents;
  /** The connected-device registry: flushes a held push when a turn ends, drives device tools. */
  deviceSessions: DeviceSessions;
  /** The timer tools' onChange: re-arms the scheduler and pushes timers_state. */
  timersChanged(userId?: string): Promise<void>;
  /** Starts an accepted paired turn's transcript-free prep at turn_start (generate.ts startEarlyPrep); absent, the turn preps after its transcript. */
  startEarlyPrep?(session: SessionDto, turnRef: string): void;
  /** Sees a streamed turn's end-of-turn events ('drop' when it is cancelled): the speculative reply's hook; absent, nothing listens. */
  onEndOfTurn?(session: SessionDto, turnRef: string, event: EndOfTurnEvent, hypothesis: string): void;
  /** Fire-and-forget per-turn metrics row (counts, timings, enums only); absent in tests that do not care. */
  recordTurnMetric?(row: TurnMetricRow): void;
}
