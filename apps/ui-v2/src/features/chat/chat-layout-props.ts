import { useAppShellMobile } from '@astryxdesign/core/AppShell';

// The one place the phone chat frame is decided, shared by every transcript
// (the chat and the space thread). Spread `layout` on ChatLayout, `list` on
// ChatMessageList and give the docked composer `composerInset` as paddingInline.
// On a phone messages are compact, start at the top under the header (not
// bottom-anchored), and the composer takes spacing token 3 more to reach the
// 16px gutter. Desktop returns Astryx's spacious frame and no overrides.
export function usePhoneChatLayout(): {
  isMobile: boolean;
  layout: { density: 'compact' | 'spacious' };
  list: { density?: 'compact'; align?: 'top' };
  composerInset: 3 | undefined;
} {
  const { isMobile } = useAppShellMobile();
  return {
    isMobile,
    layout: { density: isMobile ? 'compact' : 'spacious' },
    list: isMobile ? { density: 'compact', align: 'top' } : {},
    composerInset: isMobile ? 3 : undefined,
  };
}
