// Aggregates annotated observations only. Does not run inference or read audio.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fields = new Set(['model', 'condition', 'speaker', 'provenance', 'kind',
  'durationMs', 'detected', 'latencyMs', 'falseActivations', 'inferenceUs',
  'arenaUsedBytes', 'heapFreeBytes']);
function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}
function validateRow(row) {
  requireValue(row !== null && typeof row === 'object' && !Array.isArray(row), 'Expected observation object');
  requireValue(Object.keys(row).every((key) => fields.has(key)), 'Unknown observation field');
  for (const key of ['model', 'condition', 'speaker']) {
    requireValue(typeof row[key] === 'string' && row[key].trim().length > 0, `Missing ${key}`);
  }
  requireValue(['consented', 'synthetic'].includes(row.provenance), 'Explicit provenance required');
  requireValue(['positive', 'negative'].includes(row.kind), 'Expected positive or negative kind');
  requireValue(Number.isFinite(row.durationMs) && row.durationMs > 0, 'durationMs must be positive');
  for (const key of ['latencyMs', 'inferenceUs', 'arenaUsedBytes', 'heapFreeBytes']) {
    if (row[key] !== undefined && row[key] !== null) {
      requireValue(Number.isFinite(row[key]) && (key === 'latencyMs' || row[key] >= 0),
        `${key} must be finite (and nonnegative except signed latency)`);
    }
  }
  validateOutcome(row);
}
function validateOutcome(row) {
  if (row.kind === 'positive') {
    requireValue(typeof row.detected === 'boolean', 'Positive trials need detected boolean');
    requireValue(row.falseActivations === undefined, 'Positive trials cannot count negative activations');
    requireValue(row.latencyMs === undefined || row.latencyMs === null ||
      (row.detected && row.latencyMs <= row.durationMs), 'Latency contradicts outcome/duration');
    return;
  }
  requireValue(Number.isSafeInteger(row.falseActivations) && row.falseActivations >= 0,
    'Negative segments need a nonnegative falseActivations integer');
  requireValue(row.detected === undefined && row.latencyMs === undefined,
    'Negative segments cannot contain positive detection fields');
}

function distribution(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return { n: sorted.length, mean: sorted.reduce((sum, n) => sum + n, 0) / sorted.length,
    p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) };
}

export function summarize(rows) {
  requireValue(Array.isArray(rows), 'Expected JSON array of observations');
  rows.forEach(validateRow);
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.model, row.condition, row.speaker, row.provenance]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    const positives = group.filter((row) => row.kind === 'positive');
    const negatives = group.filter((row) => row.kind === 'negative');
    const negativeMs = negatives.reduce((sum, row) => sum + row.durationMs, 0);
    const falseActivations = negatives.reduce((sum, row) => sum + row.falseActivations, 0);
    const misses = positives.filter((row) => !row.detected).length;
    const measure = (key) => distribution(group.flatMap((row) =>
      row[key] === undefined || row[key] === null ? [] : [row[key]]));
    return { model: first.model, condition: first.condition, speaker: first.speaker,
      provenance: first.provenance, positiveTrials: positives.length, misses,
      missRate: positives.length ? misses / positives.length : null,
      negativeSegments: negatives.length, negativeHours: negativeMs / 3600000,
      falseActivations: negatives.length ? falseActivations : null,
      falseActivationsPerHour: negativeMs ? falseActivations * 3600000 / negativeMs : null,
      detectionLatencyMs: measure('latencyMs'), inferenceUs: measure('inferenceUs'),
      arenaUsedBytes: measure('arenaUsedBytes'), heapFreeBytes: measure('heapFreeBytes') };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node wake-compare.mjs observations.json');
    console.log(JSON.stringify(summarize(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
