import { z } from 'zod';
import { MIMEType } from 'node:util';
import { Parser } from 'htmlparser2';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_RESPONSE_BYTES = 2_000_000;
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const SearchInput = z.object({
  query: z.string().min(1).max(1000),
  maxResults: z.number().int().min(1).max(20).default(10),
  pageToken: z.string().min(1).max(2048).optional(),
}).strict();
const SearchResult = z.object({
  threads: z.array(z.object({ id: Id, snippet: z.string().max(4000).default('') })).max(20).default([]),
  nextPageToken: z.string().max(2048).optional(),
});
const Header = z.object({ name: z.string().max(200), value: z.string().max(16000) });
const Part = z.object({
  mimeType: z.string().max(200).default(''), filename: z.string().max(1000).default(''),
  headers: z.array(Header).max(200).default([]),
  body: z.object({ data: z.string().max(MAX_RESPONSE_BYTES).optional(), attachmentId: z.string().optional() }).optional(),
  parts: z.array(z.unknown()).max(200).default([]),
});
const Message = z.object({ id: Id, threadId: Id, payload: z.unknown(), snippet: z.string().max(4000).default(''),
  internalDate: z.string().regex(/^\d{1,16}$/).transform(Number).pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).optional() });
const Thread = z.object({ id: Id, messages: z.array(Message).max(1000).default([]) });
const RfcMessageId = z.string().max(200).regex(/^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/);
const DraftInput = z.object({ sourceMessageId: Id, body: z.string().min(1).max(12000), messageId: RfcMessageId }).strict();
export const googleGmailInputs = { identifier: Id, search: SearchInput, reply: DraftInput.omit({ messageId: true }) };
const DraftResult = z.object({ id: Id, message: z.object({ id: Id, threadId: Id }) });
const FindDraftInput = z.object({
  messageId: RfcMessageId, maxResults: z.number().int().min(1).max(20).default(10),
  pageToken: z.string().min(1).max(2048).optional(),
}).strict();
const DraftPage = z.object({ drafts: z.array(DraftResult).max(20).default([]), nextPageToken: z.string().max(2048).optional() });
const DraftMetadata = z.object({ id: Id, message: Message });
interface ReadMessage {
  internalDate: number | null;
  id: string;
  threadId: string;
  date: string;
  subject: string;
  from: string;
  text: string;
  textAvailable: boolean;
  truncated: boolean;
}
interface ReadThread {
  id: string;
  messages: ReadMessage[];
  truncated: boolean;
}

function header(headers: z.infer<typeof Header>[], name: string): string {
  return headers.find((item) => item.name.toLowerCase() === name)?.value ?? '';
}

