/**
 * Pure turn rules shared by the device and web adapters. Nothing here returns
 * or stores an error's message: provider messages carry response bodies, which
 * must never reach logs, so classifyFailure returns the error's NAME only.
 */
import { asSchema, type Tool } from 'ai';
import { isProviderError, providerErrorStatus } from '@bob/ai';

export const MAX_HISTORY_MESSAGES = 40;

/** The step the chunked history window's start moves in (cache-v1 layout). */
export const HISTORY_TRIM_CHUNK = 20;

/** The shortest clip worth sending to STT. Nobody says a word in
 *  less; below it the clip is a stray tap, and the provider answers with a 400. */
export const MIN_STT_AUDIO_MS = 300;

/** Upstream statuses that mean the STT provider refused the audio itself.
 *  An allow-list: anything else (401/403 credentials, 404 wrong model id,
 *  408 timeout, 424 failed dependency, 429 rate limit, 5xx) must fail loudly. */
const STT_AUDIO_REJECTED_STATUSES: ReadonlySet<number> = new Set([400, 413, 415, 422]);

export type TurnStage = 'input' | 'stt' | 'agent' | 'tts';

type TurnFailureKind = 'invalid_input' | 'upstream_error' | 'internal';

export interface TurnFailure {
  stage: TurnStage;
  kind: TurnFailureKind;
  errorName: string;
  upstreamStatus?: number;
  timedOut?: boolean;
}

type TurnOutcome = 'started' | 'completed' | 'failed';

export interface TurnLifecycleEvent {
  interface: 'cardputer' | 'web';
  turnId: string;
  /** `prep` brackets a device turn's agent preparation (never a failure stage). */
  stage: TurnStage | 'prep';
  outcome: TurnOutcome;
  fields: Record<string, unknown>;
}


/**
 * The newest `max` history entries, oldest-first, never mutating the input.
 * `slice(-0)` would copy everything, so a `max` of zero or less is empty.
 *
 * With `offset` (how many conversation messages precede `messages[0]`) the
 * window is chunked so the prompt prefix stays cacheable: its start moves only
 * in steps of HISTORY_TRIM_CHUNK, so its first message stays fixed while 20
 * more are appended. It never returns more than `max`.
 */
export function trimHistory<T>(messages: T[], max: number = MAX_HISTORY_MESSAGES, offset?: number): T[] {
  if (max <= 0) return [];
  if (offset === undefined) return messages.slice(-max);
  // A chunk wider than the window could step past the newest message.
  const chunk = Math.min(HISTORY_TRIM_CHUNK, max);
  const total = offset + messages.length;
  const start = Math.max(0, chunk * Math.ceil((total - max) / chunk));
  return messages.slice(Math.max(0, start - offset, messages.length - max));
}

/** The error's name for an Error, or the constructor name / typeof otherwise. */
function errorNameOf(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (error !== null && error !== undefined) {
    const constructorName = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof constructorName === 'string' && constructorName.length > 0) return constructorName;
  }
  return typeof error;
}

/**
 * Classifies a thrown value, lifting only fields that are safe to journal.
 *
 *   'invalid_input'  -> the error's NAME matches validation/invalid. Wins over
 *                       the rest: an invalid request is the caller's fault even
 *                       when it also carries an upstream status.
 *   'upstream_error' -> isProviderError(error): a Gateway error, a transport
 *                       failure, or an AbortError/TimeoutError name.
 *   'internal'       -> anything else.
 */
export function classifyFailure(stage: TurnStage, error: unknown): TurnFailure {
  const errorName = errorNameOf(error);

  const upstreamStatus = providerErrorStatus(error);
  const timedOut = errorName === 'TimeoutError' || errorName === 'AbortError';
  const invalid = /validation|invalid/i.test(errorName);
  const upstream = isProviderError(error);

  const kind: TurnFailureKind = invalid
    ? 'invalid_input'
    : upstream
      ? 'upstream_error'
      : 'internal';

  const failure: TurnFailure = { stage, kind, errorName };
  if (upstreamStatus !== undefined) failure.upstreamStatus = upstreamStatus;
  if (timedOut) failure.timedOut = true;
  return failure;
}

