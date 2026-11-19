import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ReactElement } from 'react';
import type { ConversationModeHandle, ConversationModeDeps, VadInput } from './use-conversation-mode';
import { useConversationMode } from './use-conversation-mode';
import type { TelemetryEvent } from './metrics';
import { DEFAULT_CONFIG } from './config';
import type { PlaybackQueue, PlaybackState } from './playback-queue';
import type { SentenceSplitter } from './sentence-split';
import type { VadHandle } from './vad';

function makeStream() {
  const track = {
    stop: vi.fn(),
  };
  return {
    getTracks: () => [track],
    _track: track,
  } as unknown as MediaStream;
}

interface Harness {
  result: ConversationModeHandle;
  metrics: { record: ReturnType<typeof vi.fn<(event: TelemetryEvent) => void>>; flush: ReturnType<typeof vi.fn<() => Promise<void>>> };
  getUserMedia: ReturnType<typeof vi.fn<typeof navigator.mediaDevices.getUserMedia>>;
  acquireLock: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  createVadFn: ReturnType<typeof vi.fn<(input: VadInput) => Promise<VadHandle>>>;
  createQueue: ReturnType<typeof vi.fn<(onState?: (state: PlaybackState) => void) => PlaybackQueue>>;
  createSplitter: ReturnType<typeof vi.fn<() => SentenceSplitter>>;
  patchHeardPortion: ReturnType<typeof vi.fn<(heardChars: number) => void>>;
  onUtterance: ReturnType<typeof vi.fn<(blob: Blob) => void>>;
  vadCallbacks: {
    onSpeechStart: () => void;
    onSpeechEnd: (audio: Float32Array) => void;
    onMisfire: () => void;
  };
  queueOnState: { value: ((state: PlaybackState) => void) | undefined };
  queue: PlaybackQueue & { stop: ReturnType<typeof vi.fn<() => { heardChars: number }>> };
  config?: Partial<ConversationModeDeps['config']>;
  dateNow: { value: number };
}

function setupHarness(overrides: Partial<ConversationModeDeps> = {}): Harness {
  const vadCallbacks = {} as Harness['vadCallbacks'];
  const queue = {
    enqueue: vi.fn<(text: string) => void>(),
    stop: vi.fn<() => { heardChars: number }>(() => ({ heardChars: 0 })),
    speaking: false,
  } as unknown as Harness['queue'];
  let queueOnState = { value: undefined as ((state: PlaybackState) => void) | undefined };
  const getUserMedia = vi.fn<typeof navigator.mediaDevices.getUserMedia>(async () =>
    makeStream(),
  );
  const acquireLock = vi.fn<() => Promise<boolean>>(async () => true);
  const createVadFn = vi.fn<(input: VadInput) => Promise<VadHandle>>(async (input) => {
    vadCallbacks.onSpeechStart = input.onSpeechStart;
    vadCallbacks.onSpeechEnd = input.onSpeechEnd;
    vadCallbacks.onMisfire = input.onMisfire;
    return { start: vi.fn(async () => {}), pause: vi.fn(), destroy: vi.fn() };
  });
  const createQueue = vi.fn<(onState?: (state: PlaybackState) => void) => PlaybackQueue>(
    (onState) => {
      queueOnState.value = onState;
      return queue;
    },
  );
  const createSplitter = vi.fn<() => SentenceSplitter>(() => ({
    push: (chunk: string) => chunk.split(/\./).filter((s) => s.length > 0),
    flush: () => [],
  }));
  const patchHeardPortion = vi.fn<(heardChars: number) => void>();
  const onUtterance = vi.fn<(blob: Blob) => void>();

  const deps: ConversationModeDeps = {
    getUserMedia,
    acquireLock,
    createVadFn,
    createQueue,
    createSplitter,
    metrics: { record: vi.fn<(event: TelemetryEvent) => void>(), flush: vi.fn(async () => {}) },
    patchHeardPortion,
    onUtterance,
    ...overrides,
  };

  return {
    result: undefined as unknown as ConversationModeHandle,
    getUserMedia,
    acquireLock,
    createVadFn,
    createQueue,
    createSplitter,
    patchHeardPortion,
    onUtterance,
    vadCallbacks,
    queueOnState,
    queue,
    metrics: { record: vi.fn<(event: TelemetryEvent) => void>(), flush: vi.fn(async () => {}) },
    config: overrides.config,
    dateNow: { value: 1000 },
  };
}

