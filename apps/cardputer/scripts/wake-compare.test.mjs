import assert from 'node:assert/strict';
import { test } from 'vitest';
import { summarize } from './wake-compare.mjs';

// Synthetic observations test arithmetic only; these are not model detections.
const row = (extra = {}) => ({ model: 'Alexa', condition: 'synthetic/quiet/1m',
  speaker: 'synthetic-indian-english', provenance: 'synthetic', kind: 'positive',
  durationMs: 2000, detected: true, latencyMs: 200, ...extra });

test('reports observation counts and never invents missing measurements', () => {
  const [result] = summarize([row(), row({ detected: false, latencyMs: null }),
    row({ kind: 'negative', detected: undefined, latencyMs: undefined,
      durationMs: 1800000, falseActivations: 2 })]);
  assert.equal(result.positiveTrials, 2);
  assert.equal(result.misses, 1);
  assert.equal(result.missRate, 0.5);
  assert.equal(result.falseActivationsPerHour, 4);
  assert.deepEqual(result.detectionLatencyMs, { n: 1, mean: 200, p50: 200, p95: 200, max: 200 });
  assert.equal(result.inferenceUs, null);
  assert.equal(result.arenaUsedBytes, null);
});

test('rejects malformed and contradictory observations', () => {
  for (const input of [null, {}, [null], [row({ durationMs: 0 })],
    [row({ detected: 'yes' })], [row({ latencyMs: Infinity })],
    [row({ detected: false })], [row({ provenance: 'unknown' })],
    [row({ inferenceUs: Infinity })], [row({ unexpected: 1 })],
    [row({ kind: 'negative', falseActivations: -1 })]]) {
    assert.throws(() => summarize(input));
  }
});

test('retains valid detection latency before phrase end', () => {
  const [result] = summarize([row({ latencyMs: -100 })]);
  assert.deepEqual(result.detectionLatencyMs, { n: 1, mean: -100, p50: -100, p95: -100, max: -100 });
});

test('separates models, conditions, speakers and synthetic evidence', () => {
  assert.equal(summarize([row(), row({ model: 'Hey Bob' }),
    row({ provenance: 'consented' }), row({ speaker: 'speaker-2' }),
    row({ condition: 'synthetic/music/3m' })]).length, 5);
  const [result] = summarize([row({ latencyMs: null })]);
  assert.equal(result.falseActivationsPerHour, null);
  assert.equal(result.detectionLatencyMs, null);
  assert.deepEqual(summarize([]), []);
});
