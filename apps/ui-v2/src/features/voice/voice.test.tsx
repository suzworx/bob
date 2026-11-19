import { useState, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { BRAND } from '@/lib/brand';
import { SpacesProvider } from '@/features/spaces/use-spaces';
import { DEFAULT_CONFIG } from '@/features/voice/mode/config';
import type { PlaybackState } from '@/features/voice/mode/playback-queue';
import type { VadInput } from '@/features/voice/mode/use-conversation-mode';
import type { VadHandle } from '@/features/voice/mode/vad';
import { OUT_OF_CREDIT_NOTICE } from '@/features/chat/chat-notices';
import { ChatSurface } from '../chat/chat-surface';
import { VoiceModeBar } from './voice-mode-bar';
import type { ChatSlotProps } from '../../app/shell';

// Hands-free voice in the v2 chat. The v1 voice modules are faked at their
// '@/lib/...' paths so the wiring is driven without a real mic, VAD or synthesis
// pipeline; the chat itself (useChat and its /api/chat transport) is real.
const hoisted = vi.hoisted(() => ({
  vad: null as { onSpeechStart: () => void; onSpeechEnd: (audio: Float32Array) => void } | null,
  vadModuleLoads: 0,
  vadDestroy: vi.fn(async () => {}),
  queue: {
    enqueue: vi.fn<(text: string) => void>(),
    stop: vi.fn(() => ({ heardChars: 0 })),
    speaking: false,
  },
  queueOnState: undefined as ((state: PlaybackState) => void) | undefined,
  queueOnError: undefined as ((error: unknown) => void) | undefined,
  transcribe: vi.fn(async (_blob: Blob, _workflow?: { workflowId: string; onTrace?: (traceId: string) => void }): Promise<string | null> => ' heard words '),
  speak: vi.fn(async (_text: string): Promise<void> => {}),
  truncated: false,
  acquireLock: vi.fn(async () => true),
  lockRelease: vi.fn(),
  getUserMedia: vi.fn(),
  recordMetric: vi.fn(),
}));

// The real hook's shape, with its network calls stubbed: `speak` lands an audio
// URL and `setError` stores a code, both through real state so the UI reacts.
vi.mock('@/features/voice/mode/metrics', async (original) => ({
  ...(await original<typeof import('@/features/voice/mode/metrics')>()),
  createMetrics: () => ({ record: hoisted.recordMetric, flush: async () => {}, dispose: () => {} }),
}));

vi.mock('@/features/voice/use-voice', async () => {
  const { useState } = await import('react');
  return {
    OUT_OF_CREDIT: 'out_of_credit',
    useVoice: () => {
      const [error, setError] = useState<string | null>(null);
      const [audioUrl, setAudioUrl] = useState<string | null>(null);
      return {
        error,
        setError,
        clearError: () => setError(null),
        transcribe: hoisted.transcribe,
        speak: async (text: string): Promise<void> => {
          await hoisted.speak(text);
          setAudioUrl('blob:spoken');
        },
        audioUrl,
        truncated: hoisted.truncated,
        synthesize: async () => 'blob:sentence',
        play: async () => {},
        stopPlayback: () => {},
        revoke: () => {},
      };
    },
  };
});

vi.mock('@/features/voice/mode/lock', () => ({
  acquireMicLock: async () => ({ held: await hoisted.acquireLock(), release: hoisted.lockRelease }),
}));

// A mock factory runs when the module is first imported, so the counter records
// when the chat loads the VAD (it is cached for the rest of the file).
vi.mock('@/features/voice/mode/vad', () => {
  hoisted.vadModuleLoads += 1;
  return {
    createVad: async (input: VadInput): Promise<VadHandle> => {
      hoisted.vad = { onSpeechStart: input.onSpeechStart, onSpeechEnd: input.onSpeechEnd };
      return { start: async () => {}, pause: async () => {}, destroy: hoisted.vadDestroy };
    },
  };
});

vi.mock('@/features/voice/mode/playback-queue', () => ({
  createPlaybackQueue: (deps: { onState?: (state: PlaybackState) => void; onError?: (error: unknown) => void }) => {
    hoisted.queueOnState = deps.onState;
    hoisted.queueOnError = deps.onError;
    return hoisted.queue;
  },
}));

vi.mock('@/features/voice/mode/sentence-split', () => ({
  createSentenceSplitter: () => ({
    push: (chunk: string) => (chunk ? [chunk] : []),
    flush: () => ['flushed-tail'],
  }),
}));

// jsdom has no MediaRecorder. This one records nothing: stopping it emits one
// chunk and then the stop event, as a browser does when a clip ends.
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  state: 'inactive' | 'recording' = 'inactive';
  start = vi.fn((): void => {
    this.state = 'recording';
  });
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly stream: MediaStream) {
    FakeRecorder.instances.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  stop(): void {
    this.state = 'inactive';
    this.emit('dataavailable', { data: new Blob(['clip']) });
    this.emit('stop', {});
  }
  // A recorder that dies mid-clip: an error event and no stop event.
  fail(): void {
    this.state = 'inactive';
    this.emit('error', {});
  }
  ondataavailable: ((event: unknown) => void) | null = null;
  onstop: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private emit(type: 'dataavailable' | 'stop' | 'error', event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    this[`on${type}`]?.(event);
  }
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const frame = (chunk: unknown): Uint8Array =>
  new TextEncoder().encode(`data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`);

const replyChunks = (text: string): unknown[] => [
  { type: 'start', messageId: 'a1' },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: text },
  { type: 'text-end', id: 't1' },
  { type: 'finish', messageMetadata: { conversationId: 'cnv_test' } },
];