function decodeText(part: z.infer<typeof Part>): string | undefined {
  if (!['text/plain', 'text/html'].includes(part.mimeType) || part.body?.data === undefined) return undefined;
  const data = part.body.data;
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(data)) throw new GmailProviderError('invalid_response');
  const bytes = Buffer.from(data, 'base64url');
  if (bytes.toString('base64url') !== data.replace(/=+$/, '')) throw new GmailProviderError('invalid_response');
  try {
    const contentType = new MIMEType(header(part.headers, 'content-type') || part.mimeType);
    const charset = contentType.params.get('charset') || 'utf-8';
    return new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function isAttachment(part: z.infer<typeof Part>): boolean {
  return Boolean(part.filename || part.body?.attachmentId)
    || /^attachment(?:\s*;|\s*$)/i.test(header(part.headers, 'content-disposition'));
}

interface ExtractedText { text: string; textAvailable: boolean; truncated: boolean }
const HIDDEN_TAGS = new Set(['head', 'script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'img', 'source', 'video', 'audio']);
const BLOCK_TAGS = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'section']);

function hiddenElement(name: string, attrs: Record<string, string>): boolean {
  if (HIDDEN_TAGS.has(name) || Object.hasOwn(attrs, 'hidden') || attrs['aria-hidden']?.toLowerCase() === 'true') return true;
  // Inline visibility only; external stylesheets are never loaded or evaluated.
  const style = (attrs.style ?? '').replace(/\s/g, '').toLowerCase();
  return /(?:^|;)(?:display:none|visibility:hidden|visibility:collapse)(?:!important)?(?:;|$)/.test(style);
}

function htmlText(html: string): ExtractedText {
  const hidden: boolean[] = [];
  let text = '';
  let nodes = 0;
  let truncated = false;
  function append(value: string): void {
    text += value.slice(0, 12001 - text.length);
    if (text.length > 12000) { truncated = true; parser.pause(); }
  }
  const parser = new Parser({
    onopentag(name, attrs) {
      nodes += 1;
      if (nodes > 10000 || hidden.length >= 100) { truncated = true; parser.pause(); return; }
      hidden.push(Boolean(hidden.at(-1)) || hiddenElement(name, attrs));
      if (!hidden.at(-1) && BLOCK_TAGS.has(name)) append('\n');
    },
    ontext(value) { if (!hidden.at(-1)) append(value); },
    onclosetag(name) {
      const wasHidden = hidden.pop();
      if (!wasHidden && BLOCK_TAGS.has(name)) append('\n');
    },
  }, { decodeEntities: true });
  parser.end(html);
  return { text: text.slice(0, 12000).trim(), textAvailable: true, truncated };
}

function extractText(payload: unknown, budget: { count: number }, depth = 0): ExtractedText {
  budget.count += 1;
  if (budget.count > 200 || depth > 10) throw new GmailProviderError('invalid_response');
  const part = parse(Part, payload, 'invalid_response');
  const empty = { text: '', textAvailable: false, truncated: false };
  if (isAttachment(part)) return empty;
  const decoded = decodeText(part);
  if (decoded !== undefined) {
    return part.mimeType === 'text/html' ? htmlText(decoded)
      : { text: decoded.slice(0, 12000), textAvailable: true, truncated: decoded.length > 12000 };
  }
  const children = part.parts.map((value) => ({ value, part: parse(Part, value, 'invalid_response') }));
  if (part.mimeType === 'multipart/alternative') {
    children.sort((a, b) => Number(b.part.mimeType === 'text/plain') - Number(a.part.mimeType === 'text/plain'));
    for (const child of children) {
      const result = extractText(child.value, budget, depth + 1);
      if (result.textAvailable) return result;
    }
    return empty;
  }
  const results = children.map((child) => extractText(child.value, budget, depth + 1));
  const text = results.filter((result) => result.textAvailable).map((result) => result.text).join('\n');
  return { text: text.slice(0, 12000), textAvailable: results.some((result) => result.textAvailable),
    truncated: text.length > 12000 || results.some((result) => result.truncated) };
}

function readMessage(message: z.infer<typeof Message>): ReadMessage {
  const payload = parse(Part, message.payload, 'invalid_response');
  return { id: message.id, threadId: message.threadId, internalDate: message.internalDate ?? null, date: header(payload.headers, 'date'),
    subject: header(payload.headers, 'subject'), from: header(payload.headers, 'from'), ...extractText(payload, { count: 0 }) };
}

function singleHeader(headers: z.infer<typeof Header>[], name: string): string {
  const matches = headers.filter((item) => item.name.toLowerCase() === name);
  const value = matches[0]?.value ?? '';
  if (matches.length > 1 || /[\x00-\x1f\x7f]/.test(value) || value.length > 900) {
    throw new GmailProviderError('invalid_response');
  }
  return value;
}

function replyRecipient(value: string): string {
  // Deliberately support one simple mailbox. Reject lists, groups, comments and quoted local parts.
  const match = /^(?:[^<>@,;:\r\n]+<)?([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+)>?$/.exec(value.trim());
  if (!match?.[1] || value.includes('<') !== value.endsWith('>')) throw new GmailProviderError('invalid_response');
  return match[1];
}

function encodedSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const words: string[] = [];
  let chunk = '';
  for (const character of subject) {
    if (Buffer.byteLength(chunk + character) > 42) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  return words.join('\r\n ');
}

function replyRaw(source: z.infer<typeof Message>, input: z.infer<typeof DraftInput>): string {
  const { headers } = parse(Part, source.payload, 'invalid_response');
  const recipient = replyRecipient(singleHeader(headers, 'reply-to') || singleHeader(headers, 'from'));
  const subject = singleHeader(headers, 'subject');
  const inReplyTo = parse(RfcMessageId, singleHeader(headers, 'message-id'), 'invalid_response');
  const previous = singleHeader(headers, 'references').trim();
  const references = previous ? previous.split(/ +/) : [];
  for (const reference of references) parse(RfcMessageId, reference, 'invalid_response');
  references.push(inReplyTo);
  const body = Buffer.from(input.body).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  return Buffer.from([
    `To: ${recipient}`, `Subject: ${encodedSubject(subject)}`, `Message-ID: ${input.messageId}`,
    `In-Reply-To: ${inReplyTo}`, `References: ${references.join('\r\n ')}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body,
  ].join('\r\n')).toString('base64url');
}

type ErrorCode = 'invalid_input' | 'invalid_response' | 'response_too_large' | 'unauthorized'
  | 'permission_denied' | 'not_found' | 'rate_limited' | 'unavailable' | 'cancelled';

export class GmailProviderError extends Error {
  constructor(readonly code: ErrorCode, readonly retryAfterSeconds?: number, readonly submissionStarted?: boolean) {
    super(`Gmail provider: ${code}`);
    this.name = 'GmailProviderError';
  }
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(seconds) ? Math.min(3600, Math.max(0, seconds)) : undefined;
}

function requestOptions(token: string, signal: AbortSignal, body?: unknown): RequestInit {
  return {
    method: body === undefined ? 'GET' : 'POST', signal, redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function checkResponse(response: Response): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel();
  throw new GmailProviderError(statusCode(response.status), retryAfter(response));
}

function parse<T>(schema: z.ZodType<T>, value: unknown, code: ErrorCode): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GmailProviderError(code);
  return result.data;
}

function statusCode(status: number): ErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new GmailProviderError('invalid_response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GmailProviderError('response_too_large');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    reader.releaseLock();
  }
}

export function createGmailProviderClient(fetcher: typeof fetch = fetch): {
  search(token: string, input: z.input<typeof SearchInput>, signal: AbortSignal): Promise<z.infer<typeof SearchResult>>;
  readThread(token: string, threadId: string, signal: AbortSignal): Promise<ReadThread>;
  createReplyDraft(token: string, input: z.input<typeof DraftInput>, signal: AbortSignal): Promise<z.infer<typeof DraftResult>>;
  /** An empty page is inconclusive after an uncertain create; never use it to automatically recreate. */
  findReplyDrafts(token: string, input: z.input<typeof FindDraftInput>, signal: AbortSignal): Promise<z.infer<typeof DraftPage>>;
} {
  async function request(token: string, path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    if (signal.aborted) throw new GmailProviderError('cancelled');
    if (!token || /[\r\n]/.test(token)) throw new GmailProviderError('invalid_input');
    try {
      const response = await fetcher(`${API}/${path}`, requestOptions(token, signal, body));
      await checkResponse(response);
      const result = await readJson(response);
      if (signal.aborted) throw new GmailProviderError('cancelled');
      return result;
    } catch (error) {
      if (signal.aborted) throw new GmailProviderError('cancelled');
      if (error instanceof GmailProviderError) throw error;
      throw new GmailProviderError('unavailable');
    }
  }

  return {
    async search(token, input, signal) {
      const validated = parse(SearchInput, input, 'invalid_input');
      const params = new URLSearchParams({ q: validated.query, maxResults: String(validated.maxResults) });
      if (validated.pageToken) params.set('pageToken', validated.pageToken);
      const result = parse(SearchResult, await request(token, `threads?${params}`, signal), 'invalid_response');
      if (result.threads.length > validated.maxResults) throw new GmailProviderError('invalid_response');
      return result;
    },
    async readThread(token, threadId, signal) {
      const id = parse(Id, threadId, 'invalid_input');
      const thread = parse(Thread, await request(token, `threads/${id}?format=full`, signal), 'invalid_response');
      if (thread.id !== id || thread.messages.some((message) => message.threadId !== id)) {
        throw new GmailProviderError('invalid_response');
      }
      try {
        return { id, messages: thread.messages.slice(-10).map(readMessage), truncated: thread.messages.length > 10 };
      } catch (error) {
        if (error instanceof GmailProviderError) throw error;
        throw new GmailProviderError('invalid_response');
      }
    },
    async createReplyDraft(token, input, signal) {
      let submissionStarted = false;
      try {
        const validated = parse(DraftInput, input, 'invalid_input');
        const source = parse(Message, await request(token, `messages/${validated.sourceMessageId}?format=metadata`, signal), 'invalid_response');
        if (source.id !== validated.sourceMessageId) throw new GmailProviderError('invalid_response');
        const raw = replyRaw(source, validated);
        if (signal.aborted) throw new GmailProviderError('cancelled');
        submissionStarted = true;
        const result = parse(DraftResult, await request(token, 'drafts', signal, { message: { threadId: source.threadId, raw } }), 'invalid_response');
        if (result.message.threadId !== source.threadId) throw new GmailProviderError('invalid_response');
        return result;
      } catch (error) {
        if (error instanceof GmailProviderError) throw new GmailProviderError(error.code, error.retryAfterSeconds, submissionStarted);
        throw new GmailProviderError('unavailable', undefined, submissionStarted);
      }
    },
    async findReplyDrafts(token, input, signal) {
      const validated = parse(FindDraftInput, input, 'invalid_input');
      // Avoid Gmail search indexing lag: scan a bounded unfiltered page and inspect the headers.
      const params = new URLSearchParams({ maxResults: String(validated.maxResults) });
      if (validated.pageToken) params.set('pageToken', validated.pageToken);
      const page = parse(DraftPage, await request(token, `drafts?${params}`, signal), 'invalid_response');
      if (page.drafts.length > validated.maxResults) throw new GmailProviderError('invalid_response');
      const drafts: z.infer<typeof DraftResult>[] = [];
      for (const candidate of page.drafts) {
        const draft = parse(DraftMetadata, await request(token, `drafts/${candidate.id}?format=metadata`, signal), 'invalid_response');
        if (draft.id !== candidate.id) throw new GmailProviderError('invalid_response');
        const payload = parse(Part, draft.message.payload, 'invalid_response');
        if (singleHeader(payload.headers, 'message-id') === validated.messageId) {
          drafts.push(parse(DraftResult, draft, 'invalid_response'));
        }
      }
      return { drafts, ...(page.nextPageToken === undefined ? {} : { nextPageToken: page.nextPageToken }) };
    },
  };
}
