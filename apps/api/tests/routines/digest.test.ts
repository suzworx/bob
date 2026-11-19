import { describe, expect, it, vi } from 'vitest';
import { createRoutineDigest } from '../../src/routines/digest.ts';

const input = { owner: 'owner', googleAccountId: 'account', coverageStart: 100000, coverageEnd: 200000,
  signal: new AbortController().signal, checkActive: vi.fn(async () => {}) };
function setup() {
  const message = { id: 'message', threadId: 'thread', internalDate: 150000 as number | null, date: 'untrusted', subject: 'Hello',
    from: 'sender', text: 'Meeting tomorrow', textAvailable: true, truncated: false };
  const gmail = { search: vi.fn(async () => ({ threads: [{ id: 'thread', snippet: '' }], nextPageToken: undefined as string | undefined })),
    readThread: vi.fn(async () => ({ id: 'thread', messages: [message], truncated: false })) };
  const summarize = vi.fn<Parameters<typeof createRoutineDigest>[0]['summarize']>(async () => ({ summary: 'A meeting is planned.', messageIds: ['message'] }));
  return { gmail, summarize, execute: createRoutineDigest({ gmail, summarize }), message };
}
describe('routine Gmail digest', () => {
  it('applies the saved query inside durable coverage and passes summary preferences', async () => {
    const s = setup();
    await s.execute({ ...input, gmailQuery: 'subject:interview', instructions: 'Focus on deadlines', summaryStyle: 'detailed' });
    expect(s.gmail.search).toHaveBeenCalledWith('owner', 'account', { query: '(subject:interview) after:99 before:200', maxResults: 20 }, input.signal);
    expect(s.summarize.mock.calls[0]?.[0]).toMatchObject({ instructions: 'Focus on deadlines', summaryStyle: 'detailed' });
  });
  it('fences each read and summarizes only messages in the durable interval', async () => {
    const s = setup();
    s.gmail.readThread.mockResolvedValue({ id: 'thread', messages: [s.message, { ...s.message, id: 'old', internalDate: 99999 },
      { ...s.message, id: 'next', internalDate: 200000 }], truncated: false });
    const checkActive = vi.fn(async () => {});
    expect(await s.execute({ ...input, checkActive })).toEqual({ summary: 'A meeting is planned.',
      sources: [{ threadId: 'thread', messageId: 'message', label: 'Hello' }], partial: false, messageCount: 1 });
    expect(s.gmail.search).toHaveBeenCalledWith('owner', 'account', { query: 'after:99 before:200', maxResults: 20 }, input.signal);
    expect(s.summarize.mock.calls[0]?.[0]).toMatchObject({ messages: [{ messageId: 'message' }], partial: false });
    expect(checkActive.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
  it('returns honest empty coverage without calling the model', async () => {
    const s = setup(); s.gmail.search.mockResolvedValue({ threads: [], nextPageToken: undefined });
    expect(await s.execute(input)).toMatchObject({ messageCount: 0, partial: false, sources: [] });
    expect(s.summarize).not.toHaveBeenCalled();
  });
  it('does not translate provider failures into empty mail', async () => {
    const s = setup(); s.gmail.search.mockRejectedValue(new Error('unavailable'));
    await expect(s.execute(input)).rejects.toThrow('unavailable');
  });
  it('refuses missing provider time rather than using a sender-controlled date', async () => {
    const s = setup(); s.message.internalDate = null;
    await expect(s.execute(input)).rejects.toThrow('routine_message_date_unavailable');
    expect(s.summarize).not.toHaveBeenCalled();
  });
  it('refuses unreadable message content instead of presenting an empty summary', async () => {
    const s = setup(); s.message.textAvailable = false;
    await expect(s.execute(input)).rejects.toThrow('routine_message_text_unavailable');
    expect(s.summarize).not.toHaveBeenCalled();
  });
  it('stops between reads when authorization is withdrawn', async () => {
    const s = setup();
    const checkActive = vi.fn(async () => {}).mockResolvedValueOnce().mockRejectedValue(new Error('paused'));
    await expect(s.execute({ ...input, checkActive })).rejects.toThrow('paused');
    expect(s.gmail.search).toHaveBeenCalledTimes(1);
    expect(s.gmail.readThread).not.toHaveBeenCalled();
  });
  it('cancels before a read and does not call the model', async () => {
    const s = setup(); const controller = new AbortController(); controller.abort();
    await expect(s.execute({ ...input, signal: controller.signal })).rejects.toThrow();
    expect(s.gmail.search).not.toHaveBeenCalled();
    expect(s.summarize).not.toHaveBeenCalled();
  });
  it('refuses invented model references', async () => {
    const s = setup(); s.summarize.mockResolvedValue({ summary: 'Invented', messageIds: ['foreign'] });
    await expect(s.execute(input)).rejects.toThrow('routine_summary_invalid');
  });
  it('discloses truncation and bounds model text', async () => {
    const s = setup(); s.gmail.search.mockResolvedValue({ threads: [{ id: 'thread', snippet: '' }], nextPageToken: 'more' });
    s.gmail.readThread.mockResolvedValue({ id: 'thread', messages: Array.from({ length: 10 }, (_, i) => ({ ...s.message, id: `m${i}`, text: 'a'.repeat(12000) })), truncated: false });
    s.summarize.mockResolvedValue({ summary: 'Summary', messageIds: ['m0'] });
    expect(await s.execute(input)).toMatchObject({ partial: true });
    const supplied = s.summarize.mock.calls[0]?.[0];
    expect(JSON.stringify(supplied).length).toBeLessThanOrEqual(55000);
  });
  it('bounds serialized metadata and escaped text across the whole batch', async () => {
    const s = setup();
    s.gmail.search.mockResolvedValue({ threads: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, snippet: '' })), nextPageToken: undefined });
    let count = 0;
    s.gmail.readThread.mockImplementation(async () => ({ id: `thread${count++}`, truncated: false,
      messages: Array.from({ length: 10 }, (_, i) => ({ ...s.message, id: `${count}-${i}`,
        subject: '\u0000'.repeat(300), from: '\u0000'.repeat(300), text: '\u0000'.repeat(12000) })) }));
    s.summarize.mockImplementation(async ({ messages }) => ({ summary: 'Bounded summary', messageIds: [messages[0]?.messageId ?? 'missing'] }));
    expect(await s.execute(input)).toMatchObject({ partial: true });
    expect(JSON.stringify(s.summarize.mock.calls[0]?.[0]).length).toBeLessThanOrEqual(55000);
  });
  it('stops before provider access when the run is no longer active', async () => {
    const s = setup();
    await expect(s.execute({ ...input, checkActive: async () => { throw new Error('inactive'); } })).rejects.toThrow('inactive');
    expect(s.gmail.search).not.toHaveBeenCalled();
  });
});
