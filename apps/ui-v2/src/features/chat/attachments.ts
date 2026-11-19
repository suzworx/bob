import type { FileUIPart } from 'ai';

// The attachment bounds, ported from v1's composer. They mirror
// apps/api/src/web-schemas.ts: the server is the authority and refuses anything
// past them, so these only spare the reader a round trip that would fail.
const ACCEPTED_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] as const;
const DOCUMENT_EXTENSIONS: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
export const ACCEPT_ATTRIBUTE = [...ACCEPTED_MEDIA_TYPES, '.pdf', '.txt', '.doc', '.docx'].join(',');
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

type AttachmentFailure = 'accept' | 'max_file_size' | 'max_files';

// v1's exact messages.
export const ATTACHMENT_ERROR_COPY: Record<AttachmentFailure, string> = {
  accept: 'Choose a PDF, Word document, text file, or PNG, JPEG, WebP or GIF image.',
  max_file_size: 'That file is larger than 4 MB.',
  max_files: `At most ${MAX_ATTACHMENTS} files can be attached to one message.`,
};
export const ATTACHMENT_TOO_MUCH =
  'Those files come to more than 8 MB together. Remove one and send again.';
export const ATTACHMENT_FALLBACK_ERROR = 'That file could not be attached.';

// Decoded size of a base64 data URL, by arithmetic on its length. Four files
// can each be inside the per-file bound and still exceed the per-message one,
// so the total is measured from what will actually be sent.
export function attachmentBytes(url: string | undefined): number {
  const comma = url?.indexOf(',') ?? -1;
  if (!url?.startsWith('data:') || comma < 0) return 0;
  const body = url.length - comma - 1;
  const padding = url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(body / 4) * 3 - padding);
}

function messageAttachmentBytes(files: readonly Pick<FileUIPart, 'url'>[]): number {
  return files.reduce((sum, file) => sum + attachmentBytes(file.url), 0);
}

export function isOverMessageBound(files: readonly Pick<FileUIPart, 'url'>[]): boolean {
  return messageAttachmentBytes(files) > MAX_MESSAGE_ATTACHMENT_BYTES;
}

function isAcceptedType(type: string): boolean {
  return (ACCEPTED_MEDIA_TYPES as readonly string[]).includes(type);
}

function fileMediaType(file: File): string {
  if (file.type && file.type !== 'application/octet-stream') return file.type.toLowerCase();
  return DOCUMENT_EXTENSIONS[file.name.split('.').at(-1)?.toLowerCase() ?? ''] ?? file.type;
}

// Checks a batch of picked, pasted or dropped files against the ones already
// staged. Like v1's PromptInput, a batch is all-or-nothing: the first rule it
// breaks refuses the whole batch and names that rule.
export function validateFiles(
  incoming: readonly File[],
  stagedCount: number,
): { accepted: File[] } | { error: string } {
  if (incoming.length === 0) return { accepted: [] };
  if (incoming.some((file) => !isAcceptedType(fileMediaType(file)))) {
    return { error: ATTACHMENT_ERROR_COPY.accept };
  }
  if (incoming.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
    return { error: ATTACHMENT_ERROR_COPY.max_file_size };
  }
  if (stagedCount + incoming.length > MAX_ATTACHMENTS) {
    return { error: ATTACHMENT_ERROR_COPY.max_files };
  }
  return { accepted: [...incoming] };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('unreadable'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}

// A picked file as the AI SDK's file part: a data URL, the media type and the
// filename.
export async function fileToPart(file: File): Promise<FileUIPart> {
  const mediaType = fileMediaType(file);
  const data = await readAsDataUrl(file);
  const url = `data:${mediaType};base64,${data.slice(data.indexOf(',') + 1)}`;
  return { type: 'file', mediaType, filename: file.name, url };
}
