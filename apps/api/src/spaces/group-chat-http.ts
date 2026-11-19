import { Router, type Response, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AccountEvent } from '../account/events-bus.ts';
import { StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { route, sendError } from '../platform/http/route.ts';
import { createTokenBucket } from '../platform/http/rate-limit.ts';
import { clearActiveThread } from '../conversations/active.ts';
import { StoreForbiddenError } from './invitations.ts';
import { UnsupportedGroupHistoryError } from './group-chat-snapshot.ts';
import { GroupChatFullError } from './group-chat-errors.ts';
import { ChatEmailSendError, ChatEmailUnavailableError, sendChatInvitation } from './group-chat-email.ts';
import { GroupChatSchema, GroupChatMemberSchema, GroupChatLinkPreviewSchema } from '../web-schemas.ts';
import {
  acceptGroupChatLink, createGroupChat, createGroupChatLink, getGroupChat,
  listGroupChatMembers, listGroupChats, previewGroupChatLink, removeGroupChatMember, revokeGroupChatLinks,
} from './group-chat-store.ts';

const CreateBody = z.object({
  request_id: z.string().uuid(), source_conversation_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  text_only: z.boolean().optional(),
}).strict();
const IdParams = z.object({ id: z.string().uuid() });
const EmailBody = z.object({ email: z.string().trim().max(254).email() }).strict();
const MemberParams = z.object({ id: z.string().uuid(), userId: z.string().uuid() });
const TokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const LinkSchema = z.object({ token: z.string(), expires_at: z.number().int().positive() }).strict();
export const MembersSchema = z.object({ members: z.array(GroupChatMemberSchema) }).strict();

type RouterDeps = { getDb: () => Promise<Db>; events: { publish: (userId: string, event: AccountEvent) => void }; requireActiveSession?: RequestHandler };
function mapError(response: Response, error: unknown): void {
  if (error instanceof ChatEmailUnavailableError) { sendError(response, 503, 'email_unavailable'); return; }
  if (error instanceof ChatEmailSendError) { sendError(response, 502, 'email_send_failed'); return; }
  if (error instanceof UnsupportedGroupHistoryError) { sendError(response, 409, 'unsupported_history', error.message); return; }
  if (error instanceof StoreNotFoundError) { sendError(response, 404, 'not_found'); return; }
  if (error instanceof StoreForbiddenError) { sendError(response, 403, 'forbidden', error.message); return; }
  if (error instanceof GroupChatFullError) { sendError(response, 409, 'group_full', error.message); return; }
  throw error;
}

async function publishChanged(db: Db, events: RouterDeps['events'], userId: string, chatId: string): Promise<void> {
  const members = await listGroupChatMembers(db, userId, chatId);
  for (const member of members) {
    events.publish(member.user_id, { type: 'conversation.updated', conversation_id: chatId, updated_at: Date.now() });
  }
}

export function createGroupChatsRouter({ getDb, events, requireActiveSession }: RouterDeps): Router {
  const router = Router();
  const invitations = createTokenBucket(20);
  const emailInvitations = createTokenBucket(5);
  const freshSession: RequestHandler = requireActiveSession ?? ((_request, _response, next) => next());
  router.get('/group-chats', route({}, async ({ userId }, _request, response) => {
    response.json({ chats: (await listGroupChats(await getDb(), userId)).map((chat) => GroupChatSchema.parse(chat)) });
  }));
  router.post('/group-chats', route({ body: CreateBody, mapError }, async ({ userId, body }, _request, response) => {
    const chat = await createGroupChat(await getDb(), userId, {
      requestId: body.request_id, sourceConversationId: body.source_conversation_id, textOnly: body.text_only,
    });
    events.publish(userId, { type: 'conversation.updated', conversation_id: chat.id, updated_at: chat.updated_at });
    response.status(201).json({ chat: GroupChatSchema.parse(chat) });
  }));
  router.get('/group-chats/invitations/:token', route({ params: TokenParams, mapError }, async ({ userId, params }, _request, response) => {
    if (!invitations.take(userId)) { sendError(response, 429, 'rate_limited'); return; }
    response.json(GroupChatLinkPreviewSchema.parse(await previewGroupChatLink(await getDb(), userId, params.token)));
  }));
  router.post('/group-chats/invitations/:token/accept', route({ params: TokenParams, mapError }, async ({ userId, params }, _request, response) => {
    if (!invitations.take(userId)) { sendError(response, 429, 'rate_limited'); return; }
    const db = await getDb();
    const chat = await acceptGroupChatLink(db, userId, params.token);
    await publishChanged(db, events, userId, chat.id);
    response.json({ chat: GroupChatSchema.parse(chat) });
  }));
  router.get('/group-chats/:id', route({ params: IdParams, mapError }, async ({ userId, params }, _request, response) => {
    response.json({ chat: GroupChatSchema.parse(await getGroupChat(await getDb(), userId, params.id)) });
  }));
  router.post('/group-chats/:id/links', route({ params: IdParams, mapError }, async ({ userId, params }, _request, response) => {
    if (!invitations.take(userId)) { sendError(response, 429, 'rate_limited'); return; }
    response.status(201).json(LinkSchema.parse(await createGroupChatLink(await getDb(), userId, params.id)));
  }));
  router.post('/group-chats/:id/invitations', freshSession, route({ params: IdParams, body: EmailBody, mapError }, async ({ userId, params, body }, _request, response) => {
    if (!invitations.take(userId) || !emailInvitations.take(userId)) { sendError(response, 429, 'rate_limited'); return; }
    await sendChatInvitation(await getDb(), userId, params.id, body.email);
    response.json({ sent: true });
  }));
  router.delete('/group-chats/:id/links', freshSession, route({ params: IdParams, mapError }, async ({ userId, params }, _request, response) => {
    await revokeGroupChatLinks(await getDb(), userId, params.id);
    response.status(204).end();
  }));
  router.get('/group-chats/:id/members', route({ params: IdParams, mapError }, async ({ userId, params }, _request, response) => {
    response.json(MembersSchema.parse({ members: await listGroupChatMembers(await getDb(), userId, params.id) }));
  }));
  router.delete('/group-chats/:id/members/:userId', freshSession, route({ params: MemberParams, mapError }, async ({ userId, params }, _request, response) => {
    const db = await getDb();
    const before = await listGroupChatMembers(db, userId, params.id);
    await removeGroupChatMember(db, userId, params.id, params.userId);
    events.publish(params.userId, { type: 'conversation.deleted', conversation_id: params.id, updated_at: Date.now() });
    const changedAt = await clearActiveThread(db, params.userId, params.id);
    if (changedAt !== null) events.publish(params.userId, {
      type: 'active.changed', conversation_id: null, title: null, surface: 'activate', changed_at: changedAt,
    });
    // Query as each recipient after revocation; never fan out to a cached audience.
    for (const member of before) {
      if (member.user_id === params.userId) continue;
      try {
        await getGroupChat(db, member.user_id, params.id);
        events.publish(member.user_id, { type: 'conversation.updated', conversation_id: params.id, updated_at: Date.now() });
      } catch (error) {
        if (!(error instanceof StoreNotFoundError)) throw error;
      }
    }
    response.status(204).end();
  }));
  return router;
}
