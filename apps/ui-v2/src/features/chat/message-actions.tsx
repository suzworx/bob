import { BRAND } from '@/lib/brand';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Check, ChevronLeft, ChevronRight, Copy, RefreshCw, ThumbsUp, ThumbsDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import type { ContextMenu } from '@astryxdesign/core/ContextMenu';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Text } from '@astryxdesign/core/Text';
import { sendReplyFeedback } from '@/features/metrics/reply-feedback';

function ReplyFeedback({ traceId }: { traceId: string }): ReactElement {
  const [rating, setRating] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const rate = async (positive: boolean): Promise<void> => {
    setPending(true);
    try {
      await sendReplyFeedback(traceId, positive);
      setRating(positive);
    } finally { setPending(false); }
  };
  return (
    <>
      <IconButton label="Helpful response" tooltip="Helpful" variant={rating === true ? 'secondary' : 'ghost'} size="sm"
        icon={<Icon icon={ThumbsUp} size="sm" />} isDisabled={pending || rating === true} onClick={() => void rate(true)} />
      <IconButton label="Unhelpful response" tooltip="Unhelpful" variant={rating === false ? 'secondary' : 'ghost'} size="sm"
        icon={<Icon icon={ThumbsDown} size="sm" />} isDisabled={pending || rating === false} onClick={() => void rate(false)} />
    </>
  );
}

// Session versions of one reply, oldest first; `active` is the one shown.
export type MessageVersions = {
  texts: string[];
  traceIds?: Array<string | undefined>;
  active: number;
  onSelect: (index: number) => void;
};

// Steps wrap around, as v1's branch selector does.
export function VersionSelector({ versions }: { versions: MessageVersions }): ReactElement {
  const count = versions.texts.length;
  const step = (delta: number): void => versions.onSelect((versions.active + delta + count) % count);
  return (
    <HStack gap={1} vAlign="center" wrap="wrap">
      <IconButton
        label="Previous version"
        tooltip="Previous version"
        variant="ghost"
        size="sm"
        icon={<Icon icon={ChevronLeft} size="sm" />}
        onClick={() => step(-1)}
      />
      <Text type="supporting">{`${versions.active + 1} of ${count}`}</Text>
      {versions.active !== count - 1 && (
        <Text type="supporting" size="sm">
          Session only. {BRAND.name} continues from the newest version.
        </Text>
      )}
      <IconButton
        label="Next version"
        tooltip="Next version"
        variant="ghost"
        size="sm"
        icon={<Icon icon={ChevronRight} size="sm" />}
        onClick={() => step(1)}
      />
    </HStack>
  );
}

export function AssistantActions({
  text,
  busy,
  versions,
  onRegenerate,
  onCopyFailure,
  traceId,
}: {
  text: string;
  busy: boolean;
  versions?: MessageVersions;
  onRegenerate?: () => void;
  onCopyFailure?: () => void;
  traceId?: string;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      onCopyFailure?.();
    }
  };

  return (
    <HStack gap={1} vAlign="center" wrap="wrap">
      {versions && <VersionSelector versions={versions} />}
      {traceId && <ReplyFeedback key={traceId} traceId={traceId} />}
      {onRegenerate && (
        <IconButton
          label="Regenerate reply"
          tooltip="Regenerate"
          variant="ghost"
          size="sm"
          icon={<Icon icon={RefreshCw} size="sm" />}
          isDisabled={busy}
          onClick={onRegenerate}
        />
      )}
      <IconButton
        label={copied ? 'Copied' : 'Copy response'}
        tooltip={copied ? 'Copied' : 'Copy'}
        variant="ghost"
        size="sm"
        icon={<Icon icon={copied ? Check : Copy} size="sm" />}
        onClick={() => void copy()}
      />
    </HStack>
  );
}

export type MessageMenuItems = NonNullable<ComponentProps<typeof ContextMenu>['items']>;

// Phone: the visible second path to the long-press actions. One compact ghost
// icon button on the bubble's metadata line; the menu is a bottom sheet on touch.
export function PhoneMoreActions({ items }: { items: MessageMenuItems }): ReactElement | null {
  return items.length === 0 ? null : (
    <MoreMenu label="More actions" size="sm" variant="ghost" alignment="end" presentation="adaptive" items={items} />
  );
}

// Phone: the per-reply action row is hidden and these are the same actions in a
// long-press menu (Astryx ContextMenu, a bottom sheet on touch).
export function replyMenuItems({
  text,
  busy,
  onRegenerate,
  onCopyFailure,
  onCopied,
  traceId,
}: {
  text: string;
  busy: boolean;
  onRegenerate?: () => void;
  onCopyFailure?: () => void;
  onCopied?: () => void;
  traceId?: string;
}): MessageMenuItems {
  return [
    {
      label: 'Copy',
      icon: Copy,
      onClick: () => void navigator.clipboard.writeText(text).then(() => onCopied?.(), () => onCopyFailure?.()),
    },
    ...(onRegenerate ? [{ label: 'Regenerate', icon: RefreshCw, isDisabled: busy, onClick: onRegenerate }] : []),
    ...(traceId
      ? [
          { label: 'Helpful', icon: ThumbsUp, onClick: () => void sendReplyFeedback(traceId, true) },
          { label: 'Unhelpful', icon: ThumbsDown, onClick: () => void sendReplyFeedback(traceId, false) },
        ]
      : []),
  ];
}
