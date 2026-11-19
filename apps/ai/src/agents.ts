/**
 * Wires the AI Gateway provider, chat model, and ToolLoopAgent used by the
 * voice server. Exports the shared agent instances and tool registry.
 */
import { createHash } from 'node:crypto';
import { ToolLoopAgent, stepCountIs } from 'ai';
import type { GenerateTextOnFinishCallback, PrepareStepFunction, StopCondition, Tool, ToolSet } from 'ai';
import { BOB_CHAT_MODEL } from './config.ts';
import { gateway } from './gateway.ts';
import { debugLog } from './debug.ts';
import { cacheProviderOptions, cacheableInstructions, markHistoryBreakpoint, withThinkingBudget } from './prompt-cache.ts';
import { BOB_AGENT_INSTRUCTIONS, turnContextText, withTurnContext, type CoreTaskContext, type ReplyStyle } from './prompts.ts';
import { agentTelemetry, initTelemetry } from './telemetry.ts';
import { assistantTools, createCurrentDateTimeTool } from './tools.ts';
import { toolResultObserver } from './tool-observability.ts';
import { withSpecialists } from './specialists.ts';

export { gateway };

export const chatModel = gateway(BOB_CHAT_MODEL);

/** Registers Braintrust telemetry before the agent is constructed. */
initTelemetry();

/** Inserts the per-turn context as one system message right before the final user message (a string `prompt` becomes that message). */
function prepareTurnContextCall<T extends { messages?: unknown; prompt?: unknown }>(
  settings: T,
  memoryContext: string | undefined,
  timeZone: string | undefined,
  replyStyle?: ReplyStyle,
  taskContext?: CoreTaskContext,
): T {
  const context = turnContextText(memoryContext, new Date(), timeZone, replyStyle, taskContext);
  // `allowSystemInMessages` admits the one context message; a system message
  // from the caller is still refused, as the SDK refuses it by default.
  if (Array.isArray(settings.messages)) {
    const messages = callerMessages(settings.messages);
    return { ...settings, allowSystemInMessages: true, messages: markHistoryBreakpoint(withTurnContext(messages, context)) };
  }
  if (Array.isArray(settings.prompt)) {
    const prompt = callerMessages(settings.prompt);
    return { ...settings, allowSystemInMessages: true, prompt: markHistoryBreakpoint(withTurnContext(prompt, context)) };
  }
  if (typeof settings.prompt === 'string') {
    const { prompt, ...rest } = settings;
    const messages = markHistoryBreakpoint(withTurnContext([{ role: 'user', content: prompt }], context));
    return { ...rest, allowSystemInMessages: true, messages } as unknown as T;
  }
  return settings;
}

/**
 * The `promptCacheKey` for a conversation id: a 32-hex SHA-256 digest, stable per conversation
 * and opaque, so the value the provider sees never equals the `conversation_id` the journal carries.
 */
export function promptCacheKeyFor(conversationId: string): string {
  return createHash('sha256').update(`bob-prompt-cache:${conversationId}`).digest('hex').slice(0, 32);
}

/** The caller's messages, refusing any `system` one (only the context message may be). */
function callerMessages(messages: unknown[]): Array<{ role: string }> {
  const typed = messages as Array<{ role: string }>;
  if (typed.some((message) => message.role === 'system')) {
    throw new Error('System messages are not allowed in the prompt or messages fields');
  }
  return typed;
}

/**
 * Most model calls (steps) one turn may make. A normal turn needs at most 2; the cap bounds
 * a runaway tool loop, which otherwise runs to the SDK default of 20.
 */
export const BOB_MAX_AGENT_STEPS = 6;

/** Stop condition shared by every Bob agent: end the loop after the step cap. */
export const agentStopWhen: StopCondition<ToolSet> = stepCountIs(BOB_MAX_AGENT_STEPS);

export interface CreateBobAgentOptions {
  /** The kind of turn (default `unpaired`): its TURN_PROFILES row sets the reply style, app scope, delegates and no-tools variant. */
  mode?: TurnMode;
  /** Per-account memory tools merged into `assistantTools`; a name clash throws. */
  memoryTools?: Record<string, Tool>;
  /** Per-invocation capability tools, already bound to a CommandContext. */
  capabilityTools?: Record<string, Tool>;
  /** Pre-built `[BOB MEMORY …]` block from apps/api, appended as a system section. */
  memoryContext?: string;
  /** Typed convenience context, active only when this turn permits the matching capabilities. Never personal memory. */
  taskContext?: CoreTaskContext;
  /** The app tool names whose permitted presence admits `taskContext` (the app extension's, never client input). */
  contextToolNames?: readonly string[];
  /** The account's IANA timezone: anchors the date line and is currentDateTime's default zone. */
  timeZone?: string;
  /** Conditional tool groups (voice, device) merged last, after memory, so the always-present tools keep a stable prefix. */
  lateTools?: Record<string, Tool>;
  /** The conversation id, sent digested (`promptCacheKeyFor`) as `providerOptions.openai.promptCacheKey`; never journalled. */
  cacheKey?: string;
  /** Called once with the finished run; the caller journals from it, so apps/ai stays journal-free. */
  onFinish?: GenerateTextOnFinishCallback<ToolSet>;
  /** Core-owned policy applied after every tool group, including base tools. */
  filterTools?: (tools: Record<string, Tool>) => Record<string, Tool>;
  /** Extra stop condition beside the step cap (a one-step game turn). */
  stopWhen?: StopCondition<ToolSet>;
  /** Per-step settings (a one-step game turn forces its first call to a game tool). */
  prepareStep?: PrepareStepFunction<ToolSet>;
}

