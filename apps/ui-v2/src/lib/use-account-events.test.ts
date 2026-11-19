import { act, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseSseFrames,
  useAccountEvents,
  type AccountEventHandlers,
} from './use-account-events';

vi.mock('./auth/use-session', () => ({
  fetchWithAuth: async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

const encoder = new TextEncoder();
const DEVICE_UUID = '00000000-0000-0000-0000-000000000000';

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function frame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

function Harness({ handlers }: { handlers: AccountEventHandlers }): ReactElement {
  useAccountEvents(handlers);
  return createElement('div');
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('parseSseFrames', () => {
  it('parses event and data, ignoring comment lines', () => {
    const { frames, rest } = parseSseFrames(
      ': ping\n\nevent: device.changed\ndata: {"device_id":"x"}\n\n',
    );
    expect(rest).toBe('');
    expect(frames).toEqual([{ event: 'device.changed', data: '{"device_id":"x"}' }]);
  });

  it('joins multi-line data with a newline and tolerates CRLF', () => {
    const { frames } = parseSseFrames(
      'event: message.appended\r\ndata: {"conversation_id":"a",\r\ndata:  "message_id":"b"}\r\n\r\n',
    );
    expect(frames).toEqual([
      { event: 'message.appended', data: '{"conversation_id":"a",\n"message_id":"b"}' },
    ]);
  });

  it('keeps an unterminated frame in rest for the next chunk', () => {
    const { frames, rest } = parseSseFrames('event: active.changed\ndata: {"con');
    expect(frames).toEqual([]);
    expect(rest).toBe('event: active.changed\ndata: {"con');
  });
});

describe('useAccountEvents', () => {
  it('dispatches each frame to its matching handler with the payload id', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        frame('message.appended', JSON.stringify({ conversation_id: 'cnv_1', message_id: 'msg_1', updated_at: 1 })),
        frame('conversation.updated', JSON.stringify({ conversation_id: 'cnv_2', updated_at: 2 })),
        frame('conversation.deleted', JSON.stringify({ conversation_id: 'cnv_3', updated_at: 3 })),
        frame('active.changed', JSON.stringify({ conversation_id: null, title: null, surface: 'web_text', changed_at: 4 })),
        frame('device.changed', JSON.stringify({ device_id: DEVICE_UUID })),
      ]),
    );
    const handlers = {
      onMessageAppended: vi.fn(),
      onConversationUpdated: vi.fn(),
      onConversationDeleted: vi.fn(),
      onActiveChanged: vi.fn(),
      onDeviceChanged: vi.fn(),
      onReconnect: vi.fn(),
    };
    render(createElement(Harness, { handlers }));
    await waitFor(() => expect(handlers.onMessageAppended).toHaveBeenCalledWith('cnv_1', 'msg_1'));
    expect(handlers.onConversationUpdated).toHaveBeenCalledWith('cnv_2');
    expect(handlers.onConversationDeleted).toHaveBeenCalledWith('cnv_3');
    expect(handlers.onActiveChanged).toHaveBeenCalledTimes(1);
    expect(handlers.onDeviceChanged).toHaveBeenCalledTimes(1);
    expect(handlers.onReconnect).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/events',
      expect.objectContaining({ headers: { Accept: 'text/event-stream' } }),
    );
  });

  it('dispatches active_space.changed, set or cleared, to onActiveSpaceChanged only', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        frame('active_space.changed', JSON.stringify({
          space_id: DEVICE_UUID, name: 'Garden', surface: 'device', changed_at: 8,
        })),
        frame('active_space.changed', JSON.stringify({ space_id: null, name: null, surface: 'web', changed_at: 9 })),
      ]),
    );
    const handlers = { onActiveSpaceChanged: vi.fn(), onActiveChanged: vi.fn(), onDeviceChanged: vi.fn() };
    render(createElement(Harness, { handlers }));
    await waitFor(() => expect(handlers.onActiveSpaceChanged).toHaveBeenCalledTimes(2));
    expect(handlers.onActiveChanged).not.toHaveBeenCalled();
    expect(handlers.onDeviceChanged).not.toHaveBeenCalled();
  });

  it('hands a message.appended handler the conversation id and the message id', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        frame('message.appended', JSON.stringify({ conversation_id: 'cnv_7', message_id: 'msg_9', updated_at: 7 })),
      ]),
    );
    const handlers = { onMessageAppended: vi.fn(), onReconnect: vi.fn() };
    render(createElement(Harness, { handlers }));
    await waitFor(() => expect(handlers.onMessageAppended).toHaveBeenCalledTimes(1));
    expect(handlers.onMessageAppended).toHaveBeenCalledWith('cnv_7', 'msg_9');
  });

  it('hands thread.message_appended its thread and space ids, and ignores unknown events', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        frame('thread.future_event', JSON.stringify({ thread_id: 'thr_x', space_id: 'spc_x' })),
        frame('thread.message_appended', JSON.stringify({ thread_id: 't1' })),
        frame('thread.message_appended', JSON.stringify({
          thread_id: 't1', space_id: 's1', message_id: 'm1', sequence: 4,
        })),
        frame('active.changed', '{"changed_at":1}'),
      ]),
    );
    const handlers = {
      onThreadMessageAppended: vi.fn(),
      onMessageAppended: vi.fn(),
      onActiveChanged: vi.fn(),
      onReconnect: vi.fn(),
    };
    render(createElement(Harness, { handlers }));
    await waitFor(() => expect(handlers.onActiveChanged).toHaveBeenCalledTimes(1));
    expect(handlers.onThreadMessageAppended).toHaveBeenCalledTimes(1);
    expect(handlers.onThreadMessageAppended).toHaveBeenCalledWith('t1', 's1');
    expect(handlers.onMessageAppended).not.toHaveBeenCalled();
  });

  it('drops malformed frames without dispatching anything from them', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([frame('message.appended', 'not json'), frame('active.changed', '{"changed_at":1}')]),
    );
    const handlers = { onMessageAppended: vi.fn(), onActiveChanged: vi.fn(), onReconnect: vi.fn() };
    render(createElement(Harness, { handlers }));
    await waitFor(() => expect(handlers.onActiveChanged).toHaveBeenCalledTimes(1));
    expect(handlers.onMessageAppended).not.toHaveBeenCalled();
  });

  it('reconnects with backoff after a close and refetches on every open', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([frame('active.changed', JSON.stringify({ conversation_id: null, title: null, surface: 'web_text', changed_at: 5 }))]),
      )
      .mockResolvedValueOnce(sseResponse([frame('device.changed', JSON.stringify({ device_id: DEVICE_UUID }))]));
    const handlers = { onActiveChanged: vi.fn(), onDeviceChanged: vi.fn(), onReconnect: vi.fn() };
    render(createElement(Harness, { handlers }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(handlers.onReconnect).toHaveBeenCalledTimes(1);
    expect(handlers.onActiveChanged).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handlers.onReconnect).toHaveBeenCalledTimes(2);
    expect(handlers.onDeviceChanged).toHaveBeenCalledTimes(1);
  });

  it('backs off and retries after a network error', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(sseResponse([frame('device.changed', JSON.stringify({ device_id: DEVICE_UUID }))]));
    const handlers = { onDeviceChanged: vi.fn(), onReconnect: vi.fn() };
    render(createElement(Harness, { handlers }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handlers.onReconnect).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handlers.onReconnect).toHaveBeenCalledTimes(1);
    expect(handlers.onDeviceChanged).toHaveBeenCalledTimes(1);
  });

  it('stops reconnecting after unmount', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(sseResponse([]));
    const handlers = { onReconnect: vi.fn() };
    const view = render(createElement(Harness, { handlers }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(handlers.onReconnect).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
it('dispatches an audience invalidation without treating it as a pointer movement', async () => {
  const onSpaceAccessChanged = vi.fn();
  const onActiveSpaceChanged = vi.fn();
  fetchMock.mockResolvedValueOnce(sseResponse([frame('space.access_changed', JSON.stringify({ space_id: DEVICE_UUID }))]));
  render(createElement(Harness, { handlers: { onSpaceAccessChanged, onActiveSpaceChanged } }));
  await waitFor(() => expect(onSpaceAccessChanged).toHaveBeenCalledWith(DEVICE_UUID));
  expect(onActiveSpaceChanged).not.toHaveBeenCalled();
});
