export interface ConversationModeConfig {
  readonly MIN_SPEECH_MS: number;
  readonly SILENCE_MS: number;
  readonly MAX_UTTERANCE_MS: number;
  readonly MIN_INTERRUPTION_MS: number;
  readonly IDLE_TIMEOUT_MS: number;
  readonly HIDDEN_RELEASE_MS: number;
}

export const DEFAULT_CONFIG: Readonly<ConversationModeConfig> = Object.freeze({
  // R2: sustained speech below this is a false trigger, not a turn.
  MIN_SPEECH_MS: 250,
  // R2: sustained silence at/past this closes the open utterance.
  SILENCE_MS: 900,
  // R2: an open utterance past this is closed and answered, not accumulated.
  MAX_UTTERANCE_MS: 30000,
  // R3: sustained speech required before a firing counts as barge-in (echo guard).
  MIN_INTERRUPTION_MS: 300,
  // FR-029: 5 minutes of no speech before the mode auto-off and releases the mic.
  IDLE_TIMEOUT_MS: 300000,
  // SC-009: the mic must be released within 2 s of the tab hiding.
  HIDDEN_RELEASE_MS: 2000,
});

export function withOverrides(
  partial: Partial<ConversationModeConfig>,
): Readonly<ConversationModeConfig> {
  return Object.freeze({ ...DEFAULT_CONFIG, ...partial });
}