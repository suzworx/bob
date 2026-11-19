import { useCallback, useEffect, useRef, useState } from 'react';
import { useVoice, type VoiceError } from '@/features/voice/use-voice';

// Dictate: speech to text into the message box, nothing sent. One tap starts a
// recording, the next stops it; the clip is transcribed by the same server
// path a spoken turn uses and handed to `onText` for the reader to edit and
// send. It never sends, and it is never blocked by a reply in flight.

const DICTATION_ERROR_COPY: Record<VoiceError, string> = {
  permission: 'Allow the microphone for this site in your browser settings, then try again.',
  no_device: 'Connect a microphone, then try again.',
  unsupported: "This browser can't record. Type instead, or try a current browser.",
  too_long: 'That was a bit long. Try a shorter message.',
  playback: "Couldn't play that back.",
  upload: "Couldn't hear that. Try again.",
  out_of_credit: 'Bob needs a rest: the usage limit is reached.',
};

export type Dictation = {
  recording: boolean;
  transcribing: boolean;
  error: string | null;
  toggle: () => void;
  clearError: () => void;
};

function microphone(): typeof navigator.mediaDevices.getUserMedia | null {
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function' || typeof MediaRecorder === 'undefined') return null;
  return navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
}

function failureOf(cause: unknown): VoiceError {
  const name = (cause as DOMException | null)?.name;
  if (name === 'NotAllowedError') return 'permission';
  if (name === 'NotFoundError') return 'no_device';
  return 'unsupported';
}

export function useDictation({
  onText,
  onRecordingChange,
}: {
  onText: (text: string) => void;
  // Lets the caller step hands-free aside while a dictation records, so the
  // same speech is not heard twice.
  onRecordingChange?: (recording: boolean) => void;
}): Dictation {
  const voice = useVoice();
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [localError, setLocalError] = useState<VoiceError | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const startingRef = useRef(false);
  const disposedRef = useRef(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const onRecordingRef = useRef(onRecordingChange);
  onRecordingRef.current = onRecordingChange;

  const setRecordingBoth = useCallback((next: boolean): void => {
    setRecording(next);
    onRecordingRef.current?.(next);
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    };
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (startingRef.current) return;
    const getUserMedia = microphone();
    setLocalError(null);
    voice.clearError();
    if (!getUserMedia) {
      setLocalError('unsupported');
      return;
    }
    startingRef.current = true;
    try {
      const stream = await getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      // Media capture lifecycle only: audio is never inspected or logged.
      recorder.ondataavailable = (event: BlobEvent): void => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = (): void => {
        for (const track of stream.getTracks()) track.stop();
        recorderRef.current = null;
        setRecordingBoth(false);
        const clip = new Blob(chunks, { type: 'audio/webm' });
        if (clip.size === 0 || disposedRef.current) return;
        setTranscribing(true);
        void voice
          .transcribe(clip)
          .then((text) => {
            const trimmed = text?.trim();
            if (trimmed && !disposedRef.current) onTextRef.current(trimmed);
          })
          .finally(() => setTranscribing(false));
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecordingBoth(true);
    } catch (cause) {
      setLocalError(failureOf(cause));
    } finally {
      startingRef.current = false;
    }
  }, [setRecordingBoth, voice]);

  const toggle = useCallback((): void => {
    if (transcribing) return;
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    else void start();
  }, [start, transcribing]);

  const code = localError ?? voice.error;
  return {
    recording,
    transcribing,
    error: code ? DICTATION_ERROR_COPY[code] : null,
    toggle,
    clearError: () => {
      setLocalError(null);
      voice.clearError();
    },
  };
}
