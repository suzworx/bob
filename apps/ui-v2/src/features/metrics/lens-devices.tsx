import type { ReactElement } from 'react';
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { Grid } from '@astryxdesign/core/Grid';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { MetricsDocuments } from './metrics-api';
import { AXIS, CATEGORICAL, ChartCard, ChartTooltip, GRID_STROKE, StatTile, TableCard, formatCount, numberColumn, textColumn } from './metrics-cards';

type Devices = MetricsDocuments['devices'];

const SMALL_GROUPS_NOTE = 'Groups with fewer than 3 devices are hidden, so no single device can be told apart.';
const FRESHNESS = [
  { key: 'under_1h', label: 'Under 1 hour' },
  { key: 'under_24h', label: '1 to 24 hours' },
  { key: 'under_7d', label: '1 to 7 days' },
  { key: 'older', label: 'Older' },
  { key: 'never', label: 'Never' },
] as const;
const PAIRING = [
  { key: 'requested', label: 'Requested' },
  { key: 'approved', label: 'Approved' },
  { key: 'expired', label: 'Expired' },
  { key: 'other', label: 'Other' },
] as const;
// The product name the Devices page shows (the API's deviceModelLabel): Bob's
// round Waveshare board is "Bob (Waveshare 1.85C)" whatever string it paired
// with. Rows that land on the same name are added together.
const BOB_MODEL = /waveshare/i;
const BOB_MODEL_LABEL = 'Bob (Waveshare 1.85C)';
function modelLabel(model: string): string {
  return BOB_MODEL.test(model) ? BOB_MODEL_LABEL : model;
}
function modelRows(rows: Devices['by_model']): Array<{ id: string; model: string; count: number }> {
  const totals = new Map<string, number>();
  for (const { model, count } of rows) totals.set(modelLabel(model), (totals.get(modelLabel(model)) ?? 0) + count);
  return [...totals].map(([model, count]) => ({ id: model, model, count }));
}
const FIRMWARE_COLUMNS = [textColumn('fw_version', 'Firmware version'), numberColumn('count', 'Devices')];
const MODEL_COLUMNS = [textColumn('model', 'Model'), numberColumn('count', 'Devices')];
const PAIRING_COLUMNS = [textColumn('stage', 'Pairing'), numberColumn('count', 'Requests')];

function FreshnessChart({ freshness }: { freshness: Devices['freshness'] }): ReactElement {
  const data = FRESHNESS.map(({ key, label }) => ({ age: label, devices: freshness[key] }));
  const summary = `Devices by time since last seen: ${data.map(({ age, devices }) => `${age.toLowerCase()} ${formatCount(devices)}`).join(', ')}.`;
  return (
    <ChartCard title="Last seen" summary={summary}>
      <BarChart data={data}>
        <CartesianGrid vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="age" {...AXIS} />
        <YAxis allowDecimals={false} {...AXIS} />
        <Tooltip content={<ChartTooltip />} />
        <Bar dataKey="devices" name="Devices" fill={CATEGORICAL.blue} isAnimationActive={false} />
      </BarChart>
    </ChartCard>
  );
}

export function LensDevices({ devices }: { devices: Devices }): ReactElement {
  const { paired, active_in_window: active, revoked } = devices.devices;
  const firmware = devices.by_fw_version.map((row) => ({ ...row, id: row.fw_version }));
  const models = modelRows(devices.by_model);
  const pairing = PAIRING.map(({ key, label }) => ({ id: key, stage: label, count: devices.pairing[key] }));
  return (
    <VStack gap={6}>
      <Grid columns={{ minWidth: 190, repeat: 'fit' }} gap={4}>
        <StatTile label="Paired" value={formatCount(paired)} />
        <StatTile label="Active in range" value={formatCount(active)} />
        <StatTile label="Revoked" value={formatCount(revoked)} />
      </Grid>
      <FreshnessChart freshness={devices.freshness} />
      <Grid columns={{ minWidth: 320, repeat: 'fit' }} gap={4}>
        <TableCard title="Firmware versions" rows={firmware} columns={FIRMWARE_COLUMNS} note={SMALL_GROUPS_NOTE} />
        <TableCard title="Models" rows={models} columns={MODEL_COLUMNS} note={SMALL_GROUPS_NOTE} />
        <TableCard title="Pairing funnel" rows={pairing} columns={PAIRING_COLUMNS} />
      </Grid>
      <Text type="supporting">Anonymous aggregates only: counts of devices, never a person or a device by name.</Text>
    </VStack>
  );
}