// /api/chat streams the reply at once, or with `hold` leaves it open until finish().
function stubApi(reply: { text: string; hold?: boolean } = { text: 'First sentence.' }) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const chunks = replyChunks(reply.text);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === '/api/spaces') return json({ spaces: [] });
    if (url === '/api/conversations/cnv_test') return json({ messages: [{ role: 'assistant' }] });
    if (url.startsWith('/api/conversations/cnv_test/messages/')) return new Response(null, { status: 204 });
    if (url !== '/api/chat') throw new Error(`unrouted fetch: ${url}`);
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        controller = stream;
        for (const chunk of reply.hold ? chunks.slice(0, 3) : [...chunks, '[DONE]']) {
          stream.enqueue(frame(chunk));
        }
        if (!reply.hold) stream.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    finish: (): void => {
      for (const chunk of [...chunks.slice(3), '[DONE]']) controller?.enqueue(frame(chunk));
      controller?.close();
    },
    chatBodies: () =>
      fetchMock.mock.calls
        .filter(([input]) => String(input) === '/api/chat')
        .map(
          ([, init]) =>
            JSON.parse(String(init?.body)) as { message: { parts: unknown[] }; origin?: string },
        ),
  };
}

function renderSurface(overrides: Partial<ChatSlotProps> = {}): ChatSlotProps {
  const props: ChatSlotProps = {
    conversationId: null,
    initialMessages: [],
    userName: 'Ann',
    onConversationTouched: vi.fn(),
    onConversationCreated: vi.fn(),
    ...overrides,
  };
  render(
    <Theme theme={neutralTheme} mode="system">
      <SpacesProvider>
        <ChatSurface {...props} />
      </SpacesProvider>
    </Theme>,
  );
  return props;
}

// The mode's clock is Date.now, so an utterance's length is set by moving `now`.
let now = 1_000_000;
// One entry per getUserMedia call: the pointer-down probe first, then the mode's own mic.
const tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
type User = ReturnType<typeof userEvent.setup>;

async function startHandsFree(user: User): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Voice mode' }));
  await waitFor(() => expect(hoisted.vad).not.toBeNull());
}

function utter(ms = DEFAULT_CONFIG.MIN_SPEECH_MS + 1): void {
  act(() => hoisted.vad?.onSpeechStart());
  now += ms;
  act(() => hoisted.vad?.onSpeechEnd(new Float32Array(320)));
}

