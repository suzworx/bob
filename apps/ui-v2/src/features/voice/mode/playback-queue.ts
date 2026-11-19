export type PlaybackState = 'idle' | 'speaking';

export interface PlaybackQueueDeps {
  synthesize(text: string, signal: AbortSignal): Promise<string>;
  play(url: string): Promise<void>;
  stopPlayback(): void;
  revoke(url: string): void;
  onState?(state: PlaybackState): void;
  onError?(error: unknown): void;
}

export interface PlaybackQueue {
  enqueue(text: string): void;
  stop(): { heardChars: number };
  readonly speaking: boolean;
}

type EntryState = 'pending' | 'synthesizing' | 'ready' | 'failed' | 'aborted';

interface Entry {
  text: string;
  url: string | null;
  state: EntryState;
}

const MAX_INFLIGHT = 2;

export function createPlaybackQueue(deps: PlaybackQueueDeps): PlaybackQueue {
  let entries: Entry[] = [];
  let inflight = 0;
  let playing = false;
  let heardChars = 0;
  let speaking = false;
  let currentPlay: Entry | null = null;
  let abortController: AbortController | null = null;
  let generation = 0;
  const urls = new Set<string>();

  const setSpeaking = (value: boolean): void => {
    if (speaking === value) return;
    speaking = value;
    deps.onState?.(value ? 'speaking' : 'idle');
  };

  const startSynthesis = (entry: Entry): void => {
    entry.state = 'synthesizing';
    inflight += 1;
    const gen = generation;
    const signal = abortController?.signal;
    if (!signal) {
      inflight -= 1;
      entry.state = 'failed';
      return;
    }
    deps
      .synthesize(entry.text, signal)
      .then((url) => {
        if (gen === generation) inflight -= 1;
        if (entry.state === 'aborted') {
          deps.revoke(url);
          urls.delete(url);
          return;
        }
        if (gen !== generation) return;
        entry.url = url;
        urls.add(url);
        entry.state = 'ready';
        pump();
      })
      .catch((error: unknown) => {
        if (gen === generation) inflight -= 1;
        if (entry.state === 'aborted') return;
        if (gen !== generation) return;
        entry.state = 'failed';
        deps.onError?.(error);
        pump();
      });
  };

  const releaseUrl = (entry: Entry): void => {
    if (entry.url) {
      deps.revoke(entry.url);
      urls.delete(entry.url);
      entry.url = null;
    }
  };

  const playHead = async (entry: Entry): Promise<void> => {
    const gen = generation;
    currentPlay = entry;
    playing = true;
    setSpeaking(true);
    try {
      if (!entry.url) return;
      await deps.play(entry.url);
      if (gen !== generation) return;
      if (entry.state === 'aborted') return;
      heardChars += entry.text.length;
      releaseUrl(entry);
      entries.shift();
    } catch (error: unknown) {
      if (gen !== generation) return;
      if (entry.state === 'aborted') return;
      deps.onError?.(error);
      releaseUrl(entry);
      entries.shift();
    } finally {
      if (gen === generation && currentPlay === entry) {
        currentPlay = null;
        playing = false;
        pump();
      }
    }
  };

  const pump = (): void => {
    while (inflight < MAX_INFLIGHT) {
      const next = entries.find((entry) => entry.state === 'pending');
      if (!next) break;
      startSynthesis(next);
    }
    if (!playing) {
      while (
        entries.length > 0 &&
        (entries[0].state === 'failed' || entries[0].state === 'aborted')
      ) {
        entries.shift();
      }
      const head = entries[0];
      if (head && head.state === 'ready') {
        void playHead(head);
      }
    }
    if (!playing && inflight === 0 && entries.length === 0) {
      setSpeaking(false);
    }
  };

  const enqueue = (text: string): void => {
    if (!abortController) abortController = new AbortController();
    entries.push({ text, url: null, state: 'pending' });
    pump();
  };

  const stop = (): { heardChars: number } => {
    abortController?.abort();
    abortController = null;
    deps.stopPlayback();
    for (const url of urls) deps.revoke(url);
    urls.clear();
    for (const entry of entries) entry.state = 'aborted';
    entries.length = 0;
    inflight = 0;
    playing = false;
    currentPlay = null;
    generation += 1;
    const result = { heardChars };
    heardChars = 0;
    setSpeaking(false);
    return result;
  };

  return {
    enqueue,
    stop,
    get speaking(): boolean {
      return speaking;
    },
  };
}