import { useState, type ReactElement, type RefObject } from 'react';
import { Pause, Play } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';

// m:ss, and 0:00 until the browser knows the duration (NaN or Infinity).
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

// The spoken reply's player. The native audio element (no controls of its own)
// is what useChatVoice autoplays and pauses through `audioRef`; the button and
// the time are the visible controls. Callers key it by `src` so a new reply
// starts from zero.
export function SpokenReplyPlayer({
  src,
  audioRef,
}: {
  src: string;
  audioRef: RefObject<HTMLAudioElement | null>;
}): ReactElement {
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [total, setTotal] = useState(0);

  const toggle = (): void => {
    const element = audioRef.current;
    if (!element) return;
    // A refused play (autoplay policy) leaves the player as it was.
    if (element.paused) void element.play().catch(() => {});
    else element.pause();
  };

  return (
    <HStack hAlign="center" vAlign="center" gap={2}>
      <audio
        aria-label="Spoken reply"
        ref={audioRef}
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setTotal(event.currentTarget.duration)}
        onDurationChange={(event) => setTotal(event.currentTarget.duration)}
      />
      <Button
        label="Play or pause the spoken reply"
        tooltip={playing ? 'Pause' : 'Play'}
        variant="ghost"
        size="sm"
        isIconOnly
        icon={<Icon icon={playing ? Pause : Play} size="sm" />}
        onClick={toggle}
      />
      <Text type="supporting" hasTabularNumbers>
        {formatTime(elapsed)} / {formatTime(total)}
      </Text>
    </HStack>
  );
}
