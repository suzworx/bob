import { BRAND } from '@/lib/brand';
import type { ReactElement, ReactNode } from 'react';
import { Bell, CalendarDays, ListChecks, type LucideIcon } from 'lucide-react';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Layout, LayoutContent, LayoutFooter, LayoutHeader } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { Section } from '@astryxdesign/core/Section';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import {
  formatZoneTime,
  localDayKey,
  useAccountZone,
  useDayItems,
  type TodayItem,
} from '@/features/productivity/use-today';
import { PAGE_WIDTH, usePagePadding } from '../../app/page-width';
import { navigateTo } from '../../app/routes';

// Three short starters; a chip fills the composer, it never sends.
const PROMPT_CHIPS = [
  { label: 'Plan my week', prompt: 'Plan my week using my tasks and events.' },
  { label: "What's on today?", prompt: "What's on my plate today?" },
  { label: 'Remember something', prompt: 'Remember this for me:' },
] as const;

// How many of today's items the glance shows; the rest are one tap away on Today.
const GLANCE_ITEMS = 3;

const GLANCE_ICONS: Record<TodayItem['kind'], LucideIcon> = {
  task: ListChecks,
  event: CalendarDays,
  google: CalendarDays,
  reminder: Bell,
};

function glanceDescription(item: TodayItem, zone: string): string | undefined {
  if (item.kind === 'reminder') return formatZoneTime(item.at, zone);
  if (item.kind === 'event') return item.allDay || item.startAt === null ? 'All day' : formatZoneTime(item.startAt, zone);
  if (item.kind === 'task') return item.dateOnly ? 'Due today' : undefined;
  return undefined;
}

// A compact look at today from the calendar's own Today data. Loading shows
// skeleton rows; a failed load or an empty day shows nothing, so the landing
// never opens on an error about something the reader did not ask for.
function TodayGlance(): ReactElement | null {
  const { isMobile } = useAppShellMobile();
  const zone = useAccountZone();
  const day = localDayKey(Date.now(), zone);
  const { items, loading, error } = useDayItems(day, 0, zone);
  if (loading && items.length === 0) {
    return (
      <VStack gap={2} aria-label="Loading today">
        {[0, 1].map((index) => (
          <Skeleton key={index} index={index} height={40} />
        ))}
      </VStack>
    );
  }
  if (error || items.length === 0) return null;
  const shown = items.slice(0, GLANCE_ITEMS);
  const glance = (
    <List
      density="compact"
      header={
        <HStack hAlign="between" vAlign="center">
          <Text type="label">Today</Text>
          <Button label="See all" variant="ghost" size="sm" onClick={() => navigateTo('/today')} />
        </HStack>
      }
    >
      {shown.map((item) => (
        <ListItem
          key={`${item.kind}:${item.id}`}
          label={item.title}
          description={glanceDescription(item, zone)}
          startContent={<Icon icon={GLANCE_ICONS[item.kind]} size="sm" color="secondary" />}
          onClick={() => navigateTo('/today')}
        />
      ))}
    </List>
  );
  // Phone: the glance is a grouped card, as in the Today mockup.
  return isMobile ? <Section variant="muted">{glance}</Section> : glance;
}

// The empty-conversation surface (Astryx ai-chat-landing): a short greeting,
// the composer first, three prompt chips, then a compact glance at today.
export function ChatLanding({
  userName,
  composer,
  onPrompt,
  headerAction,
}: {
  userName: string | null;
  composer: ReactNode;
  onPrompt: (text: string) => void;
  headerAction?: ReactNode;
}): ReactElement {
  // On a phone the composer docks at the bottom, in thumb reach, as it does
  // once a conversation starts; the greeting, chips and glance sit above it.
  const { isMobile: isPhone } = useAppShellMobile();
  const padding = usePagePadding();
  const chips = (
    <HStack gap={2} wrap="wrap">
      {PROMPT_CHIPS.map((chip) => (
        <Token key={chip.label} label={chip.label} onClick={() => onPrompt(chip.prompt)} />
      ))}
    </HStack>
  );
  return (
    <Layout
      height="fill"
      contentWidth={PAGE_WIDTH}
      padding={padding}
      header={headerAction && !isPhone ? <LayoutHeader><HStack hAlign="end">{headerAction}</HStack></LayoutHeader> : undefined}
      footer={
        isPhone ? (
          <LayoutFooter label="Message composer">
            {composer}
          </LayoutFooter>
        ) : undefined
      }
      content={
        <LayoutContent>
          <VStack gap={isPhone ? 4 : 6} vAlign={isPhone ? 'start' : 'center'} minHeight="100%">
            <HStack gap={3} vAlign="center">
              <Avatar src="/brand/bob/bob-playful.webp" name={BRAND.assistantName} alt="Bob waving hello" size="lg" tooltip={false} />
              <VStack gap={0.5}>
                <HStack gap={2} vAlign="center">
                  <Text type="supporting" as="p">
                    {userName ? `Hi, ${userName}` : BRAND.copy.greeting}
                  </Text>
                  {userName === null && (
                    <Button
                      label="Add your name"
                      variant="ghost"
                      size="sm"
                      onClick={() => navigateTo('/settings#profile')}
                    />
                  )}
                </HStack>
                <Heading level={1}>Where should we start?</Heading>
              </VStack>
              {isPhone && headerAction}
            </HStack>
            {/* Inset so the composer is 800px wide, the width ChatLayout's
                spacious dock gives it once a conversation starts (see
                page-width.ts), so it keeps its edges when the first message lands. */}
            {isPhone ? (
              <>
                <TodayGlance />
                {chips}
              </>
            ) : (
              <VStack gap={4} paddingInline={3}>
                {composer}
                {chips}
                <TodayGlance />
              </VStack>
            )}
          </VStack>
        </LayoutContent>
      }
    />
  );
}
