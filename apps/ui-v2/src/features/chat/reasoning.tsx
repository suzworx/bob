import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Text } from '@astryxdesign/core/Text';
import { RichMarkdown } from './rich-markdown';

// Under this many seconds the trigger says "a few seconds" rather than a count.
const FEW_SECONDS = 2;

export function thoughtLabel(isStreaming: boolean, seconds: number | null): string {
  if (isStreaming) return 'Thinking...';
  if (seconds === null || seconds < FEW_SECONDS) return 'Thought for a few seconds';
  return `Thought for ${seconds} seconds`;
}

// A collapsed-by-default disclosure above the reply body. The duration is
// measured here, from the render that first saw the part streaming to the one
// that saw it finish; a part restored already finished has no start to measure
// from, so it reads "a few seconds".
export function Reasoning({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}): ReactElement {
  const startedAt = useRef<number | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (isStreaming) {
      startedAt.current ??= Date.now();
    } else if (startedAt.current !== null) {
      setSeconds(Math.round((Date.now() - startedAt.current) / 1000));
      startedAt.current = null;
    }
  }, [isStreaming]);

  return (
    <Collapsible
      defaultIsOpen={false}
      trigger={<Text type="supporting">{thoughtLabel(isStreaming, seconds)}</Text>}
    >
      <RichMarkdown density="compact" isStreaming={isStreaming}>
        {text}
      </RichMarkdown>
    </Collapsible>
  );
}
