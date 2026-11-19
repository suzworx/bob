import type { ReactElement } from 'react';
import { Mic, MicOff, Play, Square } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { Toolbar } from '@astryxdesign/core/Toolbar';
import { DISPLAY_LABELS, type State } from '@/features/voice/mode/conversation-mode';

// Hands-free is a state of the composer, not a second surface: while it is off
// there is nothing to show (the composer's Voice mode button starts it), and
// once it is on a slim toolbar sits just above the composer. The state label is
// the live region, so each change (Listening, Thinking, Speaking) is announced.
export function VoiceModeBar({
  state,
  micLive,
  reason,
  onStop,
  onMute,
  onUnmute,
  onResume,
}: {
  state: State;
  micLive: boolean;
  reason?: string | null;
  onStop?: () => void;
  onMute?: () => void;
  onUnmute?: () => void;
  onResume?: () => void;
}): ReactElement | null {
  if (state === 'off') return null;
  const paused = state === 'paused';
  const label = paused && reason ? `${DISPLAY_LABELS[state]}: ${reason}` : DISPLAY_LABELS[state];

  return (
    <Toolbar
      label="Voice mode"
      size="sm"
      gap={1.5}
      startContent={
        <HStack vAlign="center" gap={2}>
          <StatusDot
            variant={micLive ? 'success' : 'neutral'}
            label={micLive ? 'Microphone live' : 'Microphone off'}
          />
          <Text type="label" role="status" aria-live="polite">
            {label}
          </Text>
        </HStack>
      }
      endContent={
        <>
          {paused && onResume ? (
            <Button label="Resume" icon={<Icon icon={Play} size="sm" />} onClick={onResume} />
          ) : null}
          {state === 'muted' && onUnmute ? (
            <Button label="Unmute" icon={<Icon icon={Mic} size="sm" />} onClick={onUnmute} />
          ) : !paused && state !== 'muted' && onMute ? (
            <Button label="Mute" icon={<Icon icon={MicOff} size="sm" />} onClick={onMute} />
          ) : null}
          {!paused ? (
            <Button label="Stop" variant="ghost" icon={<Icon icon={Square} size="sm" />} onClick={onStop} />
          ) : null}
        </>
      }
    />
  );
}
