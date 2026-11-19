import { useId, type ReactElement, type ReactNode } from 'react';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { List } from '@astryxdesign/core/List';
import { Section } from '@astryxdesign/core/Section';
import { StackItem } from '@astryxdesign/core/Stack';
import { VStack } from '@astryxdesign/core/VStack';
import { Text } from '@astryxdesign/core/Text';

// The one list pattern for every list page: a small bold label with an optional
// right-hand count or link, then the compact rows. On a phone the rows sit in a
// rounded muted card (the bob-mobile-v4 mockups); desktop keeps the plain list
// it always had, so desktop looks the same as before.
export function GroupedList({ label, count, action, children }: {
  label: ReactNode;
  count?: string | number;
  action?: ReactNode;
  children: ReactNode;
}): ReactElement {
  const { isMobile } = useAppShellMobile();
  const labelId = useId();
  const end = (
    <>
      {count !== undefined && <Text type="supporting">{String(count)}</Text>}
      {action}
    </>
  );
  if (!isMobile) {
    const header = (
      <HStack gap={2} vAlign="center" paddingInline={2}>
        <Heading level={2}>{label}</Heading>
        {end}
      </HStack>
    );
    return <List density="compact" hasDividers header={header}>{children}</List>;
  }
  // Phone: the label sits above its own card, small and bold, like the mockups.
  return (
    <VStack gap={2} paddingBlockEnd={6}>
      {/* A Section like the card, so the label escapes the page gutter exactly as the card
          does, wherever the list sits; 16px in lines the text up with the card's content. */}
      <Section variant="transparent" padding={0} paddingInline={4}>
        <HStack gap={2} vAlign="center">
          <StackItem size="fill"><Heading id={labelId} level={6} accessibilityLevel={2} weight="semibold">{label}</Heading></StackItem>
          {end}
        </HStack>
      </Section>
      <Section variant="muted" padding={2}>
        <List density="compact" hasDividers aria-labelledby={labelId}>{children}</List>
      </Section>
    </VStack>
  );
}
