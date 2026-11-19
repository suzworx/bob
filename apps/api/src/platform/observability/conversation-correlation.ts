/**
 * Which conversation an interaction belongs to, for telemetry only (never authorization or data access).
 * Order: explicit (route param, turn, invocation) -> client (the conversation open in the browser,
 * `X-Bob-Conversation`) -> device (the device session's active conversation, resolved in voice/) ->
 * active (the user's active pointer, read through a short per-user cache by `@bob/ai`'s span layer for any
 * span that has a user and no conversation) -> `none` (system work, before sign-in or pairing; stamped by the
 * span and journal defaults).
 */
import type { Request } from 'express';
import { trace } from '@opentelemetry/api';
import { conversationAttributes, setActiveConversationResolver, type TraceAttrs } from '@bob/ai';
import { canonicalId } from '../ids.ts';
import { activeConversationOf, installActiveConversationReader } from './active-conversation.ts';
import { clientSessionId } from './http-diagnostics.ts';

/** Canonical and legacy shapes only: canonicalId would hash any other opaque string into a plausible id. */
const CONVERSATION = /^(?:conv|cnv|thr)_[0-9a-f]{32}$/;
const ROUTE_CONVERSATION = /^\/api\/(?:conversations|threads)\/([^/?#]+)/;

function canonicalConversation(value: string | undefined): string | undefined {
  return value !== undefined && CONVERSATION.test(value) ? canonicalId('conversation', value) ?? undefined : undefined;
}

/** The canonical form of a conversation or thread id as telemetry names it; an id that cannot be canonicalised stays as given. */
export function telemetryConversationId(id: string): string {
  return canonicalId('conversation', id) ?? id;
}

/** Installs the one read of a user's active-conversation pointer (server wiring) and registers the lookup with the span layer. */
export function setActiveConversationReader(next: Parameters<typeof installActiveConversationReader>[0]): void {
  installActiveConversationReader(next);
  setActiveConversationResolver(next === undefined ? undefined : activeConversationOf);
}

/** The ids a request names itself: acting user, client session, and the explicit (route) or client (header) conversation. Synchronous. */
export function requestCorrelation(request: Request): TraceAttrs {
  const attrs: TraceAttrs = {};
  try {
    const userId = request.account?.userId;
    const sessionId = clientSessionId(request);
    if (userId !== undefined) attrs.userId = userId;
    if (sessionId !== undefined) attrs.sessionId = sessionId;
    const explicit = canonicalConversation(ROUTE_CONVERSATION.exec(request.baseUrl + request.path)?.[1]);
    const client = canonicalConversation(request.get('X-Bob-Conversation'));
    const conversation = explicit ?? client;
    if (conversation !== undefined) {
      attrs.conversationId = conversation;
      attrs.conversationSource = explicit !== undefined ? 'explicit' : 'client';
    }
  } catch { /* Correlation is best effort. */ }
  return attrs;
}

/** Starts the user's active-conversation lookup without waiting and stamps the span that is active now (the request root) when it resolves. */
export function stampActiveConversation(userId: string): void {
  const root = trace.getActiveSpan();
  if (root === undefined) return;
  void activeConversationOf(userId).then((conversationId) => {
    if (conversationId !== undefined && root.isRecording()) root.setAttributes(conversationAttributes(conversationId, 'active'));
  }).catch(() => undefined);
}