beforeEach(() => {
  now = 1_000_000;
  tracks.length = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  hoisted.vad = null;
  hoisted.queueOnState = undefined;
  hoisted.truncated = false;
  hoisted.transcribe.mockImplementation(async () => ' heard words ');
  hoisted.speak.mockImplementation(async () => {});
  hoisted.acquireLock.mockImplementation(async () => true);
  hoisted.queue.stop.mockImplementation(() => ({ heardChars: 0 }));
  hoisted.vadDestroy.mockImplementation(async () => {});
  hoisted.getUserMedia.mockImplementation(async () => {
    const track = { stop: vi.fn() };
    tracks.push(track);
    return { getTracks: () => [track] } as unknown as MediaStream;
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: hoisted.getUserMedia },
    configurable: true,
  });
  FakeRecorder.instances.length = 0;
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('hands-free voice', () => {
  // Keep this first in the file: the mocked module is cached once it is loaded.
  it('does not load the VAD module until hands-free starts', async () => {
    stubApi();
    renderSurface();
    const mic = await screen.findByRole('button', { name: 'Voice mode' });
    expect(hoisted.vadModuleLoads).toBe(0);
    await userEvent.setup().click(mic);
    await waitFor(() => expect(hoisted.vad).not.toBeNull());
    expect(hoisted.vadModuleLoads).toBe(1);
  });

  it('starts from Voice mode: Listening, with the microphone live', async () => {
    stubApi();
    renderSurface();
    await startHandsFree(userEvent.setup());
    expect(await screen.findByText('Listening')).toBeTruthy();
    expect(screen.getByLabelText('Microphone live')).toBeTruthy();
    expect(hoisted.acquireLock).toHaveBeenCalledTimes(1);
  });

  it('sends an utterance as a trimmed turn through transcribe and /api/chat', async () => {
    const api = stubApi();
    renderSurface();
    await startHandsFree(userEvent.setup());
    utter();
    await waitFor(() => expect(hoisted.transcribe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.chatBodies()).toHaveLength(1));
    expect(api.chatBodies()[0].message.parts).toEqual([{ type: 'text', text: 'heard words' }]);
    // The server stores the turn as spoken, not just this client's view of it.
    expect(api.chatBodies()[0].origin).toBe('web_voice');
    expect(api.chatBodies()[0]).toHaveProperty('workflowId', expect.stringMatching(/^[a-f0-9-]{36}$/));
  });

  it('records actual first audio with the server-issued trace id, once per utterance', async () => {
    hoisted.transcribe.mockImplementation(async (_blob, workflow) => { workflow?.onTrace?.('b'.repeat(32)); return 'heard words'; });
    stubApi();
    renderSurface();
    await startHandsFree(userEvent.setup());
    utter();
    await waitFor(() => expect(hoisted.queue.enqueue).toHaveBeenCalledWith('First sentence.'));
    now += 750;
    act(() => { hoisted.queueOnState?.('speaking'); });
    act(() => { hoisted.queueOnState?.('speaking'); });
    const timings = hoisted.recordMetric.mock.calls.map(([event]) => event).filter((event) => event.event === 'turn_timing');
    expect(timings).toEqual([{ event: 'turn_timing', eos_to_first_audio_ms: 750, trace_id: 'b'.repeat(32) }]);
  });

  it('hands the streamed reply to the playback queue, then flushes the tail', async () => {
    stubApi();
    renderSurface();
    await startHandsFree(userEvent.setup());
    utter();
    await waitFor(() => expect(hoisted.queue.enqueue).toHaveBeenCalledWith('First sentence.'));
    await waitFor(() => expect(hoisted.queue.enqueue).toHaveBeenCalledWith('flushed-tail'));
  });

  it('does not read the previous answer aloud when hands-free starts', async () => {
    stubApi();
    renderSurface({
      initialMessages: [
        { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'earlier' }] },
        { id: 'a0', role: 'assistant', parts: [{ type: 'text', text: 'An older answer.' }] },
      ],
    });
    await startHandsFree(userEvent.setup());
    await screen.findByText('Listening');
    expect(hoisted.queue.enqueue).not.toHaveBeenCalled();
  });

  it('PATCHes the heard portion when the reader barges in', async () => {
    const api = stubApi();
    renderSurface({ conversationId: 'cnv_test' });
    await startHandsFree(userEvent.setup());
    utter();
    await waitFor(() => expect(hoisted.queue.enqueue).toHaveBeenCalledWith('First sentence.'));

    // First audio makes it "speaking", then the reader cuts in.
    act(() => hoisted.queueOnState?.('speaking'));
    act(() => hoisted.vad?.onSpeechStart());
    now += DEFAULT_CONFIG.MIN_INTERRUPTION_MS + 1;
    hoisted.queue.stop.mockReturnValueOnce({ heardChars: 17 });
    act(() => hoisted.vad?.onSpeechEnd(new Float32Array(320)));

    const patch = () =>
      api.fetchMock.mock.calls.find(([input, init]) => String(input).includes('/messages/') && init?.method === 'PATCH');
    await waitFor(() => expect(patch()).toBeDefined());
    expect(String(patch()?.[0])).toBe('/api/conversations/cnv_test/messages/a1');
    expect(JSON.parse(String(patch()?.[1]?.body))).toEqual({ heard_chars: 17, interrupted: true });
  });

  it('lets go of the mic, the VAD and the lock on unmount', async () => {
    stubApi();
    renderSurface();
    await startHandsFree(userEvent.setup());
    await waitFor(() => expect(tracks).toHaveLength(2));
    cleanup();
    expect(tracks[1].stop).toHaveBeenCalled();
    expect(hoisted.vadDestroy).toHaveBeenCalled();
    expect(hoisted.lockRelease).toHaveBeenCalled();
  });

  it('releases the lock on Stop, so hands-free can start again', async () => {
    stubApi();
    renderSurface();
    const user = userEvent.setup();
    await startHandsFree(user);
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(hoisted.lockRelease).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Listening')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Voice mode' }));
    expect(await screen.findByText('Listening')).toBeTruthy();
    expect(hoisted.acquireLock).toHaveBeenCalledTimes(2);
  });
});

