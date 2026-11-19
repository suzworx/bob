/**
 * Chat stream reply: streams one web chat turn's agent to the reader once its message is stored, and ends the turn.
 * Trigger: workflows/workflow-web-chat-turn.ts answerTurn, with the built agent and the reply persister.
 * Steps: 1. journal the prep window. 2. open the agent's UI stream; nothing reaches the reader before the store
 *   settles. 3. drain it to the end (even after the reader leaves), holding a game reply's rest for its guard.
 *   4. persist the reply (or the partial one), journal the outcome and record the turn metric.
 * Outcome: the reply is saved even when the reader leaves or Stops; a failed turn answers 400/502/503 when nothing was
 *   sent yet, and a failed store throws the store's own error.
 * Journal: turn stages web/prep completed, web/agent completed|failed, web/input failed; one turn metric row.
 */
import { randomUUID } from 'node:crypto';
import { createAgentUIStreamResponse, type UIMessage } from 'ai';
import { prepareDocumentMessages } from '../conversations/document-attachments.ts';
import { agentUsageFields, classifyFailure, type AgentUsageStep } from '../voice/turn-core.ts';
import { journalTurnStage } from '../voice/turn-journal.ts';
import type { AgentImpl } from '../voice/agent-port.ts';
import { OUT_OF_CREDIT_ERROR, isBudgetExhausted, noteBudgetExhausted } from '../platform/observability/budget-alarm.ts';
import { createGameStreamGate } from '../conversations/chat-stream.ts';
import {
  failureFields, failureNoteOf, journalWebPrep, recordWebTurnMetric, recoverPartialReply, type WebTurnMetricInput,
} from '../conversations/web-turn-support.ts';
import type { ReplyPersister } from './chat-persist.ts';
import type { TurnCtx, TurnRun, WebChatOutput } from './chat-turn-ctx.ts';

export function sendDocumentBusy(error: unknown, out: WebChatOutput): boolean {
  if (!(error instanceof Error) || error.message !== 'document_busy') return false;
  out.json(503, { error: { code: 'document_busy', message: 'Bob is reading a few documents. Please try again in a moment.' } }, { 'Retry-After': '5' });
  return true;
}

/** A failed message store found once the model started: it answers as it did when the store ran first. */
class StoreFailure extends Error {
  constructor(readonly failure: unknown) { super('store_failed'); }
}

export interface StreamInput { agent: AgentImpl; uiMessages: UIMessage[]; started: number; sincePrevTurn: number | undefined; }

