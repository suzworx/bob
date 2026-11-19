import type { ReactElement } from 'react';
import { ResponsiveContainer } from 'recharts';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Table, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { MetricsWindow } from './metrics-api';

const CHART_HEIGHT = 240;

export const DASH = '—';
export const AXIS = {
  tick: { fontSize: 'var(--font-size-sm)', fill: 'var(--color-text-secondary)' },
  axisLine: false,
  tickLine: false,
} as const;
export const GRID_STROKE = 'var(--color-border)';
export const CATEGORICAL = {
  blue: 'var(--color-data-categorical-blue)',
  orange: 'var(--color-data-categorical-orange)',
  teal: 'var(--color-data-categorical-teal)',
  purple: 'var(--color-data-categorical-purple)',
  red: 'var(--color-data-categorical-red)',
} as const;

const DAY_FORMAT = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
const HOUR_FORMAT = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric' });
const COUNT_FORMAT = new Intl.NumberFormat('en');

export function formatPercent(rate: number | null): string {
  return rate === null ? DASH : `${Math.round(rate * 1000) / 10}%`;
}

export function formatMs(ms: number | null): string {
  if (ms === null) return DASH;
  return ms > 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

export function formatCount(count: number | null | undefined): string {
  return count === null || count === undefined ? DASH : COUNT_FORMAT.format(count);
}

export function formatAverage(value: number | null): string {
  return value === null ? DASH : String(Math.round(value * 10) / 10);
}

export function bucketLabel(bucket: MetricsWindow['bucket']): (iso: string) => string {
  const format = bucket === 'hour' ? HOUR_FORMAT : DAY_FORMAT;
  return (iso) => format.format(new Date(iso));
}

export type TableRow = Record<string, unknown> & { id: string };
export const textColumn = (key: string, header: string): TableColumn<TableRow> => ({ key, header, width: proportional(2) });
export const numberColumn = (key: string, header: string): TableColumn<TableRow> => ({ key, header, width: proportional(1), align: 'end' });

export function TableCard({ title, rows, columns, note }: { title: string; rows: TableRow[]; columns: TableColumn<TableRow>[]; note?: string }): ReactElement {
  return (
    <Card>
      <VStack gap={3}>
        <Heading level={2}>{title}</Heading>
        <Table<TableRow> data={rows} columns={columns} idKey="id" density="compact" dividers="rows" />
        {note !== undefined && <Text type="supporting">{note}</Text>}
      </VStack>
    </Card>
  );
}

export function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }): ReactElement {
  return (
    <Card>
      <VStack gap={1}>
        <Text type="supporting">{label}</Text>
        <Heading level={3}>{value}</Heading>
        {hint !== undefined && <Text type="supporting">{hint}</Text>}
      </VStack>
    </Card>
  );
}

// `summary` states the same numbers as the chart, in words.
export function ChartCard({ title, summary, children }: { title: string; summary: string; children: ReactElement }): ReactElement {
  return (
    <Card>
      <VStack gap={3}>
        <Heading level={2}>{title}</Heading>
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          {children}
        </ResponsiveContainer>
        <Text type="supporting">{summary}</Text>
      </VStack>
    </Card>
  );
}

type TooltipEntry = { name?: string | number; value?: number | string | null };

// Recharts hands its tooltip content the hovered point; this shows it as an Astryx Card.
export function ChartTooltip({
  active,
  payload,
  label,
  formatLabel = String,
}: {
  active?: boolean;
  payload?: ReadonlyArray<TooltipEntry>;
  label?: string | number;
  formatLabel?: (label: string) => string;
}): ReactElement | null {
  if (!active || !payload?.length) return null;
  return (
    <Card padding={3}>
      <VStack gap={1}>
        {label !== undefined && <Text type="supporting">{formatLabel(String(label))}</Text>}
        {payload.map((entry) => (
          <Text key={String(entry.name)} type="supporting">
            {String(entry.name)}: {entry.value ?? '—'}
          </Text>
        ))}
      </VStack>
    </Card>
  );
}