/** Every kind of turn the agent serves. Modes of play are not rows here. */
export type TurnMode = 'unpaired' | 'device' | 'device_degraded' | 'chat' | 'chat_degraded' | 'web_voice' | 'web_voice_degraded'
  | 'bound_app' | 'bound_app_voice' | 'group' | 'shared_app_run' | 'shared_app_refine' | 'shared_generic_app_refine';

type SpecialistScope = NonNullable<Parameters<typeof withSpecialists>[4]>;

/**
 * One kind of turn. `replyStyle`: the style line in the per-turn context (unset adds none). `tools`: false is the
 * no-tools (degraded) variant. `delegates`: 'none' offers tools direct, 'all' every registered delegate, a scope
 * restricts them. `taskContext`: a typed task context may ride while its app tools are permitted. `privateMemory`:
 * a memory block, memory tools and late tools are allowed. `shared`: the server-authorized group app the row runs.
 * `hooks`: a one-step game's stop condition and per-step settings are allowed.
 */
export interface TurnProfile {
  readonly replyStyle?: ReplyStyle; readonly tools: boolean; readonly delegates: 'none' | 'all' | SpecialistScope;
  readonly taskContext: boolean; readonly privateMemory: boolean; readonly hooks: boolean;
  readonly shared?: { kind: 'marketing'; mode: 'run' | 'refine' } | { kind: 'declarative'; mode: 'refine' };
}

const PRIVATE = { tools: true, delegates: 'all', taskContext: true, privateMemory: true, hooks: false } as const;
const BOUND_APP = { tools: true, delegates: { delegates: ['apps'], shared: false, appKind: 'declarative' }, taskContext: false, privateMemory: true, hooks: false } as const;
const GROUP = { replyStyle: 'group', tools: true, taskContext: false, privateMemory: false, hooks: false } as const;

/** The one table every turn is built from; a caller with no `mode` gets `unpaired`. */
export const TURN_PROFILES: Readonly<Record<TurnMode, TurnProfile>> = Object.freeze({
  unpaired: { tools: true, delegates: 'none', taskContext: true, privateMemory: true, hooks: true },
  device: { ...PRIVATE, replyStyle: 'voice', hooks: true },
  device_degraded: { ...PRIVATE, replyStyle: 'voice', tools: false },
  chat: { ...PRIVATE, replyStyle: 'text' },
  chat_degraded: { ...PRIVATE, replyStyle: 'text', tools: false },
  web_voice: { ...PRIVATE, replyStyle: 'voice' },
  web_voice_degraded: { ...PRIVATE, replyStyle: 'voice', tools: false },
  bound_app: { ...BOUND_APP, replyStyle: 'text' },
  bound_app_voice: { ...BOUND_APP, replyStyle: 'voice' },
  // A plain group thread keeps today's leniency: memory is not refused, only never passed.
  group: { ...GROUP, delegates: 'none', privateMemory: true },
  shared_app_run: { ...GROUP, delegates: { delegates: ['marketing'], shared: true, appKey: 'marketing' }, taskContext: true, shared: { kind: 'marketing', mode: 'run' } },
  shared_app_refine: { ...GROUP, delegates: { delegates: ['apps'], shared: true, appKey: 'marketing' }, shared: { kind: 'marketing', mode: 'refine' } },
  shared_generic_app_refine: { ...GROUP, delegates: { delegates: ['apps'], shared: true, appKind: 'declarative' }, shared: { kind: 'declarative', mode: 'refine' } },
});

const SHARED_APP_ERROR = 'A shared app requires group replies without private memory or late tools';
const isEmpty = (tools: Record<string, Tool> | undefined): boolean => Object.keys(tools ?? {}).length === 0;

/** The options' row (`unpaired` when no mode is given), refusing inputs it forbids. */
function rowFor(opts: CreateBobAgentOptions): TurnProfile {
  const profile = TURN_PROFILES[opts.mode ?? 'unpaired'];
  if (!profile.privateMemory && (opts.memoryContext || !isEmpty(opts.memoryTools) || !isEmpty(opts.lateTools))) throw new Error(SHARED_APP_ERROR);
  if (!profile.hooks && (opts.stopWhen || opts.prepareStep)) throw new Error('Game hooks require a device turn');
  return profile;
}

