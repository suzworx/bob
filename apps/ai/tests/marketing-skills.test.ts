import { describe, expect, it } from 'vitest';
import { marketingPhases, marketingPhaseSkills, type MarketingPhase } from '../src/marketing-skills.ts';

/** Pinned upstream revisions and licences (docs/research/bob-marketing-evidence.md). */
const pinned = {
  '88c79f6528a9347420e57ceb1fff9a60de651768': 'MIT',
  '2574e29377c7173d0cecffef29a6ecbd7f8ccb5d': 'Apache-2.0',
  '1b7dc0773fa364c35fbd6fd19f3a155446c054b5': 'MIT',
  'd4aed043656df19661e7fe002a9ce6a3f8fdb97b': 'MIT',
} as const;
/** Upper bounds: at most 120 lines and 5000 characters per phase text (about 1,250 tokens). */
const MAX_LINES = 120;
const MAX_CHARS = 5000;
const expectedPhases = ['strategy', 'positioning', 'planning', 'creative', 'review', 'measurement'];

describe('Marketing phase skills', () => {
  it('lists the six phases in fixed order', () => {
    expect([...marketingPhases]).toEqual(expectedPhases);
  });

  it.each(expectedPhases)('%s has a stable id, semver version and pinned upstream provenance', (phase) => {
    const skill = marketingPhaseSkills[phase as MarketingPhase];
    expect(skill.id).toBe(`bob-marketing-${phase}`);
    expect(skill.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(skill.sources.length).toBeGreaterThan(0);
    for (const source of skill.sources) {
      expect(pinned[source.revision as keyof typeof pinned]).toBe(source.license);
      expect(source.name.length).toBeGreaterThan(0);
    }
  });

  it.each(expectedPhases)('%s stays small and narrow', (phase) => {
    const { text } = marketingPhaseSkills[phase as MarketingPhase];
    expect(text.split('\n').length).toBeLessThanOrEqual(MAX_LINES);
    expect(text.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(text.length).toBeGreaterThan(200);
  });

  it.each(expectedPhases)('%s carries no statistics, benchmarks or growth promises', (phase) => {
    const { text } = marketingPhaseSkills[phase as MarketingPhase];
    expect(text).not.toMatch(/\d+(\.\d+)?\s*%/u);
    expect(text).not.toMatch(/best time to post|guarantee|go viral|going viral/iu);
  });

  it('states the phase behaviour that the evaluation depends on', () => {
    const texts = Object.fromEntries(expectedPhases.map((phase) => [phase, marketingPhaseSkills[phase as MarketingPhase].text.toLowerCase()]));
    expect(texts.strategy).toMatch(/audience hypothes/u);
    expect(texts.positioning).toMatch(/pillar/u);
    expect(texts.planning).toMatch(/calendar/u);
    expect(texts.creative).toMatch(/alt text/u);
    expect(texts.review).toMatch(/\bhold\b/u);
    expect(texts.measurement).toMatch(/notmeasured|not measured/u);
  });

  it('plans a week as one story told in beats, saved in one write', () => {
    const { text } = marketingPhaseSkills.planning;
    expect(text).toMatch(/one story/iu);
    expect(text).toMatch(/\bbeat\b/iu);
    expect(text).toMatch(/save_week_plan/u);
    expect(text).toMatch(/at most seven/iu);
    expect(text).toMatch(/never ask[^.]*Bob/iu);
    expect(text).toMatch(/pillar/iu);
  });

  it('carries the same concrete situation through the brief and every post', () => {
    const { text } = marketingPhaseSkills.planning;
    expect(text).toMatch(/same[^.]*situation[^.]*every post/iu);
    expect(text).toMatch(/fictional[^.]*illustration/iu);
    expect(text).toMatch(/never[^.]*testimonial/iu);
  });

  it.each(['planning', 'creative'] as const)('%s describes the actual original-art composition, not an invented scene', (phase) => {
    const { text } = marketingPhaseSkills[phase];
    expect(text).toMatch(/alt text[^.]*unmodified[^.]*asset[^.]*caption/iu);
    expect(text).toMatch(/never invent[^.]*props[^.]*poses/iu);
    expect(text).toMatch(/claimIds metadata/iu);
    expect(text).toMatch(/post body[^.]*internal citations/iu);
  });

  it.each(['planning', 'creative'] as const)('%s writes like a person, from pack facts only', (phase) => {
    const { text } = marketingPhaseSkills[phase];
    expect(text).toMatch(/first line/iu);
    expect(text).toMatch(/contrast/iu);
    expect(text).toMatch(/bait/iu);
    expect(text).toMatch(/testimonial/iu);
    expect(text).toMatch(/claim ID/iu);
    expect(text).toMatch(/warm/iu);
    expect(text).not.toMatch(/\d+\s*(x|times)?\s*(a|per)\s*(day|week)/iu);
  });

  it('adapts its sources in its own words', () => {
    const { planning, creative } = marketingPhaseSkills;
    for (const copied of ["It's not X", 'Let that sink in', 'Say goodbye to', 'Unpopular opinion', 'Read that again', 'Reserve 20']) {
      expect(planning.text + creative.text).not.toContain(copied);
    }
  });

  it('gives every phase its own text', () => {
    const texts = new Set(expectedPhases.map((phase) => marketingPhaseSkills[phase as MarketingPhase].text));
    expect(texts.size).toBe(expectedPhases.length);
  });

  it('measurement never treats UTM labels as a metric source', () => {
    const { text } = marketingPhaseSkills.measurement;
    expect(text).not.toContain('such as the UTM map');
    expect(text).toMatch(/UTM labels[^.]*attribution metadata/u);
    expect(text).toMatch(/Counts, visits and conversions come only from actual snapshots or the collector/u);
    expect(text).toMatch(/missing metrics stay unavailable/iu);
  });
});