describe('voice notices', () => {
  it.each([
    ['NotAllowedError', `${BRAND.assistantName} can't hear you. Allow the microphone for this site in your browser settings.`],
    ['NotFoundError', `${BRAND.assistantName} can't find a microphone. Connect one, then try again.`],
    ['AbortError', "This browser can't do voice. Type instead, or try a current browser."],
  ])('names a %s from getUserMedia at the Voice mode tap', async (name, copy) => {
    stubApi();
    hoisted.getUserMedia.mockImplementation(async () => {
      throw new DOMException('refused', name);
    });
    renderSurface();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Voice mode' }));
    expect(await screen.findByText(copy)).toBeTruthy();
  });

  it('names a browser with no microphone API as unsupported', async () => {
    stubApi();
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    renderSurface();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Voice mode' }));
    expect(await screen.findByText("This browser can't do voice. Type instead, or try a current browser.")).toBeTruthy();
  });

  it('names a browser with no MediaRecorder as unsupported', async () => {
    stubApi();
    vi.stubGlobal('MediaRecorder', undefined);
    renderSurface();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Voice mode' }));
    expect(await screen.findByText("This browser can't do voice. Type instead, or try a current browser.")).toBeTruthy();
  });

  // #1041: the same kind notice web chat shows for out_of_credit, with a way to the usage page.
  it('says Bob needs a rest, with See usage, when a hands-free sentence meets a spent budget', async () => {
    stubApi();
    renderSurface();
    await startHandsFree(userEvent.setup());
    act(() => hoisted.queueOnError?.(new Error('out_of_credit')));
    expect(await screen.findByText(OUT_OF_CREDIT_NOTICE)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'See usage' })).toBeTruthy();
  });

  it('says when the spoken reply was shortened for speech synthesis', async () => {
    stubApi();
    hoisted.truncated = true;
    renderSurface();
    expect(await screen.findByText(`${BRAND.assistantName} read out a shorter version of that reply.`)).toBeTruthy();
  });
});

// jsdom does not implement media playback, so play and pause are spies.
function stubPlayback() {
  return {
    play: vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined),
    pause: vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}),
  };
}

// A voice turn whose reply is still streaming when hands-free is stopped, so
// the finished reply is spoken as a push-to-talk one.
async function voiceTurnInFlight(user: User) {
  const api = stubApi({ text: 'First sentence.', hold: true });
  renderSurface();
  await startHandsFree(user);
  utter();
  await waitFor(() => expect(api.chatBodies()).toHaveLength(1));
  // The bar's Stop sits above the composer's, which appears once the turn is busy.
  await user.click(screen.getAllByRole('button', { name: /Stop/ })[0]);
  return api;
}

