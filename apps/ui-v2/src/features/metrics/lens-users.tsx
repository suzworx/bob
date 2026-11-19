import type { ReactElement } from 'react';
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { Grid } from '@astryxdesign/core/Grid';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { MetricsDocuments } from './metrics-api';
import { AXIS, CATEGORICAL, ChartCard, ChartTooltip, GRID_STROKE, StatTile, bucketLabel, formatCount } from './metrics-cards';

type Users = MetricsDocuments['users'];
const activeCount = (count: number | null): string => count === null ? 'fewer than 3' : formatCount(count);

// Account and waitlist totals are on the Admin page's People and Waitlist tabs,
// so they are not repeated here.
export function LensUsers({ users }: { users: Users }): ReactElement {
  const { active_users: active } = users;
  const label = bucketLabel(users.window.bucket);
  return (
    <VStack gap={6}>
      <Grid columns={{ minWidth: 190, repeat: 'fit' }} gap={4}>
        <StatTile label="New accounts" value={formatCount(users.signups)} hint="Created in the selected range" />
        <StatTile label="Active in selected range" value={activeCount(active.in_window)} hint="People who sent a message" />
        <StatTile label="Active in last 24 hours" value={activeCount(active.day)} />
        <StatTile label="Active in last 7 days" value={activeCount(active.week)} />
        <StatTile label="Active in last 30 days" value={activeCount(active.month)} />
        <StatTile label="People who have sent a message" value={activeCount(users.activated_users)} hint="Based on retained messages through the end of the range" />
      </Grid>
      <Text type="supporting">Activity means sending a message, not signing in. Counts below 3 are hidden, including zero. Deleted messages are excluded.</Text>
      <ChartCard title="Account growth" summary={`${formatCount(users.signups)} new accounts in the selected range.`}>
        <BarChart data={users.signups_by_bucket}>
          <CartesianGrid vertical={false} stroke={GRID_STROKE} />
          <XAxis dataKey="t" tickFormatter={label} {...AXIS} />
          <YAxis allowDecimals={false} {...AXIS} />
          <Tooltip content={<ChartTooltip formatLabel={label} />} />
          <Bar dataKey="count" name="New accounts" fill={CATEGORICAL.blue} isAnimationActive={false} />
        </BarChart>
      </ChartCard>
    </VStack>
  );
}
