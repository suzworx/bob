import type { bobAgent } from '@bob/ai';
import type { ModelMessage } from 'ai';
import { defaultAgentPort } from '../agent-adapters.ts';
import { isStubAgent } from '../agent-port.ts';
import { type AgentUsageSource } from '../turn-core.ts';
import { TurnCancelledError, abortable } from './abort.ts';

/** The agent's reply plus the raw SDK fields agentUsageFields reads
 *  (`response.modelId`, `totalUsage`, every step). `stub` marks an AI-stub
 *  reply, which has no model and no tokens. */
export interface AgentResult extends AgentUsageSource {
  text: string;
  toolCalls: Array<{ toolName?: unknown }>;
  stub?: true;
}

type GenerateResponse = Omit<AgentResult, 'stub'>;

/** Runs the agent on the conversation history (a stub adapter's agent answers with its canned reply).
 *  Turns pass the port's base agent (unpaired) or a per-turn agent (paired); a bare call uses this process's default port. */
export async function runAgent(
  messages: ModelMessage[],
  agent: typeof bobAgent = defaultAgentPort().base(),
  signal?: AbortSignal,
): Promise<AgentResult> {
  if (isStubAgent(agent)) {
    const canned = (await agent.generate({ messages })) as { text: string };
    return { text: canned.text, toolCalls: [], stub: true };
  }
  const call = signal ? { messages, abortSignal: signal } : { messages };
  const result = (await abortable(agent.generate(call), signal)) as GenerateResponse;
  return {
    text: result.text,
    toolCalls: result.toolCalls ?? [],
    steps: result.steps,
    response: result.response,
    usage: result.usage,
    totalUsage: result.totalUsage,
    finishReason: result.finishReason,
    providerMetadata: result.providerMetadata,
  };
}

/** The parts of the SDK's StreamTextResult a streamed turn reads. */
interface AgentStreamResult {
  stream: AsyncIterable<{ type: string; text?: string; error?: unknown }>;
  toolCalls: PromiseLike<Array<{ toolName?: unknown }>>;
  steps: PromiseLike<AgentResult['steps']>;
  response: PromiseLike<AgentResult['response']>;
  usage: PromiseLike<AgentResult['usage']>;
  totalUsage: PromiseLike<AgentResult['totalUsage']>;
  finishReason: PromiseLike<AgentResult['finishReason']>;
  providerMetadata: PromiseLike<AgentResult['providerMetadata']>;
}

/** A streamed run. When a game opened mid-turn: what onText got and what it did not. */
export interface StreamedAgentResult extends AgentResult {
  spokenText?: string;
  heldText?: string;
}

/** Whether this agent can stream: the stub reply always can; a real agent
 *  needs stream() (a ToolLoopAgent has it; a generate-only double does not). */
export function canStream(agent: typeof bobAgent): boolean {
  return isStubAgent(agent) || typeof (agent as { stream?: unknown }).stream === 'function';
}

/**
 * Runs the agent like runAgent, handing each text delta to `onText` as
 * it arrives. The reply is every step's text in order -- a line said before a
 * tool call is spoken, so it is also what is stored. An error part rejects,
 * as a failed generate() does; a cancel rejects with TurnCancelledError.
 * Once `hold()` is true (a game tool opened a game in this turn) nothing more
 * reaches `onText`; that text comes back as `heldText`.
 * Text after a tool call waits for the step's end, when its tools have run.
 */
export async function streamAgent(
  messages: ModelMessage[],
  agent: typeof bobAgent,
  onText: (delta: string) => void,
  signal?: AbortSignal,
  hold: () => boolean = (): boolean => false,
): Promise<StreamedAgentResult> {
  if (isStubAgent(agent)) {
    const stub = await runAgent(messages, agent, signal);
    onText(stub.text);
    return stub;
  }
  const call = signal ? { messages, abortSignal: signal } : { messages };
  // ToolLoopAgent.stream() is async: it resolves to the StreamTextResult.
  const started = agent.stream(call) as unknown as PromiseLike<AgentStreamResult> | AgentStreamResult;
  const result = await abortable(Promise.resolve(started), signal);
  let text = '';
  // The prefix of `text` handed to onText; a tool call pends until its step ends.
  let spoken = 0;
  let toolPending = false;
  let held = false;
  const speak = (): void => {
    held ||= hold();
    if (held || toolPending || spoken === text.length) return;
    onText(text.slice(spoken));
    spoken = text.length;
  };
  for await (const part of result.stream) {
    if (signal?.aborted || part.type === 'abort') throw new TurnCancelledError();
    if (part.type === 'error') throw part.error;
    if (part.type === 'tool-call') toolPending = true;
    if (part.type === 'finish-step') toolPending = false;
    if (part.type === 'start-step' && text !== '' && !/\s$/.test(text)) {
      // A new step's text must not run into the previous step's last word.
      text += ' ';
    }
    if (part.type === 'text-delta' && part.text) text += part.text;
    speak();
  }
  toolPending = false;
  speak();
  const [toolCalls, steps, response, usage, totalUsage, finishReason, providerMetadata] = await abortable(
    Promise.all([
      result.toolCalls, result.steps, result.response, result.usage,
      result.totalUsage, result.finishReason, result.providerMetadata,
    ]),
    signal,
  );
  return {
    text: text.trim(), toolCalls: toolCalls ?? [], steps, response, usage, totalUsage, finishReason, providerMetadata,
    ...(held ? { spokenText: text.slice(0, spoken).trim(), heldText: text.slice(spoken).trim() } : {}),
  };
}
