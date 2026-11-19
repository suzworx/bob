import { describe, expect, it, vi } from 'vitest';
import { createGoogleMailActionsClient } from '../src/integrations/google-mail-actions-client.ts';
const signal = (): AbortSignal => new AbortController().signal;
const content = { to: ['recipient@example.com'], cc: [], bcc: ['blind@example.com'], subject: 'Hello ✓', body: 'Body' };
const marker = '<operation@example.com>';
const message = { id: 'm1', threadId: 't1', labelIds: ['DRAFT'] };
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status }); }
async function fixture(): Promise<{ raw: string; fingerprint: string }> {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ id: 'd1', message }));
  await createGoogleMailActionsClient(fetcher).composeDraft('token', { content, messageId: marker }, signal());
  const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { message: { raw: string } };
  const raw = request.message.raw;
  const reader = createGoogleMailActionsClient(vi.fn<typeof fetch>().mockResolvedValue(json({ id: 'd1', message: { ...message, raw } })));
  return { raw, fingerprint: (await reader.readDraft('token', 'd1', signal())).fingerprint };
}
describe('Gmail mail action provider', () => {
  it('limits draft reconciliation to the exact marker and preserves pagination', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ drafts: [], nextPageToken: 'next' }));
    const result = await createGoogleMailActionsClient(fetcher).findDrafts('token', { messageId: marker, pageToken: 'previous' }, signal());
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('q')).toBe(`rfc822msgid:${marker}`);
    expect(url.searchParams.get('pageToken')).toBe('previous');
    expect(result).toEqual({ drafts: [], nextPageToken: 'next' });
  });
  it('round trips bounded text and explicit recipients', async () => {
    const { raw } = await fixture();
    const client = createGoogleMailActionsClient(vi.fn<typeof fetch>().mockResolvedValue(json({ id: 'd1', message: { ...message, raw } })));
    expect(await client.readDraft('token', 'd1', signal())).toMatchObject({ id: 'd1', content, rfcMessageId: marker });
  });
  it.each(['bad\r\nBcc: evil@example.com', 'two@example.com,evil@example.com'])('rejects header injection %s', async (to) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(createGoogleMailActionsClient(fetcher).composeDraft('token', { content: { ...content, to: [to] }, messageId: marker }, signal())).rejects.toMatchObject({ code: 'invalid_input', submissionStarted: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects stale fingerprint before mutation', async () => {
    const { raw } = await fixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ id: 'd1', message: { ...message, raw } }));
    await expect(createGoogleMailActionsClient(fetcher).updateDraft('token', { draftId: 'd1', expectedFingerprint: '0'.repeat(64), content, messageId: marker }, signal())).rejects.toMatchObject({ code: 'conflict', submissionStarted: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['updateDraft', 'sendDraft'] as const)('%s submits explicit content and marker', async (method) => {
    const { raw, fingerprint } = await fixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ id: 'd1', message: { ...message, raw } })).mockResolvedValueOnce(json(method === 'updateDraft' ? { id: 'd1', message } : message));
    await createGoogleMailActionsClient(fetcher)[method]('token', { draftId: 'd1', expectedFingerprint: fingerprint, content: { ...content, body: 'Updated' }, messageId: '<next@example.com>' }, signal());
    const call = fetcher.mock.calls[1];
    expect(call?.[0]).toContain(method === 'updateDraft' ? '/drafts/d1' : '/drafts/send');
    const body = JSON.parse(String(call?.[1]?.body)) as { id: string; message: { raw: string } };
    expect(body.id).toBe('d1');
    const mime = Buffer.from(body.message.raw, 'base64url').toString();
    expect(mime).toContain('Message-ID: <next@example.com>');
    expect(mime).toContain('bcc: blind@example.com');
    expect(mime).toContain(Buffer.from('Updated').toString('base64'));
  });
  it('does not retry or expose uncertain write errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret-token content'));
    await expect(createGoogleMailActionsClient(fetcher).composeDraft('token', { content, messageId: marker }, signal())).rejects.toMatchObject({ message: 'Gmail actions: unavailable', submissionStarted: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 404, 429])('HTTP %s rejected without write', async (status) => {
    const client = createGoogleMailActionsClient(vi.fn<typeof fetch>().mockResolvedValue(json({}, status)));
    await expect(client.trashMessage('token', 'm1', signal())).rejects.toMatchObject({ submissionStarted: false });
  });
  it('malformed successful write is unknown', async () => {
    const client = createGoogleMailActionsClient(vi.fn<typeof fetch>().mockResolvedValue(json({ wrong: true })));
    await expect(client.trashMessage('token', 'm1', signal())).rejects.toMatchObject({ code: 'invalid_response', submissionStarted: true });
  });
  it('requires exact marker and SENT label for reconciliation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ messages: [{ id: 'm1' }, { id: 'm2' }] }))
      .mockResolvedValueOnce(json({ ...message, labelIds: ['SENT'], payload: { headers: [{ name: 'Message-ID', value: marker }] } }))
      .mockResolvedValueOnce(json({ ...message, id: 'm2', labelIds: ['INBOX'], payload: { headers: [{ name: 'Message-ID', value: marker }] } }));
    expect((await createGoogleMailActionsClient(fetcher).findSent('token', { messageId: marker }, signal())).messages.map((m) => m.id)).toEqual(['m1']);
  });
  it('bounds response bytes', async () => {
    const client = createGoogleMailActionsClient(vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(200001))));
    await expect(client.readMessageState('token', 'm1', signal())).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('rejects attachment/multipart drafts without mutation', async () => {
    const raw = Buffer.from('Content-Type: multipart/mixed\r\n\r\nanything').toString('base64url');
    const client = createGoogleMailActionsClient(vi.fn<typeof fetch>().mockResolvedValue(json({ id: 'd1', message: { ...message, raw } })));
    await expect(client.readDraft('token', 'd1', signal())).rejects.toMatchObject({ code: 'unsupported_draft' });
  });
  it('pre-aborted calls never submit', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(createGoogleMailActionsClient(fetcher).trashMessage('token', 'm1', AbortSignal.abort())).rejects.toMatchObject({ code: 'cancelled', submissionStarted: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
