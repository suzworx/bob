import type { ReactElement } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import { Grid } from '@astryxdesign/core/Grid';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { MetricsDocuments } from './metrics-api';
import {
  AXIS, CATEGORICAL, ChartCard, ChartTooltip, GRID_STROKE, StatTile, TableCard, bucketLabel, formatAverage, formatCount, formatMs, formatPercent,
  numberColumn, textColumn,
} from './metrics-cards';

type Ai = MetricsDocuments['ai'];

const TOP_TOOLS = 10;
const TOOL_AXIS_WIDTH = 140;
const TOKEN_LINES = [
  { key: 'input', name: 'Input', color: CATEGORICAL.blue },
  { key: 'output', name: 'Output', color: CATEGORICAL.orange },
  { key: 'cached_input', name: 'Cached input', color: CATEGORICAL.teal },
] as const;
const MODEL_COLUMNS = [
  textColumn('model', 'Model'),
  numberColumn('turns', 'Turns'),
  numberColumn('input', 'Input'),
  numberColumn('output', 'Output'),
  numberColumn('cached_input', 'Cached input'),
];
const INTENT_COLUMNS = [
  textColumn('intent', 'Intent'),
  numberColumn('turns', 'Turns'),
  numberColumn('rate', 'Success rate'),
  numberColumn('p95', 'p95 total'),
];

function tiles({ turns, cache_hit_ratio: cache, avg_steps: steps, avg_output_tokens: output, interrupted_rate: interrupted, tokens }: Ai): Array<{ label: string; value: string }> {
  return [
    { label: 'Turns', value: formatCount(turns) },
    { label: 'Cache hit', value: formatPercent(cache) },
    { label: 'Avg steps', value: formatAverage(steps) },
    { label: 'Avg output tokens', value: formatAverage(output) },
    { label: 'Interrupted rate', value: formatPercent(interrupted) },
    { label: 'Tokens in and out', value: `${formatCount(tokens.input)} / ${formatCount(tokens.output)}` },
  ];
}

function TokensChart({ ai }: { ai: Ai }): ReactElement {
  const label = bucketLabel(ai.window.bucket);
  const { input, output, cached_input: cached } = ai.tokens;
  const summary = `Over the range: ${formatCount(input)} input, ${formatCount(output)} output and ${formatCount(cached)} cached input tokens.`;
  return (
    <ChartCard title="Tokens per bucket" summary={summary}>
      <LineChart data={ai.tokens_by_bucket}>
        <CartesianGrid vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="t" tickFormatter={label} {...AXIS} />
        <YAxis allowDecimals={false} {...AXIS} />
        <Tooltip content={<ChartTooltip formatLabel={label} />} cursor={{ stroke: GRID_STROKE }} />
        <Legend />
        {TOKEN_LINES.map(({ key, name, color }) => (
          <Line key={key} dataKey={key} name={name} stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
        ))}
      </LineChart>
    </ChartCard>
  );
}

function ToolsChart({ tools }: { tools: Ai['tools'] }): ReactElement {
  const top = tools.slice().sort((a, b) => b.count - a.count).slice(0, TOP_TOOLS);
  const summary = top.length === 0 ? 'No tool calls in the range.' : `Most used tools: ${top.map(({ tool, count }) => `${tool} ${count}`).join(', ')}.`;
  return (
    <ChartCard title="Tools by count" summary={summary}>
      <BarChart data={top} layout="vertical">
        <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
        <XAxis type="number" allowDecimals={false} {...AXIS} />
        <YAxis type="category" dataKey="tool" width={TOOL_AXIS_WIDTH} {...AXIS} />
        <Tooltip content={<ChartTooltip />} />
        <Bar dataKey="count" name="Calls" fill={CATEGORICAL.purple} isAnimationActive={false} />
      </BarChart>
    </ChartCard>
  );
}

export function LensAi({ ai }: { ai: Ai }): ReactElement {
  const models = ai.by_model.map((row) => ({ ...row, id: row.model }));
  const intents = ai.intents.map(({ intent, turns, success_rate: rate, p95_total_ms: p95 }) => ({
    id: intent, intent, turns, rate: formatPercent(rate), p95: formatMs(p95),
  }));
  return (
    <VStack gap={6}>
      <Grid columns={{ minWidth: 190, repeat: 'fit' }} gap={4}>
        {tiles(ai).map((tile) => (
          <StatTile key={tile.label} {...tile} />
        ))}
      </Grid>
      <Grid columns={{ minWidth: 320, repeat: 'fit' }} gap={4}>
        <TokensChart ai={ai} />
        <ToolsChart tools={ai.tools} />
      </Grid>
      <TableCard title="Models" rows={models} columns={MODEL_COLUMNS} />
      <TableCard title="Intents" rows={intents} columns={INTENT_COLUMNS} />
      <Text type="supporting">Tokens, cache and usage only. Anonymous aggregates, never a person.</Text>
    </VStack>
  );
}
