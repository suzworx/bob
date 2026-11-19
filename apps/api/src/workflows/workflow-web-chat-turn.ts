/**
 * Workflow: one web chat turn, from the reader's message to the streamed reply and its saved copy.
 * Trigger: POST /api/chat (conversations/chat-http.ts, which owns parsing, auth and the Express response).
 * Steps: 1. resolve the conversation (open or create it, accept documents). 2. start the prep at once (startWebPrep):
 *   store the reader's message with the active pointer, scope, retrieval, history, the agent's reads; a new conversation,
 *   an edit, a regenerate or an attachment stores first. 3. build the agent (its tools wait for the store) and stream it
 *   to the reader once stored. 4. persist the reply, enqueue memory extraction, journal it, record the turn metric.
 * Outcome: the reply is saved even when the reader leaves or Stops mid-stream (the partial text). A failed
 *   turn answers 400/502/503 when nothing was sent yet (404 for an unknown conversation, 409 when Stop cancels
 *   a document read, 503 document_busy, 500 store_error when the conversation cannot be read back) and
 *   journals exactly one failed stage. It publishes the account events conversation.updated,
 *   message.appended and active.changed.
 * Journal: v2.conversation_created, v2.active_changed, v2.agent_tools, v2.agent_tools_degraded,
 *   v2.messages_persisted, v2.messages_persist_failed, v2.game_guard_replaced (voice/game-tools.ts); turn
 *   stages web/agent started|completed|failed and web/input failed (a bad message list); trace web-chat-turn
 *   (traceWebTurn); one turn metric row.
 */
import { randomUUID } from 'node:crypto';
import type { UIMessage } from 'ai';
import { prepareDocumentMessages } from '../conversations/document-attachments.ts';
import { isUniqueViolation } from '../conversations/invocations-store.ts';
import { MAX_HISTORY_MESSAGES, sincePrevTurnMs, trimHistory } from '../voice/turn-core.ts';
import { moduleJournal } from '../platform/logger.ts';
import type { Db } from '../platform/db/db.ts';
import { findUserMessageConversation, getConversationSummary, type StoredConversation } from '../conversations/store.ts';
import { textChars, traceWebTurn } from '../conversations/chat-stream.ts';
import { buildTurnAgent, startWebPrep, type WebPrep, type WebPrepInput } from '../turn/chat-agent.ts';
import type { AppBinding } from '../bob-apps/app-turn-extension.ts';
import { started, timed, waitedFor, type PrepTimings } from '../turn/prep-kit.ts';
import { journalWebAgentStarted, storedToUiMessages } from '../conversations/web-turn-support.ts';
import type { Surface, TurnCtx, TurnMessage, TurnRun, WebChatOutput, WebChatTurnInput, WebChatTurnPorts, WebTurnDeps } from '../turn/chat-turn-ctx.ts';
import { createOpeningConversation, storeUserMessage } from '../turn/chat-store.ts';
import { createReplyPersister } from '../turn/chat-persist.ts';
import { sendDocumentBusy, streamReply } from '../turn/chat-stream-reply.ts';

const journal = moduleJournal('conversations');

export type { WebCancellation, WebChatOutput, WebChatTurnInput, WebChatTurnPorts } from '../turn/chat-turn-ctx.ts';

async function acceptDocumentMessage(message: UIMessage, regenerate: boolean | undefined, out: WebChatOutput, signal: AbortSignal): Promise<boolean> {
  if (regenerate) return true;
  try {
    await prepareDocumentMessages([message], signal);
    return true;
  } catch (error) {
    if (signal.aborted) { out.json(409, { error: { code: 'cancelled', message: 'Stopped.' } }); return false; }
    if (sendDocumentBusy(error, out)) return false;
    out.json(400, { error: { code: 'invalid_document', message: 'That document could not be read. Try a smaller, unprotected copy, or export it as PDF or plain text.' } });
    return false;
  }
}