/** Token counts as the AI SDK reports them (LanguageModelUsage, ai@7). */
interface AgentTokenUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  inputTokenDetails?: { cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined } | undefined;
  outputTokenDetails?: { reasoningTokens?: number | undefined } | undefined;
}

/** The slice of an AI SDK step result agentUsageFields reads. */
export interface AgentUsageStep {
  toolCalls?: ReadonlyArray<{ toolName?: unknown }> | undefined;
  toolResults?: ReadonlyArray<{ output?: unknown }> | undefined;
  content?: ReadonlyArray<{ type: string; error?: unknown }> | undefined;
  finishReason?: unknown;
  response?: { modelId?: unknown } | undefined;
  providerMetadata?: unknown;
  usage?: AgentTokenUsage | undefined;
}

/** A generate result, an onFinish event, or `{ steps }` collected per step. */
export interface AgentUsageSource extends AgentUsageStep {
  totalUsage?: AgentTokenUsage | undefined;
  steps?: ReadonlyArray<AgentUsageStep> | undefined;
}

/** Journal fields for one agent run: counts, allow-listed ids and enums only. */
interface AgentUsageFields {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  tokens?: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  steps: number;
  tool_calls: number;
  called_tools: string;
  finish_reason?: string;
  provider?: string;
}

const FINISH_REASONS: ReadonlySet<string> = new Set(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other']);
const MODEL_ID = /^[A-Za-z0-9._:/@-]{1,128}$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const PROVIDER_ID = /^[A-Za-z0-9._-]{1,64}$/;

function allowed(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sum(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : present.reduce((total, value) => total + value, 0);
}

/** Sums per-step usage, for a caller that only saw the steps (web onStepEnd). */
function sumStepUsage(steps: ReadonlyArray<AgentUsageStep>): AgentTokenUsage | undefined {
  const usages = steps.map((step) => step.usage).filter((usage): usage is AgentTokenUsage => usage !== undefined);
  if (usages.length === 0) return undefined;
  return {
    inputTokens: sum(usages.map((usage) => count(usage.inputTokens))),
    outputTokens: sum(usages.map((usage) => count(usage.outputTokens))),
    totalTokens: sum(usages.map((usage) => count(usage.totalTokens))),
    inputTokenDetails: {
      cacheReadTokens: sum(usages.map((usage) => count(usage.inputTokenDetails?.cacheReadTokens))),
      cacheWriteTokens: sum(usages.map((usage) => count(usage.inputTokenDetails?.cacheWriteTokens))),
    },
    outputTokenDetails: { reasoningTokens: sum(usages.map((usage) => count(usage.outputTokenDetails?.reasoningTokens))) },
  };
}

/** The routed provider id the AI Gateway reports, when it reports one. */
function gatewayProvider(metadata: unknown): string | undefined {
  const gateway = (metadata as { gateway?: { routing?: Record<string, unknown> } } | undefined)?.gateway;
  const routing = gateway?.routing;
  return allowed(routing?.finalProvider, PROVIDER_ID) ?? allowed(routing?.resolvedProvider, PROVIDER_ID);
}

/**
 * The journal fields of one agent run, over ALL steps: tokens come from
 * `totalUsage` (or the sum of the steps), tool calls and names from every step.
 * Only numbers and allow-listed strings (model id, tool names, finish-reason
 * enum, provider id) are returned; anything else is dropped, never journaled.
 */
export function agentUsageFields(result: AgentUsageSource): AgentUsageFields {
  const steps = result.steps ?? [];
  const last: AgentUsageStep = steps.at(-1) ?? result;
  const usage = result.totalUsage ?? sumStepUsage(steps) ?? result.usage;
  const calls = steps.length > 0 ? steps.flatMap((step) => step.toolCalls ?? []) : [...(result.toolCalls ?? [])];
  const names = [...new Set(calls.map((call) => allowed(call.toolName, TOOL_NAME)).filter((name) => name !== undefined))];
  const fields: AgentUsageFields = { steps: steps.length, tool_calls: calls.length, called_tools: names.join(',') };
  const model = allowed(result.response?.modelId, MODEL_ID) ?? allowed(last.response?.modelId, MODEL_ID);
  if (model !== undefined) fields.model = model;
  const input = count(usage?.inputTokens);
  if (input !== undefined) fields.input_tokens = input;
  const output = count(usage?.outputTokens);
  if (output !== undefined) fields.output_tokens = output;
  const total = count(usage?.totalTokens);
  if (total !== undefined) fields.tokens = total;
  if (usage !== undefined) fields.cached_input_tokens = count(usage.inputTokenDetails?.cacheReadTokens) ?? 0;
  const cacheWrite = count(usage?.inputTokenDetails?.cacheWriteTokens);
  if (cacheWrite !== undefined) fields.cache_write_tokens = cacheWrite;
  const reasoning = count(usage?.outputTokenDetails?.reasoningTokens);
  if (reasoning !== undefined) fields.reasoning_tokens = reasoning;
  const finish = result.finishReason ?? last.finishReason;
  if (typeof finish === 'string' && FINISH_REASONS.has(finish)) fields.finish_reason = finish;
  const provider = gatewayProvider(result.providerMetadata ?? last.providerMetadata);
  if (provider !== undefined) fields.provider = provider;
  return fields;
}

/** Whether the run's tool actions worked: counts and an enum, never names' arguments, outputs or text. */
export interface AgentActionOutcome {
  tool_calls: number;
  tool_failures: number;
  action_outcome: 'none' | 'ok' | 'failed';
}

function isHandledFailure(output: unknown): boolean {
  return typeof output === 'object' && output !== null && 'ok' in output && output.ok === false;
}

function isToolFailure(part: { type: string; error?: unknown }): boolean {
  const cancelled = part.error instanceof Error && part.error.name === 'AbortError';
  return part.type === 'tool-error' && !cancelled;
}

/**
 * The agent run's action outcome, over ALL steps, with tool-observability's
 * semantics: a `{ ok: false }` tool result is a handled failure, a tool-error
 * is a failure, an aborted tool is a cancellation (not a failure).
 */
export function agentActionOutcome(result: AgentUsageSource): AgentActionOutcome {
  const steps = result.steps ?? [];
  const toolCalls = agentUsageFields(result).tool_calls;
  const handled = steps.flatMap((step) => step.toolResults ?? []).filter((part) => isHandledFailure(part.output)).length;
  const errors = steps.flatMap((step) => step.content ?? []).filter(isToolFailure).length;
  const toolFailures = handled + errors;
  const outcome = toolFailures > 0 ? 'failed' : toolCalls > 0 ? 'ok' : 'none';
  return { tool_calls: toolCalls, tool_failures: toolFailures, action_outcome: outcome };
}

/** The parts of one agent step's content that deviceToolParts reads. */
interface StepContentPart {
  type: string;
  toolCallId?: unknown;
  toolName?: unknown;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  providerMetadata?: unknown;
}

/** One finished tool call as a stored UI tool part; null for anything else. */
function toolPartOf(part: StepContentPart): Record<string, unknown> | null {
  if (typeof part.toolCallId !== 'string' || typeof part.toolName !== 'string' || !TOOL_NAME.test(part.toolName)) return null;
  const base = {
    type: `tool-${part.toolName}`,
    toolCallId: part.toolCallId,
    ...(part.providerMetadata !== undefined ? { callProviderMetadata: part.providerMetadata } : {}),
  };
  if (part.type === 'tool-result') return { ...base, state: 'output-available', input: part.input, output: part.output };
  // An error's own message can carry internals; the model only needs to know it failed.
  if (isToolFailure(part)) return { ...base, state: 'output-error', input: part.input, errorText: 'The tool failed.' };
  return null;
}

/**
 * The tool calls an agent run finished, as the UI tool parts web chat stores:
 * per step, a step-start and then one part per tool result or error. A call
 * that never finished (cancelled) is left out, as web drops incomplete calls.
 */
export function deviceToolParts(
  steps: ReadonlyArray<{ content?: ReadonlyArray<StepContentPart> | undefined }>,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const step of steps) {
    const tools = (step.content ?? []).map(toolPartOf).filter((part): part is Record<string, unknown> => part !== null);
    if (tools.length > 0) parts.push({ type: 'step-start' }, ...tools);
  }
  return parts;
}

/** The outcome of a turn the agent never ran (an empty turn). */
export const NO_AGENT_ACTION: AgentActionOutcome = { tool_calls: 0, tool_failures: 0, action_outcome: 'none' };

/** How big each section of the agent's request is, in characters. */
export interface AgentSectionSizes {
  tool_count: number;
  tools_chars: number;
  instructions_chars: number;
  memory_chars: number;
  context_chars: number;
}

/** Serialized schema size per schema object: module-level schemas are sized once. */
const schemaChars = new WeakMap<object, number>();
/** Whole-map size per tool-map identity (the shared base map is reused every turn). */
const toolMapChars = new WeakMap<object, number>();

function toolChars(name: string, entry: Tool): number {
  const schema = entry.inputSchema as unknown;
  let chars = typeof schema === 'object' && schema !== null ? schemaChars.get(schema) : undefined;
  if (chars === undefined) {
    let json: unknown;
    try {
      json = asSchema(entry.inputSchema).jsonSchema;
    } catch {
      json = undefined;
    }
    // An async schema is not awaited on the hot path; it counts as empty.
    const sync = json !== null && typeof json === 'object' && typeof (json as { then?: unknown }).then !== 'function';
    chars = sync ? JSON.stringify(json).length : 0;
    if (typeof schema === 'object' && schema !== null) schemaChars.set(schema, chars);
  }
  return name.length + (entry.description?.length ?? 0) + chars;
}

/**
 * Section sizes of one agent request: tool count and JSON-schema size, the base
 * instructions, the retrieved memory block and any other appended context
 * (the active-space line). Lengths only -- no section text leaves this function.
 */
export function agentSectionSizes(parts: {
  tools: Record<string, Tool>;
  instructions: string;
  memory?: string | null;
  context?: string | null;
}): AgentSectionSizes {
  let tools = toolMapChars.get(parts.tools);
  if (tools === undefined) {
    tools = Object.entries(parts.tools).reduce((total, [name, entry]) => total + toolChars(name, entry), 0);
    toolMapChars.set(parts.tools, tools);
  }
  return {
    tool_count: Object.keys(parts.tools).length,
    tools_chars: tools,
    instructions_chars: parts.instructions.length,
    memory_chars: parts.memory?.length ?? 0,
    context_chars: parts.context?.length ?? 0,
  };
}

/** Bound on remembered conversations; the oldest entry is evicted past it. */
const MAX_TRACKED_CONVERSATIONS = 1000;
const lastTurnAt = new Map<string, number>();

/**
 * Milliseconds since the previous agent turn in the same conversation on
 * this process, recording `now` as this turn's time. Undefined on the first
 * turn seen (or with no conversation id).
 */
export function sincePrevTurnMs(conversationId: string | null | undefined, now: number = Date.now()): number | undefined {
  if (conversationId === null || conversationId === undefined) return undefined;
  const previous = lastTurnAt.get(conversationId);
  lastTurnAt.delete(conversationId);
  lastTurnAt.set(conversationId, now);
  if (lastTurnAt.size > MAX_TRACKED_CONVERSATIONS) {
    const oldest = lastTurnAt.keys().next().value;
    if (oldest !== undefined) lastTurnAt.delete(oldest);
  }
  return previous === undefined ? undefined : now - previous;
}

/**
 * True when a classified STT failure is the provider refusing our audio, so
 * the turn should end as "I did not hear anything" rather than an error. A
 * typed GatewayInvalidRequestError classifies as invalid_input, so both
 * provider kinds count; only an allow-listed status qualifies.
 */
export function isSttAudioRejection(failure: TurnFailure): boolean {
  if (failure.stage !== 'stt' || failure.kind === 'internal') return false;
  return failure.upstreamStatus !== undefined && STT_AUDIO_REJECTED_STATUSES.has(failure.upstreamStatus);
}
