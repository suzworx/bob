import type { ConversationModeConfig } from './config';
import type { State } from './conversation-mode';

interface ShouldInterruptInput {
  readonly state: State;
  readonly speechMs: number;
  readonly config: ConversationModeConfig;
}

/**
 * R3 echo guard (FR-013, FR-014, SC-004): while the assistant is speaking, only
 * sustained speech of at least MIN_INTERRUPTION_MS counts as a barge-in —
 * anything shorter is echo or noise and must not cut the reply off. Outside the
 * speaking state the ordinary MIN_SPEECH_MS trigger threshold applies.
 */
export function shouldInterrupt({
  state,
  speechMs,
  config,
}: ShouldInterruptInput): boolean {
  const threshold =
    state === 'speaking' ? config.MIN_INTERRUPTION_MS : config.MIN_SPEECH_MS;
  return speechMs >= threshold;
}