function Probe({ harness }: { harness: Harness }): ReactElement {
  harness.result = useConversationMode({
    getUserMedia: harness.getUserMedia,
    acquireLock: harness.acquireLock,
    createVadFn: harness.createVadFn,
    createQueue: harness.createQueue,
    createSplitter: harness.createSplitter,
    metrics: harness.metrics,
    patchHeardPortion: harness.patchHeardPortion,
    onUtterance: harness.onUtterance,
    config: harness.config,
  });
  return <span>{harness.result.state}</span>;
}

function mount(harness: Harness): void {
  render(<Probe harness={harness} />);
}

function speechEnd(harness: Harness, samples: Float32Array): void {
  act(() => {
    harness.vadCallbacks.onSpeechEnd(samples);
  });
}

describe('useConversationMode', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = setupHarness();
    vi.spyOn(Date, 'now').mockImplementation(() => harness.dateNow.value);
  });

  it('records end-of-speech to first audio once for the actual spoken turn', async () => {
    mount(harness);
    await act(async () => { await harness.result.start(); });
    act(() => { harness.vadCallbacks.onSpeechStart(); });
    harness.dateNow.value = 2000;
    speechEnd(harness, new Float32Array(16000));
    harness.dateNow.value = 2400;
    act(() => { harness.result.feedReplyChunk('Hello.'); });
    harness.dateNow.value = 3000;
    act(() => { harness.queueOnState.value?.('speaking'); });
    act(() => { harness.queueOnState.value?.('speaking'); });
    const timings = harness.metrics.record.mock.calls.filter(([event]) => event.event === 'turn_timing');
    expect(timings).toEqual([[{ event: 'turn_timing', eos_to_first_audio_ms: 1000 }]]);
  });

  it('starts in off with the mic closed', () => {
    mount(harness);
    expect(harness.result.state).toBe('off');
    expect(harness.result.micLive).toBe(false);
    expect(harness.getUserMedia).not.toHaveBeenCalled();
  });

  it('opens the mic only in listening and hearing', async () => {
    mount(harness);
    await act(async () => {
      await harness.result.start();
    });
    expect(harness.result.state).toBe('listening');
    expect(harness.result.micLive).toBe(true);
    expect(harness.getUserMedia).toHaveBeenCalledTimes(1);

    act(() => {
      harness.vadCallbacks.onSpeechStart();
    });
    expect(harness.result.state).toBe('hearing');
    expect(harness.result.micLive).toBe(true);
    expect(harness.getUserMedia).toHaveBeenCalledTimes(1);

    act(() => {
      harness.result.mute();
    });
    expect(harness.result.state).toBe('muted');
    expect(harness.result.micLive).toBe(false);
  });

  it('denied lock gives paused with a reason', async () => {
    harness.acquireLock.mockResolvedValueOnce(false);
    mount(harness);
    await act(async () => {
      await harness.result.start();
    });
    expect(harness.result.state).toBe('paused');
    expect(harness.result.reason).toBe('Voice is on in another tab');
    expect(harness.getUserMedia).not.toHaveBeenCalled();
  });

  it('a short noise while speaking does not interrupt', async () => {
    mount(harness);
    await act(async () => {
      await harness.result.start();
    });
    await waitFor(() => expect(harness.createVadFn).toHaveBeenCalled());
    act(() => {
      harness.vadCallbacks.onSpeechStart();
    });
    harness.dateNow.value += DEFAULT_CONFIG.MIN_SPEECH_MS + 1;
    speechEnd(harness, new Float32Array(160));
    expect(harness.result.state).toBe('thinking');

    act(() => {
      harness.queueOnState.value?.('speaking');
    });
    expect(harness.result.state).toBe('speaking');

    act(() => {
      harness.vadCallbacks.onSpeechStart();
    });
    harness.dateNow.value += DEFAULT_CONFIG.MIN_INTERRUPTION_MS - 1;
    speechEnd(harness, new Float32Array(160));
    expect(harness.result.state).toBe('speaking');
    expect(harness.queue.stop).not.toHaveBeenCalled();
  });

  it('a real barge-in stops the queue and patches heard chars', async () => {
    harness.queue.stop.mockReturnValueOnce({ heardChars: 42 });
    mount(harness);
    await act(async () => {
      await harness.result.start();
    });
    await waitFor(() => expect(harness.createVadFn).toHaveBeenCalled());
    act(() => {
      harness.vadCallbacks.onSpeechStart();
    });
    harness.dateNow.value += DEFAULT_CONFIG.MIN_SPEECH_MS + 1;
    speechEnd(harness, new Float32Array(160));
    act(() => {
      harness.queueOnState.value?.('speaking');
    });
    act(() => {
      harness.vadCallbacks.onSpeechStart();
    });
    harness.dateNow.value += DEFAULT_CONFIG.MIN_INTERRUPTION_MS + 1;
    speechEnd(harness, new Float32Array(160));
    expect(harness.result.state).toBe('listening');
    expect(harness.queue.stop).toHaveBeenCalled();
    await waitFor(() => expect(harness.patchHeardPortion).toHaveBeenCalledWith(42));
  });

  it('hidden pauses and releases the mic', async () => {
    mount(harness);
    await act(async () => {
      await harness.result.start();
    });
    expect(harness.result.micLive).toBe(true);
    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(harness.result.state).toBe('paused');
    await waitFor(() => expect(harness.result.micLive).toBe(false));
  });

  it('resume restarts from paused', async () => {
    mount(harness);
    await act(async () => {
      await harness.result.start();
    });
    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(harness.result.state).toBe('paused');
    await act(async () => {
      harness.result.resume();
    });
    expect(harness.result.state).toBe('listening');
    await waitFor(() => expect(harness.result.micLive).toBe(true));
  });

  it('idle timeout switches off', async () => {
    harness.config = { IDLE_TIMEOUT_MS: 20 };
    mount(harness);
    await act(async () => {
      await harness.result.start();
    });
    expect(harness.result.state).toBe('listening');
    await waitFor(() => expect(harness.result.state).toBe('off'), { timeout: 1000 });
  });

  it('unmount cleans up the mic', async () => {
    const view = render(<Probe harness={harness} />);
    await act(async () => {
      await harness.result.start();
    });
    expect(harness.result.micLive).toBe(true);
    const stream = harness.getUserMedia.mock.results[0].value as Promise<MediaStream>;
    const ms = await stream;
    act(() => {
      view.unmount();
    });
    await waitFor(() => expect(ms.getTracks()[0].stop).toHaveBeenCalled());
  });

  it('an accepted utterance calls onUtterance with a blob', async () => {
    mount(harness);
    await act(async () => {
      await harness.result.start();
    });
    await waitFor(() => expect(harness.createVadFn).toHaveBeenCalled());
    act(() => {
      harness.vadCallbacks.onSpeechStart();
    });
    harness.dateNow.value += DEFAULT_CONFIG.MIN_SPEECH_MS + 1;
    speechEnd(harness, new Float32Array(160));
    expect(harness.result.state).toBe('thinking');
    await waitFor(() => expect(harness.onUtterance).toHaveBeenCalledTimes(1));
    expect(harness.onUtterance.mock.calls[0][0]).toBeInstanceOf(Blob);
  });
});