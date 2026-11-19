/**
 * The Conversations module's HTTP contract: attachment bounds, the chat request, conversation views and updates,
 * the active-conversation pointer and heard-portion PATCH. Shared with the web client through web-schemas.ts.
 */
import { z } from 'zod';
import { OpaqueId, OriginSchema } from '../platform/id-schemas.ts';

/**
 * Attachment bounds. The composer can attach files, so this boundary
 * has to be a real gate rather than a permissive `z.record`: an unvalidated
 * part means an arbitrary base64 blob reaching the store and the provider.
 *
 * Images and PDFs use model file input. Word and UTF-8 text are converted to
 * bounded text by document-attachments before the provider sees them.
 */
export const ATTACHMENT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] as const;
/** Decoded bytes allowed in one attachment. */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
/** Attachments allowed on one message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
/** Decoded bytes allowed across all attachments on one message. */
export const MAX_MESSAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** Characters allowed in an attachment filename (it is stored, never journalled). */
const MAX_ATTACHMENT_FILENAME_CHARS = 255;

const allowedMediaTypes = new Set<string>(ATTACHMENT_MEDIA_TYPES);
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;
const MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;
const BASE64_SUFFIX = ';base64';

/**
 * Splits a base64 `data:` URL into its media type and decoded size, or returns
 * null when the string is not one. Only `data:` URLs are accepted: an
 * `http(s)` or `blob:` attachment URL would make the server (or the provider)
 * fetch an address the reader chose, with no size known in advance.
 */
export function parseAttachmentUrl(url: string): { mediaType: string; bytes: number } | null {
  if (!url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const header = url.slice('data:'.length, comma).toLowerCase();
  if (!header.endsWith(BASE64_SUFFIX)) return null;
  const mediaType = header.slice(0, -BASE64_SUFFIX.length);
  if (!MEDIA_TYPE.test(mediaType)) return null;
  const body = url.slice(comma + 1);
  if (body.length === 0 || body.length % 4 !== 0 || !BASE64_BODY.test(body)) return null;
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return { mediaType, bytes: (body.length / 4) * 3 - padding };
}

/**
 * Decoded size of an ALREADY VALIDATED attachment part, by arithmetic on the
 * base64 length alone. Used on the history path, which re-reads every stored
 * part on every turn and must not re-scan megabytes of base64 to do it.
 * Returns 0 for anything that is not a file part.
 */
export function attachmentBytes(part: unknown): number {
  if (typeof part !== 'object' || part === null) return 0;
  const candidate = part as { type?: unknown; url?: unknown };
  if (candidate.type !== 'file' || typeof candidate.url !== 'string') return 0;
  const url = candidate.url;
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma < 0) return 0;
  const body = url.length - comma - 1;
  if (body <= 0) return 0;
  const padding = url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(body / 4) * 3 - padding);
}

/** The reason a file part is unacceptable, or null when it passes. Never quotes the input. */
function filePartIssue(part: Record<string, unknown>): string | null {
  const { mediaType, url, filename } = part as { mediaType?: unknown; url?: unknown; filename?: unknown };
  if (typeof mediaType !== 'string' || !allowedMediaTypes.has(mediaType.toLowerCase())) {
    return `attachment mediaType must be one of ${ATTACHMENT_MEDIA_TYPES.join(', ')}`;
  }
  if (
    filename !== undefined &&
    (typeof filename !== 'string' || filename.length === 0 || filename.length > MAX_ATTACHMENT_FILENAME_CHARS)
  ) {
    return `attachment filename must be 1-${MAX_ATTACHMENT_FILENAME_CHARS} characters`;
  }
  if (typeof url !== 'string') return 'attachment url must be a base64 data: URL';
  const parsed = parseAttachmentUrl(url);
  if (!parsed) return 'attachment url must be a base64 data: URL';
  if (parsed.mediaType !== mediaType.toLowerCase()) return 'attachment url media type must match mediaType';
  if (parsed.bytes === 0) return 'attachment is empty';
  if (parsed.bytes > MAX_ATTACHMENT_BYTES) return `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`;
  return null;
}

/**
 * Parts stay opaque to us -- the AI SDK owns their shape -- with one
 * exception: a `file` part carries reader-supplied bytes across the wire, so
 * it is validated here rather than tolerated.
 */
const uiPartSchema = z.record(z.string(), z.unknown()).superRefine((part, ctx) => {
  if (part.type !== 'file') return;
  const issue = filePartIssue(part);
  if (issue) ctx.addIssue({ code: 'custom', message: issue });
});

