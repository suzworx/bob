/**
 * REST routes for spaces, membership and invitations.
 *
 * The identity-leak rule is the point of the error mapping: a caller who
 * cannot see a space and a missing space are the SAME 404 not_found; a 403 is
 * returned only when the caller can see the space but lacks the role, so a 403
 * never reveals that a space exists.
 *
 * GET /api/invitations/:token (the preview) is deliberately account-less: it
 * is the one path a non-member may reach, and it returns metadata only.
 * Journal events carry ids and counts only.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { getAccountEvents } from '../devices/pairing-service.ts';
import { StoreError, StoreNotFoundError, type Db } from '../platform/db/db.ts';
import { route, sendError } from '../platform/http/route.ts';
import { moduleJournal } from '../platform/logger.ts';
import {
  acceptInvitation,
  inviteToSpace,
} from '../workflows/workflow-space-invitation.ts';
import {
  archiveSpace,
  publishSpaceAccessChange,
  removeMember,
  transferOwner,
  type AccountEventSink,
} from '../workflows/workflow-space-membership-change.ts';
import {
  listInvitations,
  previewInvitation,
  revokeInvitation,
  StoreForbiddenError,
  type InvitationPreview,
  type StoredInvitation,
} from './invitations.ts';
import { setMemberRole } from './member-roles.ts';
import {
  createSpace,
  getSpace,
  listMembers,
  listSpaces,
  renameSpace,
  restoreSpace,
  SpaceRuleError,
  type SpaceMember,
  type StoredSpace,
} from './store.ts';

const journal = moduleJournal('spaces');

const Uuid = z.string().uuid();

// `kind` is only validated: every web-created space is owned by its creator.
// Released clients still send 'pair' or 'group'.
const CreateSpaceRequestSchema = z
  .object({
    kind: z.enum(['pair', 'group']).optional(),
    name: z.string().trim().min(1).max(60),
  })
  .strict();

const CreateInvitationRequestSchema = z
  .object({ email: z.string().email(), role: z.enum(['admin', 'member']) })
  .strict();

const MemberRoleRequestSchema = z.object({ role: z.enum(['admin', 'member']) }).strict();

const TransferOwnerRequestSchema = z.object({ user_id: Uuid }).strict();

const UpdateSpaceRequestSchema = z
  .object({ name: z.string().trim().min(1).max(60).optional(), archived: z.literal(false).optional() })
  .strict()
  .refine((body) => (body.name === undefined) !== (body.archived === undefined));

const ListSpacesQuerySchema = z.object({ archived: z.enum(['true', 'false']).optional() });

const IdParams = z.object({ id: Uuid });
const MemberParams = z.object({ id: Uuid, userId: Uuid });
const TokenParams = z.object({ token: z.string().min(1) });

const ACCEPT_STATUS: Record<string, number> = {
  accepted: 200,
  already_accepted: 200,
  already_member: 200,
  expired: 410,
  revoked: 410,
  email_mismatch: 403,
  not_found: 404,
};

interface SpacesRouterDeps {
  getDb: () => Promise<Db>;
  requireActiveSession: (request: Request, response: Response, next: NextFunction) => Promise<void>;
  events?: AccountEventSink;
}

/** The spaces store signals a role refusal with these stable messages. */
const FORBIDDEN_MESSAGES: readonly string[] = [
  'only an owner or admin can add members',
  'only the owner can transfer ownership',
  'only an owner or admin can rename a space',
  'only the owner can archive or restore a space',
];

function isRoleRefusal(error: unknown): boolean {
  if (error instanceof StoreForbiddenError) return true;
  if (error instanceof StoreError) {
    return FORBIDDEN_MESSAGES.some((message) => error.message.includes(message));
  }
  return false;
}

function mapError(response: Response, error: unknown): void {
  if (error instanceof StoreNotFoundError) {
    sendError(response, 404, 'not_found');
    return;
  }
  if (error instanceof SpaceRuleError) {
    sendError(response, 409, error.code);
    return;
  }
  if (isRoleRefusal(error)) {
    sendError(response, 403, 'forbidden');
    return;
  }
  if (error instanceof StoreError) {
    sendError(response, 500, 'store_error');
    return;
  }
  throw error;
}

function toSpaceSummary(space: StoredSpace): Record<string, unknown> {
  return {
    id: space.id,
    kind: space.kind,
    name: space.name,
    role: space.role,
    membership_revision: space.membershipRevision,
    created_at: space.createdAt,
    updated_at: space.updatedAt,
    archived_at: space.archivedAt,
    // Listing aggregates (GET /api/spaces only): the rail's unread badge and
    // the All spaces rows read these instead of fetching every thread list.
    ...(space.unreadCount === undefined ? {} : { unread_count: space.unreadCount }),
    ...(space.threadCount === undefined ? {} : { thread_count: space.threadCount }),
    ...(space.lastActivityAt === undefined ? {} : { last_activity_at: space.lastActivityAt }),
  };
}

function toMemberSummary(member: SpaceMember): Record<string, unknown> {
  return {
    user_id: member.userId,
    role: member.role,
    joined_at: member.joinedAt,
    display_name: member.displayName,
    handle: member.handle,
    email: member.email,
  };
}

function toInvitationSummary(invitation: StoredInvitation): Record<string, unknown> {
  return {
    id: invitation.id,
    space_id: invitation.spaceId,
    invited_email: invitation.invitedEmail,
    role: invitation.role,
    expires_at: invitation.expiresAt,
    created_at: invitation.createdAt,
  };
}

