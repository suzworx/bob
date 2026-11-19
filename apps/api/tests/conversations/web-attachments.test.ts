/**
 * Vitest suite for the attachment wire boundary (FR-051): the media-type
 * allow-list, the per-file and per-message size bounds, the data-URL-only
 * rule, and the history replay budget that keeps a bounded per-message limit
 * from becoming an unbounded per-turn one.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  audioFormatSchema: z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']),
  bobAgent: { version: 'agent-v1' as const, id: 'test-agent', tools: {}, stream: vi.fn() },
  BOB_SYSTEM_TEST_MODE: false,
  AI_STUB_MODE: false,
}) ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

import {
  ATTACHMENT_MEDIA_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  attachmentBytes,
  parseAttachmentUrl,
  webChatRequestSchema,
} from '../../src/web-schemas.ts';
import { MAX_HISTORY_ATTACHMENTS, MAX_HISTORY_ATTACHMENT_BYTES, boundHistoryAttachments } from '../../src/conversations/chat-http.ts';

/** A base64 body of exactly `bytes` decoded bytes (no padding: bytes is a multiple of 3). */
function base64OfSize(bytes: number): string {
  const rounded = Math.ceil(bytes / 3) * 3;
  return 'A'.repeat((rounded / 3) * 4);
}

function imagePart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'file',
    mediaType: 'image/png',
    filename: 'diagram.png',
    url: 'data:image/png;base64,iVBORw0KGgo=',
    ...overrides,
  };
}

function request(parts: Array<Record<string, unknown>>): unknown {
  return { message: { id: 'u1', role: 'user', parts } };
}

const accepts = (parts: Array<Record<string, unknown>>): boolean =>
  webChatRequestSchema.safeParse(request(parts)).success;

describe('attachment wire boundary (FR-051)', () => {
  it('accepts a valid image attachment alongside text', () => {
    expect(accepts([{ type: 'text', text: 'what is this?' }, imagePart()])).toBe(true);
  });

  it('accepts every media type on the allow-list, and only a data: URL for it', () => {
    for (const mediaType of ATTACHMENT_MEDIA_TYPES) {
      expect(accepts([imagePart({ mediaType, url: `data:${mediaType};base64,QUJDRA==` })])).toBe(true);
    }
  });

  it('rejects a media type off the allow-list', () => {
    for (const mediaType of ['application/zip', 'text/html', 'image/svg+xml', 'audio/mpeg']) {
      expect(accepts([imagePart({ mediaType, url: `data:${mediaType};base64,QUJDRA==` })])).toBe(false);
    }
  });

  it('rejects a single attachment past the per-file bound', () => {
    const oversized = base64OfSize(MAX_ATTACHMENT_BYTES + 3);
    expect(accepts([imagePart({ url: `data:image/png;base64,${oversized}` })])).toBe(false);
    const largest = base64OfSize(MAX_ATTACHMENT_BYTES - 3);
    expect(accepts([imagePart({ url: `data:image/png;base64,${largest}` })])).toBe(true);
  });

  it('rejects more attachments than one message may carry', () => {
    const parts = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => imagePart());
    expect(accepts(parts)).toBe(false);
    expect(accepts(parts.slice(0, MAX_ATTACHMENTS_PER_MESSAGE))).toBe(true);
  });

  it('rejects attachments that together exceed the per-message byte bound', () => {
    // Three files, each inside the per-file bound, past the per-message one.
    const each = base64OfSize(Math.floor(MAX_MESSAGE_ATTACHMENT_BYTES / 2));
    const parts = Array.from({ length: 3 }, () => imagePart({ url: `data:image/png;base64,${each}` }));
    expect(accepts(parts)).toBe(false);
  });

  it('rejects a fetchable or unreadable attachment URL', () => {
    for (const url of [
      'https://example.invalid/photo.png',
      'blob:http://localhost:5173/9f0e',
      'data:image/png,notbase64',
      'data:image/png;base64,###',
      'data:image/png;base64,',
      'photo.png',
    ]) {
      expect(accepts([imagePart({ url })])).toBe(false);
    }
  });

  it('rejects an attachment whose declared type disagrees with its data URL', () => {
    expect(accepts([imagePart({ mediaType: 'image/png', url: 'data:image/gif;base64,QUJDRA==' })])).toBe(false);
  });

  it('rejects an unusable filename but tolerates its absence', () => {
    expect(accepts([imagePart({ filename: 'x'.repeat(256) })])).toBe(false);
    expect(accepts([imagePart({ filename: '' })])).toBe(false);
    expect(accepts([imagePart({ filename: 42 })])).toBe(false);
    const { filename: _dropped, ...withoutName } = imagePart();
    expect(accepts([withoutName])).toBe(true);
  });

  it('leaves non-file parts opaque, as the SDK owns their shape', () => {
    expect(accepts([{ type: 'text', text: 'hi' }])).toBe(true);
    expect(accepts([{ type: 'reasoning', text: 'thinking', state: 'done' }])).toBe(true);
    expect(accepts([{ type: 'tool-clock', state: 'output-available', output: { now: 1 } }])).toBe(true);
  });

  it('measures decoded size from the base64 body', () => {
    expect(parseAttachmentUrl('data:image/png;base64,QUJDRA==')?.bytes).toBe(4);
    expect(parseAttachmentUrl('data:image/png;base64,QUJD')?.bytes).toBe(3);
    expect(parseAttachmentUrl('not a data url')).toBeNull();
    expect(attachmentBytes(imagePart({ url: 'data:image/png;base64,QUJDRA==' }))).toBe(4);
    expect(attachmentBytes({ type: 'text', text: 'hello' })).toBe(0);
    expect(attachmentBytes(null)).toBe(0);
  });
});