// `id` is required, not optional: the AI SDK's validateUIMessages -- which
// createAgentUIStreamResponse runs before any provider call -- rejects a
// message without one. Declaring it optional here let a bad request pass our
// own validation and fail deep inside the agent, surfacing as 502
// upstream_error and blaming the provider for a client mistake.
const uiMessageSchema = z
  .object({ id: z.string().min(1).max(128), role: z.enum(['system', 'user', 'assistant']), parts: z.array(uiPartSchema).min(1) })
  .superRefine((message, ctx) => {
    const files = message.parts.filter((part) => part.type === 'file');
    if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      ctx.addIssue({
        code: 'custom',
        path: ['parts'],
        message: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`,
      });
    }
    let total = 0;
    for (const file of files) {
      const url = (file as { url?: unknown }).url;
      total += typeof url === 'string' ? (parseAttachmentUrl(url)?.bytes ?? 0) : 0;
    }
    if (total > MAX_MESSAGE_ATTACHMENT_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['parts'],
        message: `attachments exceed ${MAX_MESSAGE_ATTACHMENT_BYTES} bytes for one message`,
      });
    }
  });

/**
 * Which installed app a chat turn is aimed at. Untrusted targeting metadata only:
 * it never grants anything, and the workflow must authorize the installation itself.
 * `channel` is the network the reader has open, if they picked one; omitted means all
 * channels. `campaignId` requests a saved campaign (null means New; omitted follows
 * stored targeting); the workflow must authorize it before any write.
 * `intent` is a run-mode workflow preference, never instructions or
 * authority. `.strict()` refuses owner, grant, campaign, tool, context or approval fields.
 */
export const ChatAppBindingSchema = z
  .object({
    installationId: z.string().uuid(),
    mode: z.enum(['run', 'refine']),
    channel: z.enum(['instagram', 'linkedin']).optional(),
    campaignId: z.string().uuid().nullable().optional(),
    intent: z.enum(['posts', 'campaign']).optional(),
  })
  .strict()
  .refine((binding) => binding.mode === 'run' || binding.intent === undefined, { path: ['intent'], message: 'Workflow intent belongs to run mode.' });

export type ChatAppBinding = z.infer<typeof ChatAppBindingSchema>;

// The client sends the newest user message plus the conversation id; history
// lives server-side.
export const webChatRequestSchema = z
  .object({
    id: z.string().min(1).optional(),
    message: uiMessageSchema,
    regenerate: z.boolean().optional(),
    editFrom: z.string().min(1).optional(),
    // Additive: where the reader spoke this turn. A web client can never claim
    // 'device' -- that origin is written only by the device path.
    origin: z.enum(['web_text', 'web_voice']).optional(),
    workflowId: z.string().uuid().optional(),
    // Additive: edit the FIRST message, which editFrom cannot name because
    // nothing precedes it. Deletes every message, then answers the edited turn.
    editFromStart: z.literal(true).optional(),
    // Additive: the app this turn targets. Targeting only; the workflow authorizes it before any write.
    appBinding: ChatAppBindingSchema.optional(),
    // Additive: a Retry of a turn that failed, which may or may not have stored
    // this message. Stored: it is answered and not appended again. Not: an ordinary send.
    resend: z.literal(true).optional(),
  })
  .superRefine((value, ctx) => {
    const modes = [value.regenerate, value.editFrom, value.editFromStart, value.resend].filter(Boolean).length;
    if (modes > 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'regenerate, editFrom, editFromStart and resend are mutually exclusive',
      });
    }
    // A new conversation has no messages to edit.
    if (value.editFromStart && !value.id) {
      ctx.addIssue({ code: 'custom', path: ['id'], message: 'editFromStart requires an existing conversation id' });
    }
  });

/** One stored message version as returned by GET /api/conversations/:id. */
const ConversationVersionSchema = z.object({
  id: z.string().min(1),
  parts: z.array(z.record(z.string(), z.unknown())),
  versionIndex: z.number().int().nonnegative(),
  selected: z.boolean(),
});

/** One message of a restored conversation; `origin` says which surface spoke it. */
const ConversationMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  position: z.number().int().nonnegative(),
  origin: OriginSchema,
  /** Epoch ms the message was appended. */
  createdAt: z.number(),
  versions: z.array(ConversationVersionSchema),
});

/** GET /api/conversations/:id success body. */
export const ConversationDetailSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messages: z.array(ConversationMessageSchema),
});

/** PATCH /api/conversations/:id: exactly one change per request -- a rename,
 *  a pin toggle or an archive toggle; expectedUpdatedAt guards each. */
export const conversationUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    expectedUpdatedAt: z.number().int().positive().optional(),
  })
  .refine((v) => [v.title, v.pinned, v.archived].filter((f) => f !== undefined).length === 1, {
    message: 'send exactly one of title, pinned, archived',
  });

/** GET /api/conversations query: archived=1 lists only archived conversations. */
export const conversationListFilterSchema = z.object({
  q: z.string().max(200).optional(),
  archived: z.enum(['0', '1']).optional(),
});

/** The action that last changed the pointer (5 values). */
const SurfaceSchema = z.enum(['web_text', 'web_voice', 'device', 'picker', 'activate']);

/** POST /api/conversations/:id/activate: an empty body; the id rides the path. */
export const ActivateRequestSchema = z.object({}).strict();

/** POST /api/conversations/:id/activate success body. */
export const ActivateResponseSchema = z
  .object({ conversation_id: OpaqueId, title: z.string().min(1).max(200) })
  .strict();

/**
 * GET /api/active body. `active: null` means no pointer was ever set;
 * `active: { conversation_id: null, title: null, ... }` means the pointer was
 * set and then cleared (the active conversation was deleted).
 */
export const ActiveResponseSchema = z
  .object({
    active: z
      .object({
        conversation_id: OpaqueId.nullable(),
        title: z.string().min(1).max(200).nullable(),
        surface: SurfaceSchema,
        changed_at: z.number().int().positive(),
      })
      .refine((entry) => (entry.conversation_id === null) === (entry.title === null), {
        message: 'conversation_id and title must both be null or both be set',
      })
      .nullable(),
  })
  .strict();

/**
 * PATCH /api/conversations/:id/messages/:messageId request: the heard portion of
 * an interrupted assistant reply. `heard_chars` is the character offset the
 * client measured (the last fully-heard sentence); `interrupted` must be
 * literally true, so a typo cannot silently drop the marker. `.strict()` refuses
 * any stray field.
 */
export const HearPartsRequestSchema = z
  .object({
    heard_chars: z.number().int().nonnegative(),
    interrupted: z.literal(true),
  })
  .strict();

/** PATCH /api/conversations/:id/messages/:messageId success body. */
export const HearPartsResponseSchema = z
  .object({
    message_id: OpaqueId,
    heard_chars: z.number().int().nonnegative(),
    interrupted: z.literal(true),
  })
  .strict();
