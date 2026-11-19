/**
 * #1039: the two switches that send private content off the box. BOB_TRACE_PAYLOAD
 * puts prompts and replies on every exported span; BOB_DEBUG_PAYLOAD prints
 * transcripts and tool payloads to stdout (Railway logs). Production refuses both.
 */
const PAYLOAD_FLAGS = ['BOB_TRACE_PAYLOAD', 'BOB_DEBUG_PAYLOAD'] as const;

type PayloadFlag = (typeof PAYLOAD_FLAGS)[number];

/** The payload flags switched on in `env`, by name only: the caller decides whether that is allowed. */
export function enabledPayloadFlags(env: NodeJS.ProcessEnv): PayloadFlag[] {
  return PAYLOAD_FLAGS.filter((flag) => env[flag] === '1');
}
