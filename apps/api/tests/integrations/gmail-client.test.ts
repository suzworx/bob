import { describe, expect, it, vi } from 'vitest';
import { createGmailProviderClient } from '../../src/integrations/google-gmail-client.ts';

describe('Gmail provider client', () => {
  it('preserves provider internalDate separately from the sender Date header', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'thread', messages: [{
      id: 'message', threadId: 'thread', internalDate: '1780000000000', payload: {
        headers: [{ name: 'Date', value: 'wrong date' }], mimeType: 'text/plain', body: { data: 'SGk' },
      },
    }] }));
    const result = await createGmailProviderClient(fetcher).readThread('secret', 'thread', new AbortController().signal);
    expect(result.messages[0]).toMatchObject({ internalDate: 1780000000000, date: 'wrong date' });
  });
  it('searches one bounded page and preserves the continuation token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      threads: [{ id: 'abc123', snippet: 'A message' }], nextPageToken: 'next-page',
    }));
    const signal = new AbortController().signal;
    const result = await createGmailProviderClient(fetcher).search('secret', { query: 'is:unread' }, signal);
    expect(result).toEqual({ threads: [{ id: 'abc123', snippet: 'A message' }], nextPageToken: 'next-page' });
    const [url, options] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toContain('maxResults=10');
    expect(String(url)).toContain('q=is%3Aunread');
    expect(options).toMatchObject({ signal, redirect: 'error', headers: { Authorization: 'Bearer secret' } });
  });
  it('reads the requested thread with bounded plaintext, without fetching attachments', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'abc123', messages: [{
      id: 'msg1', threadId: 'abc123', payload: { mimeType: 'multipart/mixed', parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('Hello '.repeat(3000)).toString('base64url') } },
        { mimeType: 'text/plain', filename: 'secret.txt', body: { attachmentId: 'attachment' } },
        { mimeType: 'text/html', body: { data: Buffer.from('<script>evil</script>').toString('base64url') } },
      ] },
    }] }));
    const result = await createGmailProviderClient(fetcher).readThread('secret', 'abc123', new AbortController().signal);
    expect(result.messages[0]).toMatchObject({ id: 'msg1', text: 'Hello '.repeat(2000), truncated: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('creates only a reply draft from provider headers with a stable caller-supplied message ID', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'msg1', threadId: 'thread1', payload: { headers: [
        { name: 'From', value: 'Sender <sender@example.com>' },
        { name: 'Reply-To', value: 'reply@example.com' },
        { name: 'Subject', value: 'Hello' },
        { name: 'Message-ID', value: '<source@example.com>' },
      ] } }))
      .mockResolvedValueOnce(Response.json({ id: 'draft1', message: { id: 'draftmsg1', threadId: 'thread1' } }));
    const result = await createGmailProviderClient(fetcher).createReplyDraft('secret', {
      sourceMessageId: 'msg1', body: 'Thanks!', messageId: '<stable@heybob.xyz>',
    }, new AbortController().signal);
    expect(result).toEqual({ id: 'draft1', message: { id: 'draftmsg1', threadId: 'thread1' } });
    const [url, options] = fetcher.mock.calls[1] ?? [];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    const sent = JSON.parse(String(options?.body)) as { message: { raw: string; threadId: string } };
    const mime = Buffer.from(sent.message.raw, 'base64url').toString('utf8');
    expect(sent.message.threadId).toBe('thread1');
    expect(mime).toContain('To: reply@example.com\r\n');
    expect(mime).toContain('Message-ID: <stable@heybob.xyz>\r\n');
    expect(mime).toContain('In-Reply-To: <source@example.com>\r\n');
    expect(mime).toContain('References: <source@example.com>\r\n');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects a malformed base64url plaintext body instead of silently returning empty text', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'thread1', messages: [{
      id: 'msg1', threadId: 'thread1', payload: { mimeType: 'text/plain', body: { data: 'A' } },
    }] }));
    await expect(createGmailProviderClient(fetcher).readThread('secret', 'thread1', new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('rejects a provider page larger than the requested bound', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ threads: [{ id: 'a' }, { id: 'b' }] }));
    await expect(createGmailProviderClient(fetcher).search('secret', { query: 'test', maxResults: 1 }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('exposes bounded retry timing without retrying or leaking a provider error body', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private mail secret', { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(createGmailProviderClient(fetcher).search('secret', { query: 'test' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'rate_limited', retryAfterSeconds: 120, message: 'Gmail provider: rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('passes continuation tokens as encoded query parameters and rejects oversized input before fetching', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    const client = createGmailProviderClient(fetcher);
    const signal = new AbortController().signal;
    await client.search('secret', { query: 'test', pageToken: 'a&b=1', maxResults: 20 }, signal);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('pageToken=a%26b%3D1');
    await expect(client.search('secret', { query: 'test', maxResults: 21 }, signal)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([[401, 'unauthorized'], [403, 'permission_denied'], [404, 'not_found'], [503, 'unavailable']])(
    'sanitizes HTTP %s without retrying', async (status, code) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret', { status: Number(status) }));
      await expect(createGmailProviderClient(fetcher).search('secret', { query: 'test' }, new AbortController().signal))
        .rejects.toMatchObject({ code, message: `Gmail provider: ${code}` });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('stops a streamed response at the byte cap and cancels the reader', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2_000_001)); }, cancel,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    await expect(createGmailProviderClient(fetcher).search('secret', { query: 'test' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'response_too_large' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('extracts HTML-only text and never fetches remote content', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'thread1', messages: [{
      id: 'msg1', threadId: 'thread1', payload: { mimeType: 'text/html', body: {
        data: Buffer.from('<img src="https://example.com/private">Hello').toString('base64url'),
      } },
    }] }));
    const result = await createGmailProviderClient(fetcher).readThread('secret', 'thread1', new AbortController().signal);
    expect(result.messages[0]).toMatchObject({ textAvailable: true, text: 'Hello', truncated: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('returns only the last ten messages and explicitly reports omitted messages', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'thread1', messages: Array.from({ length: 12 }, (_, i) => ({
      id: `msg${i}`, threadId: 'thread1', payload: { mimeType: 'text/plain', body: { data: 'SGVsbG8' } },
    })) }));
    const result = await createGmailProviderClient(fetcher).readThread('secret', 'thread1', new AbortController().signal);
    expect(result.truncated).toBe(true);
    expect(result.messages).toHaveLength(10);
    expect(result.messages[0]?.id).toBe('msg2');
  });
  it.each([
    ['Reply-To', 'one@example.com,two@example.com'],
    ['Reply-To', 'safe@example.com\r\nBcc: victim@example.com'],
    ['Subject', 'Hello\nBcc: victim@example.com'],
    ['Message-ID', '<source@example.com>\r\nBcc: victim@example.com'],
  ])('rejects unsafe %s before creating a draft', async (name, value) => {
    const headers = [
      { name: 'From', value: 'sender@example.com' },
      { name: 'Message-ID', value: '<source@example.com>' },
      { name: 'Subject', value: 'Hello' },
    ].filter((item) => item.name !== name);
    headers.push({ name, value });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'msg1', threadId: 'thread1', payload: { headers } }));
    await expect(createGmailProviderClient(fetcher).createReplyDraft('secret', {
      sourceMessageId: 'msg1', body: 'Thanks', messageId: '<stable@heybob.xyz>',
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects duplicate source recipient headers instead of selecting arbitrarily', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'msg1', threadId: 'thread1', payload: { headers: [
      { name: 'From', value: 'one@example.com' }, { name: 'from', value: 'two@example.com' },
    ] } }));
    await expect(createGmailProviderClient(fetcher).createReplyDraft('secret', {
      sourceMessageId: 'msg1', body: 'Thanks', messageId: '<stable@heybob.xyz>',
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('sanitizes transport failures, including uncertain draft outcomes, without retrying', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'msg1', threadId: 'thread1', payload: { headers: [
        { name: 'From', value: 'sender@example.com' }, { name: 'Message-ID', value: '<source@example.com>' },
      ] } }))
      .mockRejectedValueOnce(new Error('provider leaked secret'));
    await expect(createGmailProviderClient(fetcher).createReplyDraft('secret', {
      sourceMessageId: 'msg1', body: 'Thanks', messageId: '<stable@heybob.xyz>',
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable', message: 'Gmail provider: unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('handles cancellation before I/O without leaking abort reasons', async () => {
    const controller = new AbortController();
    controller.abort(new Error('private abort reason'));
    const fetcher = vi.fn<typeof fetch>();
    await expect(createGmailProviderClient(fetcher).search('secret', { query: 'test' }, controller.signal))
      .rejects.toMatchObject({ code: 'cancelled', message: 'Gmail provider: cancelled' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('forwards cancellation during an active request and sanitizes fetch errors', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort();
      throw new Error('raw abort error');
    });
    await expect(createGmailProviderClient(fetcher).search('secret', { query: 'test' }, controller.signal))
      .rejects.toMatchObject({ code: 'cancelled' });
  });
  it('does not return success if cancelled while consuming the response', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      pull(stream) {
        controller.abort();
        stream.enqueue(new TextEncoder().encode('{}'));
        stream.close();
      },
    })));
    await expect(createGmailProviderClient(fetcher).search('secret', { query: 'test' }, controller.signal))
      .rejects.toMatchObject({ code: 'cancelled' });
  });
  it('does not expose attachment text when Content-Disposition marks an unnamed inline body as an attachment', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'thread1', messages: [{
      id: 'msg1', threadId: 'thread1', payload: { mimeType: 'text/plain',
        headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { data: 'U2VjcmV0' },
      },
    }] }));
    const result = await createGmailProviderClient(fetcher).readThread('secret', 'thread1', new AbortController().signal);
    expect(result.messages[0]).toMatchObject({ text: '', textAvailable: false });
  });
  it('reconciles only exact Message-ID metadata matches from one bounded draft page without recreating', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ drafts: [
        { id: 'draft1', message: { id: 'msg1', threadId: 'thread1' } },
        { id: 'draft2', message: { id: 'msg2', threadId: 'thread1' } },
      ], nextPageToken: 'more' }))
      .mockResolvedValueOnce(Response.json({ id: 'draft1', message: { id: 'msg1', threadId: 'thread1', payload: {
        headers: [{ name: 'Message-ID', value: '<stable@heybob.xyz>' }],
      } } }))
      .mockResolvedValueOnce(Response.json({ id: 'draft2', message: { id: 'msg2', threadId: 'thread1', payload: {
        headers: [{ name: 'Message-ID', value: '<other@heybob.xyz>' }],
      } } }));
    const result = await createGmailProviderClient(fetcher).findReplyDrafts('secret', {
      messageId: '<stable@heybob.xyz>', maxResults: 2,
    }, new AbortController().signal);
    expect(result).toEqual({ drafts: [{ id: 'draft1', message: { id: 'msg1', threadId: 'thread1' } }], nextPageToken: 'more' });
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.has('q')).toBe(false);
    expect(fetcher.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([
    ['<p>Hello &amp; <b>world<p>Next &#x1F600;', 'Hello & world\nNext 😀'],
    ['<script>alert("secret")</script><style>.x{}</style><p>Visible</p><span hidden>secret</span>', 'Visible'],
    ['<div aria-hidden="true"><b>secret</b></div><span style="display: none !important">secret</span>Visible', 'Visible'],
    ['<iframe src="https://example.com">secret</iframe><a href="https://example.com">Visible</a>', 'Visible'],
    ['<svg><text>secret</text></svg><template>secret</template><p>Visible</p>', 'Visible'],
  ])('extracts bounded display text from HTML %s', async (html, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'thread1', messages: [{
      id: 'msg1', threadId: 'thread1', payload: { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } },
    }] }));
    const result = await createGmailProviderClient(fetcher).readThread('secret', 'thread1', new AbortController().signal);
    expect(result.messages[0]?.text).toBe(expected);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('chooses plain text over HTML in multipart alternatives without duplicating content', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'thread1', messages: [{
      id: 'msg1', threadId: 'thread1', payload: { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/html', body: { data: Buffer.from('<p>HTML alternative</p>').toString('base64url') } },
        { mimeType: 'text/plain', body: { data: Buffer.from('Plain alternative').toString('base64url') } },
      ] },
    }] }));
    const result = await createGmailProviderClient(fetcher).readThread('secret', 'thread1', new AbortController().signal);
    expect(result.messages[0]?.text).toBe('Plain alternative');
  });
  it.each([
    ['ISO-8859-1', Buffer.from([67, 97, 102, 233]), 'Café', true],
    ['UTF-8', Buffer.from('こんにちは'), 'こんにちは', true],
    ['unknown-charset', Buffer.from('Hello'), '', false],
    ['UTF-8', Buffer.from([255]), '', false],
  ])('decodes declared %s safely', async (charset, bytes, expected, available) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'thread1', messages: [{
      id: 'msg1', threadId: 'thread1', payload: { mimeType: 'text/plain',
        headers: [{ name: 'Content-Type', value: `text/plain; charset="${charset}"` }],
        body: { data: (bytes as Buffer).toString('base64url') },
      },
    }] }));
    const result = await createGmailProviderClient(fetcher).readThread('secret', 'thread1', new AbortController().signal);
    expect(result.messages[0]).toMatchObject({ text: expected, textAvailable: available });
  });
  it.each(['x'.repeat(13000), '<div>'.repeat(101) + 'unreachable', '<span></span>'.repeat(10001) + 'unreachable'])(
    'reports HTML truncation on text, depth or element budget exhaustion', async (html) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'thread1', messages: [{
        id: 'msg1', threadId: 'thread1', payload: { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } },
      }] }));
      const result = await createGmailProviderClient(fetcher).readThread('secret', 'thread1', new AbortController().signal);
      expect(result.messages[0]?.truncated).toBe(true);
      expect(result.messages[0]?.text.length).toBeLessThanOrEqual(12000);
      expect(result.messages[0]?.text).not.toContain('unreachable');
    },
  );
});
