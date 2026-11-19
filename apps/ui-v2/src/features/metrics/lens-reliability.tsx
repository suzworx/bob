import type { ReactElement } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import { Grid } from '@astryxdesign/core/Grid';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { MetricsDocuments, MetricsSurface } from './metrics-api';
import {
  AXIS, CATEGORICAL, ChartCard, ChartTooltip, DASH, GRID_STROKE, StatTile, TableCard, bucketLabel, formatCount, formatMs, formatPercent, numberColumn, textColumn,
  type TableRow,
} from './metrics-cards';

type Docs = Pick<MetricsDocuments, 'usage' | 'voice' | 'platform'>;

const PRIVACY = 'Anonymous aggregates only. This page never shows a person, an account or what anyone said.';
const SURFACES: ReadonlyArray<{ key: MetricsSurface; label: string; color: string }> = [
  { key: 'device', label: 'Device', color: CATEGORICAL.blue },
  { key: 'web_voice', label: 'Web voice', color: CATEGORICAL.orange },
  { key: 'web_text', label: 'Web text', color: CATEGORICAL.teal },
];
const STAGES = [
  { key: 'input', label: 'Input' },
  { key: 'stt', label: 'STT' },
  { key: 'agent', label: 'Agent' },
  { key: 'tts', label: 'TTS' },
] as const;
const OUTCOME_COLUMNS = [
  textColumn('surface', 'Surface'),
  numberColumn('turns', 'Turns'),
  numberColumn('completed', 'Completed'),
  numberColumn('failed', 'Failed'),
  numberColumn('cancelled', 'Cancelled'),
  numberColumn('empty', 'Empty'),
  numberColumn('rate', 'Success rate'),
];
const FAILURE_COLUMNS = [textColumn('event_type', 'Event type'), numberColumn('count', 'Count')];

function formatDuration(seconds: number | null): string {
  if (seconds === null) return DASH;
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} d`;
}

function tiles({ usage, voice, platform }: Docs): Array<{ label: string; value: string }> {
  const device = voice.by_surface.device;
  const failed = Object.values(voice.failed_by_stage).reduce((sum, n) => sum + n, 0);
  return [
    { label: 'Device success rate', value: formatPercent(device.success_rate) },
    { label: 'Device p95 first audio', value: formatMs(device.latency_ms.first_audio.p95) },
    { label: 'Failed turns', value: formatCount(failed) },
    { label: 'Turns', value: formatCount(usage.turns_total) },
    { label: 'Outbox backlog', value: formatCount(platform.backlog) },
    { label: 'Oldest pending', value: formatDuration(platform.oldest_pending_seconds) },
  ];
}

function outcomeRows(voice: Docs['voice']): TableRow[] {
  return SURFACES.map(({ key, label }) => {
    const stats = voice.by_surface[key];
    return { id: key, surface: label, turns: stats.turns, ...stats.outcomes, rate: formatPercent(stats.success_rate) };
  });
}

function FirstAudioChart({ voice }: { voice: Docs['voice'] }): ReactElement {
  const label = bucketLabel(voice.window.bucket);
  const { device, web_voice: webVoice } = voice.by_surface;
  const summary = `Over the range, device p95 first audio is ${formatMs(device.latency_ms.first_audio.p95)} and web voice is ${formatMs(webVoice.latency_ms.first_audio.p95)}. A gap means no turns in that period.`;
  return (
    <ChartCard title="First audio p95 (ms)" summary={summary}>
      <LineChart data={voice.first_audio_p95_by_bucket}>
        <CartesianGrid vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="t" tickFormatter={label} {...AXIS} />
        <YAxis {...AXIS} />
        <Tooltip content={<ChartTooltip formatLabel={label} />} cursor={{ stroke: GRID_STROKE }} />
        <Legend />
        {SURFACES.slice(0, 2).map(({ key, label: name, color }) => (
          <Line key={key} dataKey={key} name={name} stroke={color} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        ))}
      </LineChart>
    </ChartCard>
  );
}

function TurnsChart({ usage }: { usage: Docs['usage'] }): ReactElement {
  const label = bucketLabel(usage.window.bucket);
  const totals = SURFACES.map(({ key, label: name }) => `${name.toLowerCase()} ${usage.turns_by_bucket.reduce((sum, bucket) => sum + bucket[key], 0)}`);
  return (
    <ChartCard title="Turns by surface" summary={`Turns in the range: ${totals.join(', ')}.`}>
      <BarChart data={usage.turns_by_bucket}>
        <CartesianGrid vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="t" tickFormatter={label} {...AXIS} />
        <YAxis allowDecimals={false} {...AXIS} />
        <Tooltip content={<ChartTooltip formatLabel={label} />} />
        <Legend />
        {SURFACES.map(({ key, label: name, color }) => (
          <Bar key={key} dataKey={key} name={name} stackId="turns" fill={color} isAnimationActive={false} />
        ))}
      </BarChart>
    </ChartCard>
  );
}

function FailuresChart({ voice }: { voice: Docs['voice'] }): ReactElement {
  const data = STAGES.map(({ key, label }) => ({ stage: label, failed: voice.failed_by_stage[key] }));
  const summary = `Failed turns by stage: ${data.map(({ stage, failed }) => `${stage} ${failed}`).join(', ')}.`;
  return (
    <ChartCard title="Failed turns by stage" summary={summary}>
      <BarChart data={data}>
        <CartesianGrid vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="stage" {...AXIS} />
        <YAxis allowDecimals={false} {...AXIS} />
        <Tooltip content={<ChartTooltip />} />
        <Bar dataKey="failed" name="Failed turns" fill={CATEGORICAL.red} isAnimationActive={false} />
      </BarChart>
    </ChartCard>
  );
}

export function LensReliability({ usage, voice, platform }: Docs): ReactElement {
  const failures = platform.failed_by_event_type.map(({ event_type: eventType, count }) => ({ id: eventType, event_type: eventType, count }));
  return (
    <VStack gap={6}>
      <Grid columns={{ minWidth: 190, repeat: 'fit' }} gap={4}>
        {tiles({ usage, voice, platform }).map((tile) => (
          <StatTile key={tile.label} {...tile} />
        ))}
      </Grid>
      <Grid columns={{ minWidth: 320, repeat: 'fit' }} gap={4}>
        <FirstAudioChart voice={voice} />
        <TurnsChart usage={usage} />
        <FailuresChart voice={voice} />
      </Grid>
      <TableCard title="Outcomes by surface" rows={outcomeRows(voice)} columns={OUTCOME_COLUMNS} />
      {failures.length > 0 && <TableCard title="Outbox failures by event type" rows={failures} columns={FAILURE_COLUMNS} />}
      <Text type="supporting">{PRIVACY}</Text>
    </VStack>
  );
}
