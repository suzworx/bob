import { createHash } from 'node:crypto';
import { z } from 'zod';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const LIMIT = 200_000;
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const Address = z.string().max(254).email().regex(/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/);
const Addresses = z.array(Address).max(20);
const Subject = z.string().max(998).regex(/^[^\x00-\x1f\x7f]*$/);
const Body = z.string().max(12000);
const RfcId = z.string().max(200).regex(/^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/);
const Content = z.object({ to: Addresses.min(1), cc: Addresses.default([]), bcc: Addresses.default([]), subject: Subject, body: Body }).strict();
const Compose = Content.extend({ messageId: RfcId });
const Patch = Content.partial().strict();
const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const Search = z.object({ messageId: RfcId, pageToken: z.string().min(1).max(2048).optional() }).strict();
const Target = z.object({ draftId: Id, expectedFingerprint: Fingerprint }).strict();
const Update = Target.extend({ content: Content, messageId: RfcId });
const Message = z.object({ id: Id, threadId: Id, labelIds: z.array(z.string().max(100)).max(100).default([]) });
const Draft = z.object({ id: Id, message: Message });
const RawDraft = z.object({ id: Id, message: Message.extend({ raw: z.string().max(LIMIT) }) });
const Metadata = Message.extend({ payload: z.object({ headers: z.array(z.object({ name: z.string().max(200), value: z.string().max(2000) })).max(200) }).optional() });


