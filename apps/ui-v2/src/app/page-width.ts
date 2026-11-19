import { createElement, type ReactElement, type ReactNode } from 'react';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';

// The one content width for every page and every conversation. The chat
// landing's composer, a conversation, a space and a settings page all sit in
// this frame, so nothing jumps sideways when you move between them. Passed to
// Astryx Layout `contentWidth`, which treats a number as pixels and includes
// the frame's padding.
//
// A conversation is framed by ChatLayout's spacious density instead, which caps
// its messages and composer at 800px. 872 is that 800 plus the landing's
// padding={6} (24px a side) and its composer inset (spacing-3, 12px a side), so
// the composer keeps its edges when the first message lands.
export const PAGE_WIDTH = 872;

// The side gutter of that frame as Astryx spacing tokens: 24px (spacing-6) on
// desktop, the 16px phone norm (spacing-4) on Astryx's mobile breakpoint. Every
// list page passes usePagePadding() to Layout `padding`, never a literal 6.
export const PAGE_PADDING = 6;
export const PHONE_PAGE_PADDING = 4;

export function usePagePadding(): typeof PAGE_PADDING | typeof PHONE_PAGE_PADDING {
  return useAppShellMobile().isMobile ? PHONE_PAGE_PADDING : PAGE_PADDING;
}

// A page's h1. On a phone the top bar already shows the title, so the h1 stays
// in the DOM for assistive tech and is hidden visually; desktop shows it. A page
// whose title is not the top bar's (one saved app inside My Apps) sets `isShownOnPhone`.
export function PageTitle({ children, isShownOnPhone = false }: { children: ReactNode; isShownOnPhone?: boolean }): ReactElement {
  const heading = createElement(Heading, { level: 1, children });
  return useAppShellMobile().isMobile && !isShownOnPhone
    ? createElement(VisuallyHidden, { as: 'div', children: heading })
    : heading;
}

// A page's one-line subtitle. On a phone it is a single ellipsised line, and a
// bare `Text maxLines={1}` has no width bound, so it runs past the gutter. A
// fill item inside a row bounds it to the frame.
export function PageSubtitle({ children }: { children: ReactNode }): ReactElement {
  const { isMobile } = useAppShellMobile();
  const text = createElement(Text, { type: 'supporting', children, maxLines: isMobile ? 1 : undefined });
  return isMobile
    ? createElement(HStack, null, createElement(StackItem, { size: 'fill' }, text))
    : text;
}

// A page's add action. The same compact primary control on every page: on a
// phone a small icon-only button on the subtitle row, on desktop the labelled
// button. The label is the accessible name either way. `size` sets the desktop
// button only: a page passes 'sm' where its add button was small before, and
// otherwise keeps Astryx's default.
export function PageAction({ label, icon, size, onClick, isDisabled }: {
  label: string;
  icon: ReactNode;
  size?: 'sm';
  onClick: () => void;
  isDisabled?: boolean;
}): ReactElement {
  return useAppShellMobile().isMobile
    ? createElement(IconButton, { label, icon, variant: 'primary', size: 'sm', onClick, isDisabled })
    : createElement(Button, { label, icon, variant: 'primary', size, onClick, isDisabled });
}