describe('spoken replies', () => {
  it('speaks a completed voice turn, autoplays it, and shows the player', async () => {
    const { play, pause } = stubPlayback();
    const user = userEvent.setup();
    const api = await voiceTurnInFlight(user);
    await act(async () => api.finish());
    await waitFor(() => expect(hoisted.speak).toHaveBeenCalledWith('First sentence.'));
    await waitFor(() => expect(document.querySelector('audio[src="blob:spoken"]')).not.toBeNull());
    expect(screen.getByLabelText('Spoken reply')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play or pause the spoken reply' })).toBeTruthy();
    expect(screen.getByText('0:00 / 0:00')).toBeTruthy();
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    // Pointer-down on Dictate silences it.
    await user.click(screen.getByRole('button', { name: 'Dictate' }));
    expect(pause).toHaveBeenCalled();
  });

  it('keeps the player when the browser blocks autoplay', async () => {
    const { play } = stubPlayback();
    play.mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    const api = await voiceTurnInFlight(userEvent.setup());
    await act(async () => api.finish());
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(document.querySelector('audio[src]')).not.toBeNull();
    expect(screen.queryByText('Audio playback was unavailable.')).toBeNull();
  });

  it('does not speak a voice turn that was stopped', async () => {
    stubPlayback();
    const user = userEvent.setup();
    await voiceTurnInFlight(user);
    await user.click(screen.getAllByRole('button', { name: /Stop/ }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hoisted.speak).not.toHaveBeenCalled();
    expect(document.querySelector('audio')).toBeNull();
  });

  it('never speaks a typed turn, and sends it with no origin', async () => {
    const api = stubApi();
    stubPlayback();
    const props = renderSurface();
    const user = userEvent.setup();
    await user.click(await screen.findByText('Plan my week'));
    // A landing card only fills the composer; the reader then presses Send.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false),
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(props.onConversationTouched).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.body.textContent).toContain('First sentence.');
    expect(api.chatBodies()).toHaveLength(1);
    expect(api.chatBodies()[0]).not.toHaveProperty('origin');
    expect(hoisted.speak).not.toHaveBeenCalled();
    expect(document.querySelector('audio')).toBeNull();
  });
});

describe('Voice mode and Dictate together', () => {
  it('ends Voice mode on a second tap, and lets go of the lock', async () => {
    stubApi();
    renderSurface();
    const user = userEvent.setup();
    await startHandsFree(user);
    await screen.findByText('Listening');
    await user.click(screen.getByRole('button', { name: 'End voice mode' }));
    await waitFor(() => expect(screen.queryByText('Listening')).toBeNull());
    expect(hoisted.lockRelease).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Voice mode' })).toBeTruthy();
  });

  it('stops Bob mid-reply when Voice mode is ended while he speaks (barge-in)', async () => {
    stubApi({ text: 'First sentence.', hold: true });
    renderSurface();
    const user = userEvent.setup();
    await startHandsFree(user);
    utter();
    await waitFor(() => expect(hoisted.queue.enqueue).toHaveBeenCalledWith('First sentence.'));
    act(() => hoisted.queueOnState?.('speaking'));
    expect(await screen.findByText('Speaking')).toBeTruthy();
    // The button stays usable while the reply streams.
    const end = screen.getByRole('button', { name: 'End voice mode' });
    expect(end.hasAttribute('disabled')).toBe(false);
    await user.click(end);
    expect(hoisted.queue.stop).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('Speaking')).toBeNull());
  });

  it('Dictate while hands-free puts the words in the box, sends nothing, and steps the mode aside', async () => {
    const api = stubApi();
    renderSurface();
    const user = userEvent.setup();
    await startHandsFree(user);
    await screen.findByText('Listening');

    await user.click(screen.getByRole('button', { name: 'Dictate' }));
    await waitFor(() => expect(FakeRecorder.instances).toHaveLength(1));
    // Hands-free steps aside so the same speech is not heard twice.
    expect(await screen.findByText('Muted')).toBeTruthy();
    utter();
    expect(hoisted.transcribe).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Stop dictating' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Message input' }).textContent).toContain('heard words'),
    );
    expect(await screen.findByText('Listening')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hoisted.transcribe).toHaveBeenCalledTimes(1);
    expect(api.chatBodies()).toHaveLength(0);
  });

  it('leaves a mode the reader muted muted after a dictation', async () => {
    stubApi();
    renderSurface();
    const user = userEvent.setup();
    await startHandsFree(user);
    await user.click(screen.getByRole('button', { name: 'Mute' }));
    expect(await screen.findByText('Muted')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Dictate' }));
    await waitFor(() => expect(FakeRecorder.instances).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Stop dictating' }));
    await waitFor(() => expect(hoisted.transcribe).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Muted')).toBeTruthy();
    expect(screen.queryByText('Listening')).toBeNull();
  });

  it('drops a dictation still being recorded when the chat unmounts', async () => {
    stubApi();
    renderSurface();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Dictate' }));
    await waitFor(() => expect(FakeRecorder.instances).toHaveLength(1));
    cleanup();
    expect(FakeRecorder.instances[0].state).toBe('inactive');
    expect(hoisted.transcribe).not.toHaveBeenCalled();
  });
});

describe('voice mode bar', () => {
  it('says why it is paused when another tab holds voice', () => {
    render(
      <Theme theme={neutralTheme} mode="system">
        <VoiceModeBar state="paused" micLive={false} reason="Voice is on in another tab" onResume={() => {}} />
      </Theme>,
    );
    const bar = screen.getByRole('toolbar', { name: 'Voice mode' });
    // Buttons carry their own empty live regions; the bar's label is the one with text.
    expect(within(bar).getByText('Paused: Voice is on in another tab').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
  });

  it('announces the state from one live region, with Title case labels', () => {
    render(
      <Theme theme={neutralTheme} mode="system">
        <VoiceModeBar state="hearing" micLive onStop={() => {}} onMute={() => {}} />
      </Theme>,
    );
    const bar = screen.getByRole('toolbar', { name: 'Voice mode' });
    expect(within(bar).getByText('Hearing you').getAttribute('role')).toBe('status');
    expect(screen.getByLabelText('Microphone live')).toBeTruthy();
    expect(document.querySelector('div[aria-live]')).toBeNull();
  });
});

// What the shell does when a new chat's first reply creates the conversation:
// it seeds the exchange and passes the id back to the SAME surface (no new key).
function AdoptingSurface(): ReactElement {
  const [adopted, setAdopted] = useState<{ id: string | null; messages: UIMessage[] }>({
    id: null,
    messages: [],
  });
  return (
    <>
      <output aria-label="Adopted id">{adopted.id ?? ''}</output>
      <ChatSurface
        conversationId={adopted.id}
        initialMessages={adopted.messages}
        userName="Ann"
        onConversationTouched={() => {}}
        onConversationCreated={(id, messages) => setAdopted({ id, messages })}
      />
    </>
  );
}

describe('hands-free across a new conversation', () => {
  it('stays on, finishes speaking the reply and reports barge-in to the new conversation', async () => {
    const api = stubApi();
    render(
      <Theme theme={neutralTheme} mode="system">
        <SpacesProvider>
          <AdoptingSurface />
        </SpacesProvider>
      </Theme>,
    );
    await startHandsFree(userEvent.setup());
    utter();
    await waitFor(() => expect(screen.getByLabelText('Adopted id').textContent).toBe('cnv_test'));

    // Adopting the id did not end the mode: its bar is still up (the mic itself
    // is released while a reply is awaited or spoken), its lock is still held,
    // and the tail of the reply still reached the playback queue.
    expect(screen.getByRole('button', { name: 'Mute' })).toBeTruthy();
    expect(hoisted.lockRelease).not.toHaveBeenCalled();
    await waitFor(() => expect(hoisted.queue.enqueue).toHaveBeenCalledWith('First sentence.'));
    await waitFor(() => expect(hoisted.queue.enqueue).toHaveBeenCalledWith('flushed-tail'));

    // A barge-in now belongs to the conversation the reply created.
    act(() => hoisted.queueOnState?.('speaking'));
    act(() => hoisted.vad?.onSpeechStart());
    now += DEFAULT_CONFIG.MIN_INTERRUPTION_MS + 1;
    hoisted.queue.stop.mockReturnValueOnce({ heardChars: 9 });
    act(() => hoisted.vad?.onSpeechEnd(new Float32Array(320)));
    const patch = () =>
      api.fetchMock.mock.calls.find(([input, init]) => String(input).includes('/messages/') && init?.method === 'PATCH');
    await waitFor(() => expect(patch()).toBeDefined());
    expect(String(patch()?.[0])).toBe('/api/conversations/cnv_test/messages/a1');
    expect(JSON.parse(String(patch()?.[1]?.body))).toEqual({ heard_chars: 9, interrupted: true });
  });
});