export async function streamReply(ctx: TurnCtx, run: TurnRun, reply: ReplyPersister, input: StreamInput): Promise<void> {
  const { deps, userId, conversation, surface, out, traceId, workflowId, createdTitle } = ctx;
  const { turnId, stop, bound, agentSignal } = ctx.input.cancellation;
  const { agent, uiMessages, started, sincePrevTurn } = input;
  const { persistReply, checkOnce } = reply;
  const rawChunks: string[] = [];
  let failed = false, storeFailed = false;
  // Collected per call (not via the agent's onFinish) so any agent the turn
  // runs is measured the same way.
  const agentSteps: AgentUsageStep[] = [];
  const modelStartedAt = Date.now();
  journalWebPrep({ turnId, conversationId: conversation.id, receivedAt: ctx.input.receivedAt, startedAt: started, modelStartedAt, timings: ctx.clock.timings, waits: ctx.clock.waits });
  let firstTokenAt: number | null = null;
  let streamError: unknown;
  let failureNote: Pick<WebTurnMetricInput, 'failedStage' | 'failure'> = {};
  let toolErrors = 0;
  // Why a turn ended the way it did: flags only, set only when true.
  const endFlags = (): Record<string, boolean | number> => ({
    ...(run.clientGone ? { client_gone: true } : {}),
    ...(stop.signal.aborted ? { stopped: true } : {}),
    ...(bound.aborted ? { timed_out: true } : {}),
    ...(toolErrors > 0 ? { tool_errors: toolErrors } : {}),
  });
  // Every way a web turn fails journals exactly one failed event with an enum
  // reason and no content. Returns whether it was the client's invalid input
  // (never for a non-Error throw).
  const journalFailure = (error: unknown, reason: 'stream_error' | 'agent_threw'): boolean => {
    const failure = classifyFailure('agent', error);
    noteBudgetExhausted(failure, surface);
    const invalid = failure.kind === 'invalid_input' && error instanceof Error && reason === 'agent_threw';
    failureNote = failureNoteOf(failure, invalid);
    journalTurnStage({
      interface: 'web',
      turnId,
      stage: invalid ? 'input' : 'agent',
      outcome: 'failed',
      fields: {
        duration_ms: Date.now() - started,
        conversation_id: conversation.id,
        ...failureFields(failure, invalid ? 'invalid_request' : reason),
        ...endFlags(),
      },
    });
    return invalid;
  };
  try {
    const providerMessages = await prepareDocumentMessages(uiMessages, agentSignal, true);
    const upstream = await createAgentUIStreamResponse({
      agent,
      onStepEnd: (step) => { agentSteps.push(step); },
      // The store persists opaque part JSON; the SDK owns the part shape.
      uiMessages: providerMessages as never,
      abortSignal: agentSignal,
      // A provider error mid-reply does not reject: the SDK turns it into an
      // SSE `error` part and ends the stream normally. Keep the error so that
      // path journals a failure instead of `completed`.
      onError: (error: unknown) => {
        streamError = error;
        return isBudgetExhausted(classifyFailure('agent', error)) ? OUT_OF_CREDIT_ERROR.code : 'The assistant could not complete that request.';
      },
      // Persistence mode: reused ids guard against duplicated assistant replies.
      originalMessages: uiMessages as never,
      generateMessageId: () => randomUUID(),
      // The reply's time rides its start, so a live reply shows one before the
      // conversation is reopened; a new conversation's id and title ride along.
      messageMetadata: ({ part }) => {
        if (part.type !== 'start' && part.type !== 'finish') return undefined;
        const created = { workflowId, ...(part.type === 'start' ? { createdAt: Date.now() } : {}), ...(traceId ? { traceId } : {}) };
        if (createdTitle !== null) return { ...created, conversationId: conversation.id, title: createdTitle };
        return created;
      },
      onEnd: async ({ messages: updated }: { messages: Array<{ role?: string; parts?: unknown }> }) => {
        const reply = [...updated].reverse().find((candidate) => candidate.role === 'assistant');
        if (reply) await persistReply((reply.parts ?? []) as Array<Record<string, unknown>>);
      },
    });
    // Nothing reaches the reader, and no reply is saved, before the reader's message is stored.
    await ctx.stored.catch(async (failure: unknown) => { await upstream.body?.cancel().catch(() => undefined); throw new StoreFailure(failure); });
    if (agentSignal.aborted) { await upstream.body?.cancel().catch(() => undefined); agentSignal.throwIfAborted(); }
    out.openStream(upstream.status, upstream.headers);
    if (!upstream.body) { out.end(); return; }
    const decoder = new TextDecoder(), reader = upstream.body.getReader();
    const gate = createGameStreamGate(() => run.gameTurn?.gameTurn === true, checkOnce), sawFirstText = ctx.ports.createFirstTextDetector();
    try {
      // Drained to the end even after the reader leaves: the agent, its tools
      // and onEnd's persistence all run off this stream.
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const bytes = Buffer.from(chunk.value);
        const text = decoder.decode(bytes, { stream: true });
        if (firstTokenAt === null && sawFirstText(text)) firstTokenAt = Date.now();
        rawChunks.push(text);
        const gated = await gate.push(text);
        if (!run.clientGone && gated !== '') out.write(gated ?? bytes);
      }
      const tail = await gate.end();
      if (!run.clientGone && tail !== '') out.write(tail);
    } finally { reader.releaseLock(); }
    out.end();
    // The SSE `error` part is what a client reports as "stream error". Its
    // JSON is structural, so a `"type":"error"` never matches escaped reply text.
    const sse = rawChunks.join('');
    toolErrors = sse.split('"type":"tool-output-error"').length - 1;
    if (sse.includes('"type":"error"')) {
      failed = true;
      journalFailure(streamError ?? new Error('stream error'), 'stream_error');
    }
  } catch (error) {
    // A failed store is the store's error, thrown: no metric row and no agent stage.
    if (error instanceof StoreFailure) { failed = storeFailed = true; throw error.failure; }
    // An aborted turn still saves the partial reply that reached the reader.
    failed = true;
    const partial = recoverPartialReply(rawChunks);
    if (partial) await persistReply(partial);
    const invalid = journalFailure(error, 'agent_threw');
    if (!out.headersSent() && !run.clientGone) {
      if (sendDocumentBusy(error, out)) return;
      if (invalid) out.json(400, { error: { code: 'invalid_request', message: 'That request was not a valid message list.' } });
      else if (isBudgetExhausted(classifyFailure('agent', error))) out.json(503, { error: OUT_OF_CREDIT_ERROR });
      else out.json(502, { error: { code: 'upstream_error', message: 'The assistant could not complete that request.' } });
    }
  } finally {
    const finishedAt = Date.now();
    if (!storeFailed) recordWebTurnMetric(deps, { surface, ...failureNote, failed, stopped: stop.signal.aborted, timedOut: bound.aborted, clientGone: run.clientGone, receivedAt: ctx.input.receivedAt, startedAt: started, modelStartedAt, firstTokenAt, endedAt: finishedAt, steps: agentSteps, accountId: userId });
    if (!failed) journalTurnStage({
      interface: 'web',
      turnId,
      stage: 'agent',
      outcome: 'completed',
      fields: {
        messages: uiMessages.length,
        conversation_id: conversation.id,
        duration_ms: finishedAt - started,
        prep_ms: modelStartedAt - started,
        model_ms: finishedAt - modelStartedAt,
        ...(firstTokenAt !== null ? { first_token_ms: firstTokenAt - modelStartedAt } : {}),
        ...(sincePrevTurn !== undefined ? { since_prev_turn_ms: sincePrevTurn } : {}),
        ...agentUsageFields({ steps: agentSteps }),
        ...endFlags(),
      },
    });
  }
}