/** A plain new message on an existing conversation: text only, and no integration mention (the Google tools are
 *  filtered on the stored message's mentions). It preps while it is stored; undefined for any other turn. */
function pendingMessage(request: WebChatTurnInput['request'], existing: StoredConversation | null, regenerate: boolean | undefined, origin: Surface): WebPrepInput['pending'] {
  const { message } = request;
  // An app binding is admitted (or refused) before any prep read starts, and a generic app reads only the policy.
  if (existing === null || regenerate || request.editFrom || request.editFromStart || request.appBinding) return undefined;
  if (!message.parts.every((part) => part.type === 'text' && !/@\{integration:/i.test(String((part as { text?: string }).text ?? '')))) return undefined;
  return { id: message.id, parts: message.parts, origin };
}

/** The app admission (an explicit binding refused throws); null when the turn has no app. */
async function preflightApp(deps: WebTurnDeps, db: Db, conversationId: string | undefined, input: WebChatTurnInput): Promise<AppBinding | null> {
  if (!deps.appTurnTools && input.request.appBinding) throw new Error('app_binding_unavailable');
  return deps.appTurnTools?.preflight(db, input.userId, conversationId, { appBinding: input.request.appBinding, sessionId: input.sessionId }) ?? null;
}
const textOf = (message: TurnMessage): string =>
  message.parts.filter((part) => part.type === 'text').map((part) => String((part as { text?: string }).text ?? '')).join(' ');

export async function runWebChatTurn(deps: WebTurnDeps, input: WebChatTurnInput, out: WebChatOutput, ports: WebChatTurnPorts): Promise<void> {
  const { id, regenerate, resend } = input.request;
  try {
    await runTurn(deps, input, out, ports);
  } catch (error) {
    // A Retry racing its first attempt: that attempt stored the message after
    // this one looked. Looking again finds it. An id held anywhere this account
    // cannot see fails the same way again, so this runs once.
    if (!(resend || (regenerate && !id)) || !isUniqueViolation(error) || out.headersSent()) throw error;
    await runTurn(deps, input, out, ports);
  }
}

// A Retry cannot know whether its first attempt stored the message, and a
// regenerate with no id has no conversation to re-answer: the store decides.
// Held already: answer it (in the conversation a first attempt may have opened
// without the client learning its id). Not held: an ordinary send.
async function locateTurn(db: Db, userId: string, request: WebChatTurnInput['request']): Promise<{ conversationId: string | undefined; regenerate: boolean | undefined }> {
  const { id, message } = request;
  const storedIn = request.resend || (request.regenerate && !id) ? await findUserMessageConversation(db, userId, message.id) : null;
  const conversationId = id ?? storedIn ?? undefined;
  if (storedIn !== null && storedIn === conversationId) return { conversationId, regenerate: true };
  return { conversationId, regenerate: id ? request.regenerate : undefined };
}

const NOT_FOUND = { error: { code: 'not_found', message: 'No such conversation.' } }; // also an app binding with no app extension wired
function refuseBinding(deps: WebTurnDeps, out: WebChatOutput, cause: unknown): void {
  const { status, body } = deps.appTurnTools?.refusal(cause) ?? { status: 404, body: NOT_FOUND };
  out.json(status, body);
}

async function runTurn(deps: WebTurnDeps, input: WebChatTurnInput, out: WebChatOutput, ports: WebChatTurnPorts): Promise<void> {
  const { userId, request, cancellation } = input;
  const db = await deps.getDb();
  const { id, message, editFrom, editFromStart, origin } = request;
  // Origin stamps messages and pointer writes; absent means a typed turn.
  const surface = origin ?? 'web_text';

  const timings: PrepTimings = {};
  const { conversationId, regenerate } = await timed(timings, 'locate_ms', () => locateTurn(db, userId, request));
  const existing: StoredConversation | null = conversationId ? await timed(timings, 'locate_ms', () => getConversationSummary(db, userId, conversationId)) : null;
  if (conversationId && !existing) {
    out.json(404, NOT_FOUND);
    return;
  }
  // The prep window opens here: its waits and other_ms sum to prep_ms.
  const clock = { startedAt: Date.now(), timings, waits: {} as PrepTimings };
  const app = started(() => timed(timings, 'app_preflight_ms', () => preflightApp(deps, db, conversationId, input)));
  let settleStore: (stored: Promise<string | null>) => void = () => undefined;
  const stored = started(() => new Promise<string | null>((resolve) => { settleStore = resolve; }));
  // FR-008. A new conversation, an edit, a regenerate or an attachment keeps the serial order: the store or truncation
  // lands before the history is read.
  const pending = pendingMessage(request, existing, regenerate, surface);
  let binding: AppBinding | null = null;
  const explicitApp = request.appBinding !== undefined;
  const prepFor = (conversation: StoredConversation): WebPrep => startWebPrep({
    deps, db, userId, conversationId: conversation.id, regenerate, signal: cancellation.agentSignal, timeZone: input.timeZone(), timings, app, stored, pending,
    boundApp: binding?.generic === true, explicitApp,
  }, textOf(message));
  const early = existing && pending ? prepFor(existing) : null;
  try {
    // A named app is admitted before any message is written. Without one the preflight never refuses and never
    // makes the turn generic: it only finds the owner's default app, whose tools the build awaits, so nothing waits here.
    binding = explicitApp ? await waitedFor(clock.waits, 'app_preflight_wait_ms', app) : null;
  } catch (cause) {
    refuseBinding(deps, out, cause);
    return;
  }
  // Refuse unreadable documents before creating a conversation or appending a message; on a text message (no I/O) it
  // is the Stop check: a Stop before the store answers 409 and stores nothing. Regeneration reads the persisted files.
  if (!await waitedFor(clock.waits, 'document_wait_ms', acceptDocumentMessage(message as unknown as UIMessage, regenerate, out, cancellation.agentSignal))) return;
  // A conversation the client has no id for still has to reach it, with the reply.
  const opened = existing ? { conversation: existing, createdTitle: id ? null : existing.title, openingMessageId: null }
    : await waitedFor(clock.waits, 'store_wait_ms', timed(timings, 'store_ms', () => createOpeningConversation(db, userId, message, surface)));

  const workflowId = surface === 'web_voice' && !regenerate ? request.workflowId ?? randomUUID() : randomUUID();
  await traceWebTurn(opened.conversation.id, userId, cancellation.turnId, async (traceId) => {
    const ctx: TurnCtx = { deps, db, userId, surface, regenerate, message, conversation: opened.conversation, createdTitle: opened.createdTitle, input, out, ports, traceId, workflowId, app: binding, clock, stored };
    settleStore(opened.openingMessageId !== null ? Promise.resolve(opened.openingMessageId) : timed(timings, 'store_ms', () => storeUserMessage(ctx, editFrom, editFromStart)));
    if (!pending) await waitedFor(clock.waits, 'store_wait_ms', stored);
    await answerTurn(ctx, early ?? prepFor(opened.conversation));
  }, workflowId);
}


async function answerTurn(ctx: TurnCtx, prep: WebPrep): Promise<void> {
  const { deps, db, userId, conversation, message, regenerate, out, input } = ctx;
  const { turnId } = input.cancellation;
  const { waits } = ctx.clock;
  // One transaction probes the row (store_error for a conversation that
  // vanished since it was resolved) and reads the newest rows.
  const fresh = await waitedFor(waits, 'history_wait_ms', prep.history);
  if (!fresh) {
    // A store that failed (the conversation was gone before it) throws its own error, as the base did; one that
    // landed first answers store_error. Either way nothing is written after this answer.
    await ctx.stored;
    out.json(500, { error: { code: 'store_error', message: 'The conversation could not be read back.' } });
    return;
  }
  // Appends use the committed row even if concurrent messages pushed it out
  // of the history window. Settled with the history (or known before the store).
  const userMessageAnchor = await prep.anchor;
  const scope = await waitedFor(waits, 'scope_wait_ms', prep.scope);
  const memoryOn = await waitedFor(waits, 'scope_wait_ms', prep.memoryOn);
  const retrieval = await prep.retrieval;
  // Two bounds, both on what the provider is shown and neither on the store:
  // message count first, then the attachment-byte budget over what survives.
  const history = ctx.ports.boundHistoryAttachments(
    trimHistory(storedToUiMessages(fresh), MAX_HISTORY_MESSAGES, fresh[0]?.position ?? 0),
  ) as unknown as UIMessage[];
  // A regenerated turn answers the existing question: drop trailing assistant
  // turns so the model sees the question last.
  const uiMessages = regenerate
    ? (() => {
        const trimmed = [...history];
        while (trimmed.at(-1)?.role === 'assistant') trimmed.pop();
        return trimmed;
      })()
    : history;

  const turnStartedAt = ctx.clock.startedAt;
  const sincePrevTurn = sincePrevTurnMs(conversation.id, turnStartedAt);
  // Attachment counts and lengths only; never journal names or bytes.
  const replayed = journalWebAgentStarted(turnId, conversation.id, message.parts, uiMessages as Array<{ parts?: unknown[] }>);
  // The reader leaving does not cancel the turn: a timer they asked for must
  // still be set with the tab closed. Only Stop or the timeout aborts it.
  // The response closing while it is still writable is the real disconnect (the
  // request's own 'close' fires at +0ms once the body is consumed); from then on
  // only the network writes stop.
  const run: TurnRun = { clientGone: false, gameTurn: null };
  out.onDisconnect(() => { run.clientGone = true; });
  const reply = createReplyPersister(ctx, run, memoryOn);

  // Capability tools are built on every turn, memory on or off, so the tool
  // set does not flip with memory availability; memory off drops only the
  // memory tools and the block. A retrieval failure just omits the block.
  const block = retrieval ? await waitedFor(waits, 'retrieval_wait_ms', retrieval.result).then((result) => result.block, () => null) : null;
  const appTools = await waitedFor(waits, 'app_tools_wait_ms', prep.appTools);
  const built = await buildTurnAgent({
    deps, db, userId, conversationId: conversation.id, turnId, surface: ctx.surface, agentSignal: input.cancellation.agentSignal,
    reads: prep.reads, waits, toolGate: ctx.stored, scope, retrieval, block, userMessageAnchor, timeZone: input.timeZone(),
    onGameTurn: (turn) => { run.gameTurn = turn; },
    appTools: appTools.tools,
    ...(ctx.app?.generic ? { boundApp: { kind: 'declarative' as const } } : {}),
    ...(appTools.taskContext ? { taskContext: appTools.taskContext, contextToolNames: appTools.contextToolNames } : {}),
  });
  // Test infrastructure only: a scripted model answers over exactly the tools
  // this turn offered, so a scripted call runs the real tool.
  const agent = deps.agent.withOfferedTools(built.agent, built.offeredToolMap);
  // Tool names, section sizes and history counts only: never arguments,
  // results or user text.
  const offeredTools = Object.keys(built.offeredToolMap);
  const prior = uiMessages.slice(0, -1);
  journal('v2.agent_tools', {
    interface: 'web',
    turn_id: turnId,
    tools: offeredTools.join(','),
    conversation_id: conversation.id,
    ...built.sections,
    history_messages: prior.length,
    history_chars: prior.reduce((total, entry) => total + textChars(entry.parts), 0),
    history_attachment_bytes: replayed,
  });
  await streamReply(ctx, run, reply, { agent, uiMessages, started: turnStartedAt, sincePrevTurn });
}