describe('history attachment replay budget', () => {
  const file = (bytes: number): Record<string, unknown> =>
    imagePart({ url: `data:image/png;base64,${base64OfSize(bytes)}` });

  it('keeps the newest attachments and drops the oldest past the budget', () => {
    const messages = [
      { id: 'a', role: 'user', parts: [{ type: 'text', text: 'oldest' }, file(600)] },
      { id: 'b', role: 'user', parts: [{ type: 'text', text: 'middle' }, file(600)] },
      { id: 'c', role: 'user', parts: [{ type: 'text', text: 'newest' }, file(600)] },
    ];
    const bounded = boundHistoryAttachments(messages, 1_500);
    // Every message survives; only the oldest message's bytes are dropped.
    expect(bounded.map((message) => message.id)).toEqual(['a', 'b', 'c']);
    expect(bounded[0]!.parts).toEqual([{ type: 'text', text: 'oldest' }]);
    expect(bounded[1]!.parts).toHaveLength(2);
    expect(bounded[2]!.parts).toHaveLength(2);
  });

  it('drops a message left with nothing but a dropped attachment', () => {
    const messages = [
      { id: 'a', role: 'user', parts: [file(600)] },
      { id: 'b', role: 'user', parts: [{ type: 'text', text: 'newest' }] },
    ];
    expect(boundHistoryAttachments(messages, 100).map((message) => message.id)).toEqual(['b']);
  });

  it('passes an attachment-free history through untouched', () => {
    const messages = [{ id: 'a', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
    expect(boundHistoryAttachments(messages)).toEqual(messages);
  });

  it('bounds a turn well below what unbounded replay of full messages would cost', () => {
    expect(MAX_HISTORY_ATTACHMENT_BYTES).toBeLessThan(40 * MAX_MESSAGE_ATTACHMENT_BYTES);
  });

  const imageCount = (messages: Array<{ parts: unknown[] }>): number =>
    messages.reduce((total, message) => total + message.parts.filter((part) => attachmentBytes(part) > 0).length, 0);

  it('replays only the newest MAX_HISTORY_ATTACHMENTS images, well under the byte budget', () => {
    const messages = ['m0', 'm1', 'm2', 'm3', 'm4'].map((id) => ({
      id, role: 'user', parts: [{ type: 'text', text: id }, file(300)],
    }));
    const bounded = boundHistoryAttachments(messages);
    expect(MAX_HISTORY_ATTACHMENTS).toBe(4);
    expect(imageCount(bounded)).toBe(4);
    expect(bounded.map((message) => message.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    // The oldest keeps its text and loses only its file part.
    expect(bounded[0]!.parts).toEqual([{ type: 'text', text: 'm0' }]);
    for (const message of bounded.slice(1)) expect(message.parts).toHaveLength(2);
  });

  it('gives the current message priority: four new images leave none for history', () => {
    const messages = [
      { id: 'old', role: 'user', parts: [file(300)] },
      { id: 'older-text', role: 'assistant', parts: [{ type: 'text', text: 'looks like a cat' }, file(300)] },
      { id: 'now', role: 'user', parts: [{ type: 'text', text: 'and these?' }, file(300), file(300), file(300), file(300)] },
    ];
    const bounded = boundHistoryAttachments(messages);
    // The image-only message is removed; the text survives without its image.
    expect(bounded.map((message) => message.id)).toEqual(['older-text', 'now']);
    expect(bounded[0]!.parts).toEqual([{ type: 'text', text: 'looks like a cat' }]);
    expect(bounded[1]).toBe(messages[2]);
    expect(imageCount(bounded)).toBe(4);
  });

  it('still lets the byte budget bind when it is the tighter limit', () => {
    const messages = [
      { id: 'a', role: 'user', parts: [{ type: 'text', text: 'a' }, file(600)] },
      { id: 'b', role: 'user', parts: [{ type: 'text', text: 'b' }, file(600)] },
    ];
    const bounded = boundHistoryAttachments(messages, 900);
    expect(imageCount(bounded)).toBe(1);
    expect(bounded[0]!.parts).toEqual([{ type: 'text', text: 'a' }]);
    // And the count binds when a custom count is passed with room in bytes.
    expect(imageCount(boundHistoryAttachments(messages, MAX_HISTORY_ATTACHMENT_BYTES, 1))).toBe(1);
  });

  it('returns reference-equal messages for an attachment-free history', () => {
    const messages = [
      { id: 'a', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'b', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ];
    const bounded = boundHistoryAttachments(messages);
    expect(bounded).toHaveLength(2);
    bounded.forEach((message, index) => expect(message).toBe(messages[index]));
  });

  it('makes the count cap the binding limit: max images at max size fit the byte budget', () => {
    expect(MAX_HISTORY_ATTACHMENTS * MAX_ATTACHMENT_BYTES).toBeLessThanOrEqual(MAX_HISTORY_ATTACHMENT_BYTES);
  });
});