type Code = 'invalid_input' | 'invalid_response' | 'unsupported_draft' | 'conflict' | 'cancelled' | 'unauthorized' | 'permission_denied' | 'not_found' | 'rate_limited' | 'unavailable';
export class GoogleMailActionsError extends Error {
  constructor(readonly code: Code, readonly submissionStarted = false) { super(`Gmail actions: ${code}`); this.name = 'GoogleMailActionsError'; }
}
function parse<T>(schema: z.ZodType<T>, input: unknown, code: Code = 'invalid_input'): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new GoogleMailActionsError(code);
  return result.data;
}
function encodeSubject(value: string): string {
  const chunks: string[] = [];
  let part = '';
  for (const character of value) {
    if (Buffer.byteLength(part + character) > 42) { chunks.push(part); part = ''; }
    part += character;
  }
  chunks.push(part);
  return chunks.map((chunk) => `=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`).join('\r\n ');
}
function bodyBase64(body: string): string { return Buffer.from(body).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''; }
function rawContent(input: z.infer<typeof Compose>): string {
  return [`To: ${input.to.join(', ')}`, `Cc: ${input.cc.join(', ')}`, `Bcc: ${input.bcc.join(', ')}`,
    `Subject: ${encodeSubject(input.subject)}`, `Message-ID: ${input.messageId}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', bodyBase64(input.body)].join('\r\n');
}
interface ParsedRaw { headers: string[]; bodyRaw: string; content: z.infer<typeof Compose> }
function headerValues(headers: string[]): Map<string, string> {

  const values = new Map<string, string>();
  for (const line of headers) {
    const match = /^([A-Za-z0-9-]+):[ \t]*(.*)$/s.exec(line);
    if (!match?.[1] || match[2] === undefined) throw new GoogleMailActionsError('unsupported_draft');
    const key = match[1].toLowerCase();
    if (values.has(key)) throw new GoogleMailActionsError('unsupported_draft');
    values.set(key, match[2].replace(/\r\n[ \t]+/g, ' '));
  }
  return values;
}
function parseRaw(raw: string): ParsedRaw {
  const split = raw.indexOf('\r\n\r\n');
  if (split < 0) throw new GoogleMailActionsError('unsupported_draft');
  const headers = raw.slice(0, split).split(/\r\n(?![ \t])/);
  const values = headerValues(headers);
  if (!/^text\/plain;\s*charset="?utf-8"?$/i.test(values.get('content-type') ?? '')
    || values.get('content-transfer-encoding')?.toLowerCase() !== 'base64') throw new GoogleMailActionsError('unsupported_draft');
  const bodyRaw = raw.slice(split + 4);
  const encoded = bodyRaw.replace(/\r\n/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new GoogleMailActionsError('unsupported_draft');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new GoogleMailActionsError('unsupported_draft');
  let body: string;
  try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new GoogleMailActionsError('unsupported_draft'); }
  const subject = (values.get('subject') ?? '').replace(/(\?=)\s+(=\?)/g, '$1$2').replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/gi, (_all, data: string) => Buffer.from(data, 'base64').toString('utf8'));
  const addresses = (name: string): string[] => (values.get(name) ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  const content = parse(Compose, { to: addresses('to'), cc: addresses('cc'), bcc: addresses('bcc'), subject, body, messageId: values.get('message-id') }, 'unsupported_draft');
  return { headers, bodyRaw, content };
}
function replaceMarker(raw: string, messageId: string): string {
  return raw.replace(/^Message-ID:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*/im, `Message-ID: ${messageId}`);
}
function updatedRaw(raw: ParsedRaw, patch: z.infer<typeof Patch>): string {
  const replacements = new Map<string, string>();
  for (const key of ['to', 'cc', 'bcc'] as const) if (patch[key] !== undefined) replacements.set(key, `${key}: ${patch[key].join(', ')}`);
  if (patch.subject !== undefined) replacements.set('subject', `Subject: ${encodeSubject(patch.subject)}`);
  const headers = raw.headers.map((line) => {
    const key = line.slice(0, line.indexOf(':')).toLowerCase();
    const replacement = replacements.get(key);
    replacements.delete(key);
    return replacement ?? line;
  });
  headers.push(...replacements.values());
  return `${headers.join('\r\n')}\r\n\r\n${patch.body === undefined ? raw.bodyRaw : bodyBase64(patch.body)}`;
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new GoogleMailActionsError('invalid_response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) { await reader.cancel(); throw new GoogleMailActionsError('invalid_response'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { reader.releaseLock(); }
}
function statusCode(status: number): Code {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}
function requestError(error: unknown, aborted: boolean, writing: boolean): GoogleMailActionsError {
  if (error instanceof GoogleMailActionsError) {
    return error.code === 'invalid_response' ? new GoogleMailActionsError(error.code, writing) : error;
  }
  return new GoogleMailActionsError(aborted ? 'cancelled' : 'unavailable', writing);
}
interface DraftView extends z.infer<typeof Compose> { id: string; message: z.infer<typeof Message>; fingerprint: string }
interface MessageView extends z.infer<typeof Message> { rfcMessageId: string }
interface GmailActionsClient {
  composeDraft(token: string, input: { content: z.infer<typeof Content>; messageId: string }, signal: AbortSignal): Promise<{ id: string }>;
  readDraft(token: string, draftId: string, signal: AbortSignal): Promise<{ id: string; fingerprint: string; rfcMessageId: string | null; content: z.infer<typeof Content> }>;
  updateDraft(token: string, input: { draftId: string; expectedFingerprint: string; content: z.infer<typeof Content>; messageId: string }, signal: AbortSignal): Promise<{ id: string }>;
  sendDraft(token: string, input: { draftId: string; expectedFingerprint: string; content: z.infer<typeof Content>; messageId: string }, signal: AbortSignal): Promise<{ id: string }>;
  findDrafts(token: string, input: { messageId: string; pageToken?: string }, signal: AbortSignal): Promise<{ drafts: { id: string }[]; nextPageToken?: string }>;
  findSent(token: string, input: { messageId: string; pageToken?: string }, signal: AbortSignal): Promise<{ messages: { id: string }[]; nextPageToken?: string }>;
  readMessageState(token: string, messageId: string, signal: AbortSignal): Promise<{ id: string; labelIds: string[] }>;
  trashMessage(token: string, messageId: string, signal: AbortSignal): Promise<{ id: string }>;
  restoreMessage(token: string, messageId: string, signal: AbortSignal): Promise<{ id: string }>;
}
export function createGoogleMailActionsClient(fetcher: typeof fetch = fetch): GmailActionsClient {
  async function request<T>(token: string, path: string, signal: AbortSignal, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
    if (signal.aborted) throw new GoogleMailActionsError('cancelled');
    if (!token || /[\x00-\x20\x7f]/.test(token)) throw new GoogleMailActionsError('invalid_input');
    const combined = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const writing = method !== 'GET';
    try {
      const response = await fetcher(`${API}/${path}`, { method, redirect: 'error', signal: combined,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) { await response.body?.cancel(); throw new GoogleMailActionsError(statusCode(response.status), writing && response.status >= 500); }
      return parse(schema, await boundedJson(response), 'invalid_response');
    } catch (error) {
      throw requestError(error, combined.aborted, writing);
    }
  }
  async function readRaw(token: string, id: string, signal: AbortSignal): Promise<{ view: DraftView; raw: string; parsed: ParsedRaw }> {
    const safeId = parse(Id, id);
    const draft = await request(token, `drafts/${safeId}?format=raw`, signal, RawDraft);
    if (draft.id !== safeId || !/^[A-Za-z0-9_-]+={0,2}$/.test(draft.message.raw)) throw new GoogleMailActionsError('invalid_response');
    const bytes = Buffer.from(draft.message.raw, 'base64url');
    if (bytes.toString('base64url') !== draft.message.raw.replace(/=+$/, '')) throw new GoogleMailActionsError('invalid_response');
    const raw = bytes.toString('utf8');
    const parsed = parseRaw(raw);
    return { raw, parsed, view: { ...parsed.content, id: draft.id, message: parse(Message, draft.message), fingerprint: createHash('sha256').update(bytes).digest('hex') } };
  }
  async function checkedDraft(token: string, input: z.infer<typeof Target>, signal: AbortSignal): ReturnType<typeof readRaw> {
    const draft = await readRaw(token, input.draftId, signal);
    if (draft.view.fingerprint !== input.expectedFingerprint) throw new GoogleMailActionsError('conflict');
    return draft;
  }
  async function metadata(token: string, id: string, signal: AbortSignal): Promise<MessageView> {
    const safeId = parse(Id, id);
    const result = await request(token, `messages/${safeId}?format=metadata&metadataHeaders=Message-ID`, signal, Metadata);
    if (result.id !== safeId) throw new GoogleMailActionsError('invalid_response');
    const ids = result.payload?.headers.filter((h) => h.name.toLowerCase() === 'message-id') ?? [];
    if (ids.length !== 1) throw new GoogleMailActionsError('invalid_response');
    return { ...parse(Message, result), rfcMessageId: parse(RfcId, ids[0]?.value, 'invalid_response') };
  }
  return {
    async composeDraft(token, input, signal) {
      const content = parse(Compose, { ...input.content, messageId: input.messageId });
      return request(token, 'drafts', signal, Draft, 'POST', { message: { raw: Buffer.from(rawContent(content)).toString('base64url') } });
    },
    async readDraft(token, id, signal) {
      const { view } = await readRaw(token, id, signal);
      const { id: _id, message: _message, fingerprint: _fingerprint, messageId, ...content } = view;
      return { id: view.id, fingerprint: view.fingerprint, rfcMessageId: messageId, content };
    },
    async updateDraft(token, input, signal) {
      const validated = parse(Update, input);
      const draft = await checkedDraft(token, validated, signal);
      // Gmail has no documented conditional draft update. Detect prior edits, but GET/PUT is not atomic.
      return request(token, `drafts/${validated.draftId}`, signal, Draft, 'PUT', { id: validated.draftId,
        message: { threadId: draft.view.message.threadId, raw: Buffer.from(replaceMarker(updatedRaw(draft.parsed, validated.content), validated.messageId)).toString('base64url') } });
    },
    async sendDraft(token, input, signal) {
      const validated = parse(Update, input);
      const draft = await checkedDraft(token, validated, signal);
      // Send the reviewed bytes, not whatever an external editor places in this draft after the GET.
      return request(token, 'drafts/send', signal, Message, 'POST', { id: validated.draftId,
        message: { threadId: draft.view.message.threadId, raw: Buffer.from(replaceMarker(updatedRaw(draft.parsed, validated.content), validated.messageId)).toString('base64url') } });
    },
    async trashMessage(token, id, signal) { return request(token, `messages/${parse(Id, id)}/trash`, signal, Message, 'POST', {}); },
    async restoreMessage(token, id, signal) { return request(token, `messages/${parse(Id, id)}/untrash`, signal, Message, 'POST', {}); },
    async readMessageState(token, id, signal) {
      const safeId = parse(Id, id);
      const result = await request(token, `messages/${safeId}?format=minimal`, signal, Message);
      if (result.id !== safeId) throw new GoogleMailActionsError('invalid_response');
      return result;
    },
    async findDrafts(token, input, signal) {
      const validated = parse(Search, input);
      const query = new URLSearchParams({ q: `rfc822msgid:${validated.messageId}`, maxResults: '20' });
      if (validated.pageToken) query.set('pageToken', validated.pageToken);
      const page = await request(token, `drafts?${query}`, signal, z.object({ drafts: z.array(z.object({ id: Id })).max(20).default([]), nextPageToken: z.string().max(2048).optional() }));
      const drafts: { id: string }[] = [];
      for (const candidate of page.drafts) {
        const value = await request(token, `drafts/${candidate.id}?format=metadata`, signal, z.object({ id: Id, message: Metadata }));
        if (value.id !== candidate.id) throw new GoogleMailActionsError('invalid_response');
        const ids = value.message.payload?.headers.filter((h) => h.name.toLowerCase() === 'message-id') ?? [];
        if (ids.length === 1 && ids[0]?.value === validated.messageId) drafts.push({ id: value.id });
      }
      return { drafts, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
    },
    async findSent(token, input, signal) {
      const validated = parse(Search, input);
      const rfcId = validated.messageId;
      const query = new URLSearchParams({ q: `in:sent rfc822msgid:${rfcId}`, maxResults: '20' });
      if (validated.pageToken) query.set('pageToken', validated.pageToken);
      const page = await request(token, `messages?${query}`, signal, z.object({ messages: z.array(z.object({ id: Id })).max(20).default([]), nextPageToken: z.string().optional() }));
      const messages: MessageView[] = [];
      for (const item of page.messages) {
        const message = await metadata(token, item.id, signal);
        if (message.rfcMessageId === rfcId && message.labelIds.includes('SENT')) messages.push(message);
      }
      // Search indexing may lag; an empty result never authorizes resending.
      return { messages, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
    },
  };
}