function toPreviewSummary(preview: InvitationPreview): Record<string, unknown> {
  return {
    space_name: preview.spaceName,
    space_kind: preview.spaceKind,
    inviter_display_name: preview.inviterDisplayName,
    exposes_history: preview.exposesHistory,
    role: preview.role,
    expires_at: preview.expiresAt,
  };
}

export function createSpacesRouter({
  getDb,
  requireActiveSession,
  events = getAccountEvents(),
}: SpacesRouterDeps): Router {
  const router = Router();

  router.get('/spaces', route({ query: ListSpacesQuerySchema, mapError }, async ({ query, userId }, _request, response) => {
    const spaces = await listSpaces(await getDb(), userId, { archived: query.archived === 'true' });
    journal('v2.spaces_listed', { count: spaces.length });
    response.status(200).json({ spaces: spaces.map(toSpaceSummary) });
  }));

  router.post('/spaces', route({ body: CreateSpaceRequestSchema, mapError }, async ({ body, userId }, _request, response) => {
    const space = await createSpace(await getDb(), userId, body);
    journal('v2.space_created', { space_id: space.id, kind: space.kind });
    response.status(201).json(toSpaceSummary(space));
  }));

  router.get('/spaces/:id', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const space = await getSpace(await getDb(), userId, params.id);
    response.status(200).json(toSpaceSummary(space));
  }));

  router.patch('/spaces/:id', route({ body: UpdateSpaceRequestSchema, params: IdParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const db = await getDb();
      if (body.archived === false) {
        const space = await restoreSpace(db, userId, params.id);
        journal('v2.space_restored', { space_id: params.id });
        response.status(200).json(toSpaceSummary(space));
        return;
      }
      const space = await renameSpace(db, userId, params.id, body.name as string);
      journal('v2.space_renamed', { space_id: params.id });
      response.status(200).json(toSpaceSummary(space));
    }));

  router.delete('/spaces/:id', requireActiveSession, route({ params: IdParams, mapError },
    async ({ params: { id }, userId }, _request, response) => {
      const space = await archiveSpace({ db: await getDb(), events }, { actorUserId: userId, spaceId: id });
      response.status(200).json(toSpaceSummary(space));
    }));

  router.get('/spaces/:id/members', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const members = await listMembers(await getDb(), userId, params.id);
    response.status(200).json({ members: members.map(toMemberSummary) });
  }));

  router.delete('/spaces/:id/members/:userId', route({ params: MemberParams, mapError },
    async ({ params, userId }, _request, response) => {
      await removeMember({ db: await getDb(), events }, {
        actorUserId: userId,
        spaceId: params.id,
        targetUserId: params.userId,
      });
      response.status(204).end();
    }));

  router.patch('/spaces/:id/members/:userId', requireActiveSession, route({ body: MemberRoleRequestSchema, params: MemberParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const changed = await setMemberRole(await getDb(), userId, params.id, params.userId, body.role);
      journal('v2.member_role_changed', { space_id: params.id, role: body.role, changed });
      if (changed) publishSpaceAccessChange(events, params.id, [params.userId]);
      response.status(204).end();
    }));

  router.put('/spaces/:id/owner', requireActiveSession, route({ body: TransferOwnerRequestSchema, params: IdParams, mapError },
    async ({ body, params, userId }, _request, response) => {
      const space = await transferOwner({ db: await getDb(), events }, {
        actorUserId: userId,
        spaceId: params.id,
        newOwnerUserId: body.user_id,
      });
      response.status(200).json(toSpaceSummary(space));
    }));

  router.get('/spaces/:id/invitations', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    const invitations = await listInvitations(await getDb(), userId, params.id);
    response.status(200).json({ invitations: invitations.map(toInvitationSummary) });
  }));

  router.post('/spaces/:id/invitations', route({ body: CreateInvitationRequestSchema, params: IdParams, mapError },
    async ({ body, params: { id: spaceId }, userId }, _request, response) => {
      const outcome = await inviteToSpace({ db: await getDb() }, { actorUserId: userId, spaceId, body });
      if (outcome.kind === 'archived') {
        sendError(response, 409, 'space_archived');
        return;
      }
      // The token stays in the response so the copy-link fallback works
      // whether or not the email went out.
      response.status(201).json({
        invitation: toInvitationSummary(outcome.invitation),
        token: outcome.token,
        email_sent: outcome.emailSent,
        account_created: outcome.accountCreated,
      });
    }));

  router.delete('/invitations/:id', route({ params: IdParams, mapError }, async ({ params, userId }, _request, response) => {
    await revokeInvitation(await getDb(), userId, params.id);
    journal('v2.invitation_revoked', { invitation_id: params.id });
    response.status(204).end();
  }));

  router.get('/invitations/:token', route({ params: TokenParams, auth: false, mapError },
    async ({ params }, _request, response) => {
      const preview = await previewInvitation(await getDb(), params.token);
      if (!preview) {
        sendError(response, 404, 'not_found');
        return;
      }
      journal('v2.invitation_previewed', {});
      response.status(200).json({ preview: toPreviewSummary(preview) });
    }));

  router.post('/invitations/:token/accept', route({ params: TokenParams, mapError },
    async ({ params: { token }, userId }, _request, response) => {
      const outcome = await acceptInvitation({ db: await getDb() }, { actorUserId: userId, token });
      response.status(ACCEPT_STATUS[outcome] ?? 404).json({ status: outcome });
    }));

  return router;
}
