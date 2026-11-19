import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { navigateTo } from '@/app/routes';
import { BRAND } from '@/lib/brand';
import type { ChatStatus, UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth/use-session';
import { OUT_OF_CREDIT, useVoice, type VoiceError } from '@/features/voice/use-voice';
import { acquireMicLock, type MicLock } from '@/features/voice/mode/lock';
import { createMetrics, type Metrics } from '@/features/voice/mode/metrics';
import { createPlaybackQueue, type PlaybackQueue } from '@/features/voice/mode/playback-queue';
import { createSentenceSplitter } from '@/features/voice/mode/sentence-split';
import {
  useConversationMode,
  type ConversationModeHandle,
  type VadInput,
} from '@/features/voice/mode/use-conversation-mode';
import type { VadHandle } from '@/features/voice/mode/vad';
import { OUT_OF_CREDIT_NOTICE, type ChatNotice } from '../chat/chat-notices';
import { messageText } from '../chat/message-view';

const VOICE_ERROR_COPY: Record<VoiceError, string> = {
  permission: `${BRAND.assistantName} can't hear you. Allow the microphone for this site in your browser settings.`,
  no_device: `${BRAND.assistantName} can't find a microphone. Connect one, then try again.`,
  unsupported: "This browser can't do voice. Type instead, or try a current browser.",
  too_long: 'That was a bit long. Try a shorter message.',
  playback: "Couldn't play that back.",
  upload: "Couldn't hear that. Try again.",
  out_of_credit: OUT_OF_CREDIT_NOTICE,
};
const SPEECH_TRUNCATED_NOTICE = `${BRAND.assistantName} read out a shorter version of that reply.`;


// The VAD module pulls in vad-web and onnxruntime-web, which readers who never
// use hands-free should not download. It loads on the first hands-free start and
// the promise is kept for later ones; a failed load is forgotten so a retry
// fetches the chunk again.
let vadModule: Promise<typeof import('@/features/voice/mode/vad')> | null = null;
async function createVadLazily(input: VadInput): Promise<VadHandle> {
  if (!vadModule) {
    vadModule = import('@/features/voice/mode/vad').catch((error: unknown) => {
      vadModule = null;
      throw error;
    });
  }
  return (await vadModule).createVad(input);
}

type ChatVoice = {
  mode: ConversationModeHandle;
  audioUrl: string | null;
  audioRef: RefObject<HTMLAudioElement | null>;
  notices: ChatNotice[];
  // The turn's Stop: also silences the spoken reply and disarms autoplay.
  stop: () => void;
  mic: {
    // Pointer-down on Dictate or Voice mode silences a spoken reply (barge-in).
    onPointerDown: () => void;
    onCaptureUnavailable: (code: VoiceError) => void;
  };
};

// Where a turn was spoken, as /api/chat's `origin` field names it. A typed turn
// sends none (the server defaults it to web_text), so only the voice path has one.
export type TurnOrigin = 'web_voice';

type ChatVoiceArgs = {
  conversationId: string | null;
  messages: UIMessage[];
  busy: boolean;
  status: ChatStatus;
  send: (text: string, origin: TurnOrigin, workflowId?: string) => void;
  stop: () => void;
};

const latestAssistant = (messages: UIMessage[]): UIMessage | undefined =>
  [...messages].reverse().find((candidate) => candidate.role === 'assistant');

export function useChatVoice({ conversationId, messages, busy, status, send, stop }: ChatVoiceArgs): ChatVoice {
  const voice = useVoice();
  const playbackQueueRef = useRef<PlaybackQueue | null>(null);
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;
  const workflowRef = useRef<{ id: string; traceId?: string } | null>(null);
  const metricsRef = useRef<ReturnType<typeof createMetrics> | null>(null);
  const metrics = useMemo<Metrics>(() => ({
    record(event) {
      const traceId = workflowRef.current?.traceId;
      metricsRef.current?.record(event.event === 'turn_timing' && traceId ? { ...event, trace_id: traceId } : event);
    },
    async flush() { await metricsRef.current?.flush(); },
  }), []);
  useEffect(() => {
    const sink = createMetrics();
    metricsRef.current = sink;
    return () => { sink.dispose(); metricsRef.current = null; };
  }, []);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Set from a voice-origin send until that turn ends: only such a reply is spoken.
  const voiceTurnRef = useRef(false);
  // Armed while a voice reply is being synthesized, consumed once its URL lands.
  const pendingAutoplayRef = useRef(false);
  const lockRef = useRef<MicLock | null>(null);
  const disposedRef = useRef(false);
  const wasBusyRef = useRef(false);
  // The assistant message being fed to the sentence splitter, and how much of it
  // has been handed over, so a streaming reply is enqueued exactly once.
  const replyFedRef = useRef({ id: '', fed: '', ended: false });
  const lastAssistantIdRef = useRef<string | null>(null);
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const getUserMedia = useMemo(
    () =>
      (navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices) ??
        (async () => {
          throw new DOMException('microphone unavailable', 'NotFoundError');
        })) as typeof navigator.mediaDevices.getUserMedia,
    [],
  );

  // v1 never released the lock, so a second Start in the same tab was refused
  // until reload. It is released when the mode goes off and on unmount.
  const releaseLock = useCallback((): void => {
    lockRef.current?.release();
    lockRef.current = null;
  }, []);

  // Barge-in: how much of the reply the reader heard before cutting in.
  const patchHeardPortion = useCallback(
    (heardChars: number): void => {
      const messageId = lastAssistantIdRef.current;
      if (!heardChars || !conversationId || !messageId) return;
      void fetchWithAuth(`/api/conversations/${conversationId}/messages/${messageId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ heard_chars: heardChars, interrupted: true }),
      }).catch(() => {});
    },
    [conversationId],
  );

  // A hands-free utterance takes the path a typed turn does: transcribed,
  // trimmed, and sent as a voice-origin turn. The server stores it as spoken, so
  // the origin travels with the request; v1 only marked it here, and a reload
  // then showed it as typed. Its timing is recorded by the mode.
  const sendClip = useCallback(
    async (clip: Blob): Promise<void> => {
      const clipConversation = conversationRef.current;
      playbackQueueRef.current?.stop();
      const id = crypto.randomUUID();
      workflowRef.current = { id };
      const text = await voice.transcribe(clip, { workflowId: id, onTrace: (traceId) => {
        if (workflowRef.current?.id === id) workflowRef.current.traceId = traceId;
      } });
      const trimmed = text?.trim();
      if (!trimmed || disposedRef.current || workflowRef.current?.id !== id || clipConversation !== conversationRef.current) return;
      voiceTurnRef.current = true;
      sendRef.current(trimmed, 'web_voice', id);
    },
    [voice.transcribe],
  );

  const mode = useConversationMode({
    getUserMedia,
    acquireLock: async () => {
      releaseLock();
      const lock = await acquireMicLock();
      if (lock.held && disposedRef.current) lock.release();
      else if (lock.held) lockRef.current = lock;
      return lock.held && !disposedRef.current;
    },
    createVadFn: createVadLazily,
    createQueue: (onState) => {
      const queue = createPlaybackQueue({
        synthesize: (text, signal) => voice.synthesize(text, signal, workflowRef.current?.id),
        play: voice.play,
        stopPlayback: voice.stopPlayback,
        revoke: voice.revoke,
        onState: (state) => onState?.(state),
        // A spent budget gets the plain notice; other sentence failures stay quiet.
        onError: (error) => { if (error instanceof Error && error.message === OUT_OF_CREDIT) voice.setError(OUT_OF_CREDIT); },
      });
      playbackQueueRef.current = queue;
      return queue;
    },
    createSplitter: createSentenceSplitter,
    metrics,
    patchHeardPortion,
    onUtterance: (blob: Blob): void => {
      void sendClip(blob);
    },
  });

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      workflowRef.current = null;
      releaseLock();
    };
  }, [releaseLock]);
  useEffect(() => {
    if (mode.state === 'off') releaseLock();
  }, [mode.state, releaseLock]);

  // Silences the spoken reply and disarms autoplay, so a pending synthesis cannot
  // start talking after the reader has moved on.
  const pauseSpokenReply = useCallback((): void => {
    pendingAutoplayRef.current = false;
    audioRef.current?.pause();
  }, []);

  // A voice turn's reply plays as soon as its audio exists. Autoplay is often
  // refused without a fresh gesture; the rejection is swallowed and the player
  // stays visible for a tap.
  useEffect(() => {
    if (!pendingAutoplayRef.current || !voice.audioUrl) return;
    const element = audioRef.current;
    if (!element) return;
    pendingAutoplayRef.current = false;
    void element.play().catch(() => {});
  }, [voice.audioUrl]);

  // Feed the streaming reply to the sentence splitter so the queue speaks each
  // sentence, and flush the tail once the turn stops being busy.
  const { feedReplyChunk, endReply } = mode;
  useEffect(() => {
    const last = latestAssistant(messages);
    lastAssistantIdRef.current = last?.id ?? null;
    if (!last) return;
    const metadata = last.metadata as { workflowId?: string; traceId?: string } | undefined;
    if (metadata?.workflowId && metadata.traceId && /^[a-f0-9]{32}$/.test(metadata.traceId)) {
      workflowRef.current = { id: metadata.workflowId, traceId: metadata.traceId };
    }
    const text = messageText(last);
    if (mode.state === 'off') {
      // History is never read aloud: while off, a finished reply counts as fed,
      // so starting hands-free does not replay the previous answer.
      if (!busy) replyFedRef.current = { id: last.id, fed: text, ended: true };
      return;
    }
    if (last.id !== replyFedRef.current.id) replyFedRef.current = { id: last.id, fed: '', ended: false };
    const cursor = replyFedRef.current;
    if (!cursor.ended && text.length > cursor.fed.length) {
      replyFedRef.current = { ...cursor, fed: text };
      feedReplyChunk(text.slice(cursor.fed.length));
    }
    if (!busy && !cursor.ended && text) {
      replyFedRef.current = { ...replyFedRef.current, ended: true };
      endReply();
    }
  }, [messages, busy, mode.state, feedReplyChunk, endReply]);

  // A voice turn that completed (not an error, not a stop) after hands-free was
  // ended is still spoken; while hands-free is on, the queue speaks it.
  useEffect(() => {
    const wasBusy = wasBusyRef.current;
    wasBusyRef.current = busy;
    if (!wasBusy || busy) return;
    const armed = voiceTurnRef.current;
    voiceTurnRef.current = false;
    const last = latestAssistant(messages);
    const text = last ? messageText(last) : '';
    if (!armed || status !== 'ready' || mode.state !== 'off' || !text) return;
    pendingAutoplayRef.current = true;
    void voice.speak(text, workflowRef.current?.id);
  }, [busy, status, messages, mode.state, voice.speak]);

  const notices: ChatNotice[] = [];
  if (voice.error) {
    notices.push({
      id: 'voice-error',
      tone: 'error',
      text: VOICE_ERROR_COPY[voice.error],
      // A spent budget cannot be retried; the reader can see their usage instead.
      action: voice.error === OUT_OF_CREDIT ? { label: 'See usage', onPress: () => navigateTo('/settings#usage') } : undefined,
    });
  }
  if (voice.truncated) notices.push({ id: 'speech-truncated', tone: 'info', text: SPEECH_TRUNCATED_NOTICE });

  return {
    mode,
    audioUrl: voice.audioUrl,
    audioRef,
    notices,
    stop: () => {
      // A stopped turn must not auto-play.
      voiceTurnRef.current = false;
      workflowRef.current = null;
      playbackQueueRef.current?.stop();
      pauseSpokenReply();
      stop();
    },
    mic: {
      onPointerDown: pauseSpokenReply,
      onCaptureUnavailable: voice.setError,
    },
  };
}
