import type { ReactElement } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from 'recharts';
import { Grid } from '@astryxdesign/core/Grid';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { MetricsDocuments } from './metrics-api';
import {
  AXIS, CATEGORICAL, ChartCard, ChartTooltip, GRID_STROKE, StatTile, TableCard, bucketLabel, formatCount, numberColumn, textColumn,
  type TableRow,
} from './metrics-cards';

type Features = MetricsDocuments['features'];

const CREATED = [
  { key: 'tasks', name: 'Tasks', color: CATEGORICAL.blue },
  { key: 'notes', name: 'Notes', color: CATEGORICAL.orange },
  { key: 'reminders', name: 'Reminders', color: CATEGORICAL.teal },
] as const;
const REMINDER_ROWS = [
  { key: 'created', label: 'Created' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'acknowledged', label: 'Acknowledged' },
  { key: 'snoozed', label: 'Snoozed' },
] as const;
const SPACE_ROWS = [
  { key: 'private', label: 'Private' },
  { key: 'pair', label: 'Pair' },
  { key: 'group', label: 'Group' },
] as const;
// Plain names for the notification types (the same words as the notification settings).
const NOTIFICATION_TYPE_LABELS: Readonly<Record<string, string>> = {
  mention: 'Mentions',
  assignment: 'Task assignments',
  task_update: 'Tasks you follow',
  reminder: 'Reminders',
  event_change: 'Event changes',
  invitation: 'Invitations',
  security: 'Security alerts',
};
const notificationTypeLabel = (type: string): string => NOTIFICATION_TYPE_LABELS[type] ?? 'Other';
const STEP_COLUMNS = [textColumn('step', 'Step'), numberColumn('count', 'Count')];
const NOTIFICATION_COLUMNS = [textColumn('step', 'Notifications'), numberColumn('count', 'Count')];
const SPACE_COLUMNS = [textColumn('step', 'Kind'), numberColumn('count', 'Spaces')];

const row = (id: string, step: string, count: number | null | undefined): TableRow => ({ id, step, count: formatCount(count) });

const sumCreated = (buckets: Features['created_by_bucket'], key: 'tasks' | 'notes' | 'reminders'): number =>
  buckets.reduce((sum, bucket) => sum + bucket[key], 0);

function tiles({ created_by_bucket: buckets, tasks, spaces, game_minutes: minutes }: Features): Array<{ label: string; value: string }> {
  return [
    { label: 'Tasks created', value: formatCount(sumCreated(buckets, 'tasks')) },
    { label: 'Tasks completed', value: formatCount(tasks.completed) },
    { label: 'Reminders created', value: formatCount(sumCreated(buckets, 'reminders')) },
    { label: 'Notes created', value: formatCount(sumCreated(buckets, 'notes')) },
    { label: 'Game minutes', value: formatCount(minutes) },
    { label: 'Spaces created', value: formatCount(spaces.created) },
  ];
}

function CreatedChart({ features }: { features: Features }): ReactElement {
  const label = bucketLabel(features.window.bucket);
  const totals = CREATED.map(({ key, name }) => `${name.toLowerCase()} ${sumCreated(features.created_by_bucket, key)}`);
  return (
    <ChartCard title="Created per bucket" summary={`Created in the range: ${totals.join(', ')}.`}>
      <BarChart data={features.created_by_bucket}>
        <CartesianGrid vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="t" tickFormatter={label} {...AXIS} />
        <YAxis allowDecimals={false} {...AXIS} />
        <Tooltip content={<ChartTooltip formatLabel={label} />} />
        <Legend />
        {CREATED.map(({ key, name, color }) => (
          <Bar key={key} dataKey={key} name={name} stackId="created" fill={color} isAnimationActive={false} />
        ))}
      </BarChart>
    </ChartCard>
  );
}

export function LensFeatures({ features }: { features: Features }): ReactElement {
  const { reminders, notifications, spaces } = features;
  const reminderRows = REMINDER_ROWS.map(({ key, label }) => row(key, label, reminders[key]));
  const notificationRows = [
    row('created', 'Created', notifications.created),
    row('read', 'Read', notifications.read),
    ...notifications.by_type.map(({ type, count }) => row(`type:${type}`, notificationTypeLabel(type), count)),
  ];
  const spaceRows = SPACE_ROWS.map(({ key, label }) => row(key, label, spaces.by_kind[key]));
  return (
    <VStack gap={6}>
      <Grid columns={{ minWidth: 190, repeat: 'fit' }} gap={4}>
        {tiles(features).map((tile) => (
          <StatTile key={tile.label} {...tile} />
        ))}
      </Grid>
      <Grid columns={{ minWidth: 320, repeat: 'fit' }} gap={4}>
        <CreatedChart features={features} />
      </Grid>
      <Grid columns={{ minWidth: 320, repeat: 'fit' }} gap={4}>
        <TableCard title="Reminder funnel" rows={reminderRows} columns={STEP_COLUMNS} />
        <TableCard title="Notifications" rows={notificationRows} columns={NOTIFICATION_COLUMNS} />
        <TableCard title="Spaces by kind" rows={spaceRows} columns={SPACE_COLUMNS} />
      </Grid>
      <Text type="supporting">Anonymous aggregates only: counts of things created, never what they say or who made them.</Text>
    </VStack>
  );
}
