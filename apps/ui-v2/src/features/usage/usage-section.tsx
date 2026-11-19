import { BRAND } from '@/lib/brand';
import { useState, type ReactElement } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Link } from '@astryxdesign/core/Link';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { navigateTo } from '@/app/routes';
import { useUsage } from './use-usage';
import type { UsageRange, UsageResponse, UsageWeekdayHour } from './usage-api';

const RANGES: { value: UsageRange; days: number; label: string }[] = [
  { value: '7d', days: 7, label: '7 days' },
  { value: '30d', days: 30, label: '30 days' },
  { value: '90d', days: 90, label: '90 days' },
];

const LOAD_ERROR = "Couldn't load your usage.";

// Plain words for where a message came from; the colours are the chart tokens.
const SURFACES = [
  { key: 'device', label: `${BRAND.name} device`, color: 'var(--color-data-categorical-blue)' },
  { key: 'web_voice', label: 'Voice on web', color: 'var(--color-data-categorical-orange)' },
  { key: 'web_text', label: 'Typed', color: 'var(--color-data-categorical-teal)' },
] as const;

const AXIS_TICK = { fontSize: 'var(--font-size-sm)', fill: 'var(--color-text-secondary)' };
const GRID_STROKE = 'var(--color-border)';

// by_day keys are calendar dates already in the account's zone; format them as dates, not instants.
const DAY_LABEL = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const HOUR_LABEL = new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: 'UTC' });

function dayLabel(day: string): string {
  return DAY_LABEL.format(new Date(`${day}T00:00:00Z`));
}

/** "8 pm" in the reader's locale, for an hour of the account's day. */
export function hourLabel(hour: number): string {
  return HOUR_LABEL.format(new Date(Date.UTC(2026, 0, 1, hour)));
}

/** The account-zone hour with the most messages, as a sentence; null with none. */
export function busiestHourSentence(cells: UsageWeekdayHour[]): string | null {
  const totals = new Map<number, number>();
  for (const cell of cells) totals.set(cell.hour, (totals.get(cell.hour) ?? 0) + cell.count);
  let best: { hour: number; count: number } | null = null;
  for (const [hour, count] of totals) {
    if (best === null || count > best.count) best = { hour, count };
  }
  return best === null ? null : `You talk to ${BRAND.assistantName} most around ${hourLabel(best.hour)}.`;
}

type TooltipEntry = { name?: string | number; value?: string | number };

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: readonly TooltipEntry[];
  label?: string | number;
}): ReactElement | null {
  if (!active || !payload?.length) return null;
  return (
    <Card padding={3}>
      <VStack gap={1}>
        <Text type="supporting">{typeof label === 'string' ? dayLabel(label) : label}</Text>
        {payload.map((entry) => (
          <Text key={entry.name} type="supporting">
            {entry.name}: {entry.value}
          </Text>
        ))}
      </VStack>
    </Card>
  );
}

function MessagesChart({ usage }: { usage: UsageResponse }): ReactElement {
  const { by_surface, by_day } = usage.turns;
  const summary = SURFACES.map(({ key, label }) => `${label} ${by_surface[key]}`).join(', ');
  return (
    <VStack gap={2}>
      <Text type="body" weight="semibold">
        Messages per day
      </Text>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={by_day} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid horizontal vertical={false} stroke={GRID_STROKE} />
          <XAxis dataKey="day" tickFormatter={dayLabel} tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={16} />
          <YAxis allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} width={30} />
          <Tooltip content={<ChartTooltip />} />
          <Legend iconType="square" />
          {SURFACES.map(({ key, label, color }) => (
            <Bar key={key} dataKey={key} name={label} stackId="messages" fill={color} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <Text type="supporting">{summary}</Text>
    </VStack>
  );
}

function UsageNumbers({ usage, days }: { usage: UsageResponse; days: number }): ReactElement {
  const busiest = busiestHourSentence(usage.turns.by_weekday_hour);
  return (
    <VStack gap={4}>
      <MetadataList>
        <MetadataListItem label={`Days you talked to ${BRAND.assistantName}`}>{`${usage.active_days} of ${days}`}</MetadataListItem>
        <MetadataListItem label="Messages">{String(usage.turns.total)}</MetadataListItem>
        <MetadataListItem label="New conversations">{String(usage.conversations_created)}</MetadataListItem>
        <MetadataListItem label="To-dos done">{String(usage.todos_done)}</MetadataListItem>
        {usage.memories !== null && (
          <MetadataListItem label="New memories">
            <Text>
              {`${usage.memories.new_in_range} of ${usage.memories.total} total · `}
              <Link
                href="/memory"
                onClick={(event) => {
                  event.preventDefault();
                  navigateTo('/memory');
                }}
              >
                Open Memory
              </Link>
            </Text>
          </MetadataListItem>
        )}
        {usage.game_minutes !== null && usage.game_minutes > 0 && (
          <MetadataListItem label="Game minutes">{String(usage.game_minutes)}</MetadataListItem>
        )}
      </MetadataList>
      {busiest !== null && <Text>{busiest}</Text>}
      <MessagesChart usage={usage} />
    </VStack>
  );
}

function UsageSkeleton(): ReactElement {
  return (
    <VStack gap={3} role="status" aria-label="Loading your usage">
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} index={index} height={20} />
      ))}
      <Skeleton index={4} height={220} />
    </VStack>
  );
}

/**
 * Settings > Usage: a few counts that match the pages they come from, and one
 * chart of every day in the range. Days and hours are the account's (its time
 * zone); counts only, never what was said. Device facts live on Devices.
 */
export function UsageSection(): ReactElement {
  const [range, setRange] = useState<UsageRange>('7d');
  const { state, usage, retry } = useUsage(range);
  const days = RANGES.find((option) => option.value === range)?.days ?? 7;
  const { isMobile } = useAppShellMobile();
  const rangeControl = (
    <SegmentedControl
      label="Range"
      value={range}
      size="sm"
      onChange={(value) => {
        const next = RANGES.find((option) => option.value === value);
        if (next) setRange(next.value);
      }}
    >
      {RANGES.map((option) => (
        <SegmentedControlItem key={option.value} value={option.value} label={option.label} />
      ))}
    </SegmentedControl>
  );

  return (
    <VStack gap={4} paddingBlock={isMobile ? 2 : 4}>
      {/* On a phone the selector sizes to its labels; a stretched column would fill the row. */}
      {isMobile ? <HStack>{rangeControl}</HStack> : rangeControl}
      {state === 'loading' && <UsageSkeleton />}
      {state === 'failed' && (
        <Banner status="error" title={LOAD_ERROR} endContent={<Button label="Try again" size="sm" onClick={retry} />} />
      )}
      {state === 'empty' && (
        <EmptyState
          title="Nothing here yet"
          description={`Talk to ${BRAND.assistantName} and your counts will show up here.`}
          headingLevel={3}
          isCompact
        />
      )}
      {state === 'ready' && usage !== null && <UsageNumbers usage={usage} days={days} />}
    </VStack>
  );
}