/** The merged tools after the caller's policy; none on a no-tools row. */
function permittedTools(profile: TurnProfile, opts: CreateBobAgentOptions, merged: Record<string, Tool>): Record<string, Tool> {
  if (!profile.tools) return {};
  return opts.filterTools ? opts.filterTools(merged) : merged;
}

/**
 * Builds a per-turn agent from its mode's TURN_PROFILES row: the row sets the
 * reply style, delegates, task-context admission and the no-tools variant, and
 * refuses inputs it forbids. `memoryTools` and `capabilityTools` are merged
 * into `assistantTools` (a name clash throws); `timeZone` swaps in a
 * currentDateTime tool for that zone. The instructions stay byte-stable: the
 * per-turn context rides one system message before the final user message.
 * Every agent stops after `BOB_MAX_AGENT_STEPS` model calls. Tool
 * order is base, `capabilityTools`, memory, then `lateTools`.
 */
export function createBobAgent(opts: CreateBobAgentOptions = {}): ToolLoopAgent {
  const profile = rowFor(opts);
  const { timeZone, memoryContext, replyStyle } = { ...opts, replyStyle: profile.replyStyle };
  const base = timeZone ? { ...assistantTools, currentDateTime: createCurrentDateTimeTool(timeZone) } : assistantTools;
  const permitted = permittedTools(profile, opts, mergeTools(base, opts.capabilityTools, opts.memoryTools, opts.lateTools));
  const taskContext = profile.taskContext && opts.contextToolNames?.some((name) => permitted[name] !== undefined) ? opts.taskContext : undefined;
  const tools = profile.delegates === 'none'
    ? permitted
    : withSpecialists(permitted, chatModel, turnContextText(undefined, new Date(), timeZone, replyStyle), taskContext,
      profile.delegates === 'all' ? undefined : profile.delegates);
  return new ToolLoopAgent({
    model: chatModel,
    instructions: cacheableInstructions(BOB_AGENT_INSTRUCTIONS),
    tools,
    onToolExecutionEnd: toolResultObserver(tools),
    telemetry: agentTelemetry,
    prepareCall: (settings) => prepareTurnContextCall(settings, memoryContext, timeZone, replyStyle, taskContext),
    providerOptions: withThinkingBudget(cacheProviderOptions(opts.cacheKey, promptCacheKeyFor)),
    stopWhen: opts.stopWhen ? [agentStopWhen, opts.stopWhen] : agentStopWhen,
    ...(opts.prepareStep ? { prepareStep: opts.prepareStep } : {}),
    ...(opts.onFinish ? { onEnd: opts.onFinish } : {}),
  });
}

/** The `unpaired` row with no per-user context: base tools only. The port's base agent and the evals' baseline. */
export const bobAgent = createBobAgent({ mode: 'unpaired' });

/**
 * Returns `base` untouched when no extra tool maps are given, or a
 * shallow copy merged with each map in order. A name that already exists in the
 * merged set throws, naming the tool. Returns the same `base` reference
 * (`assistantTools` when no zone is set) when there is nothing to merge, so a default agent stays
 * config-identical to the shared singleton.
 */
function mergeTools(base: Record<string, Tool>, ...maps: (Record<string, Tool> | undefined)[]): Record<string, Tool> {
  const extras = maps.filter((map): map is Record<string, Tool> => map !== undefined);
  if (extras.length === 0) return base;
  const merged: Record<string, Tool> = { ...base };
  for (const map of extras) {
    for (const [name, extraTool] of Object.entries(map)) {
      if (Object.hasOwn(merged, name)) {
        throw new Error(`Tool "${name}" clashes with an existing assistant tool`);
      }
      merged[name] = extraTool;
    }
  }
  return merged;
}

/**
 * Records the model, system prompt, and tool registry under debug mode. The
 * system prompt is a first-class suspect when replies come back in an
 * unexpected language or style, and the journal is forbidden from carrying it.
 *
 * Called by the server after the debug sink is open rather than at module
 * load: logging at import time reaches the console but predates the file
 * sink, so the prompt would be missing from the log that gets read later.
 */
export function logAgentConfig(capabilityTools?: Record<string, Tool>): void {
  debugLog('ai.agent_configured', {
    model: BOB_CHAT_MODEL,
    instructions: BOB_AGENT_INSTRUCTIONS,
    instruction_chars: BOB_AGENT_INSTRUCTIONS.length,
    tools: Object.keys(assistantTools).join(','),
    ...(capabilityTools ? { capability_tools: Object.keys(capabilityTools).join(',') } : {}),
  });
}

export { assistantTools };
