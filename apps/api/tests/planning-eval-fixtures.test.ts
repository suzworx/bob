/**
 * Offline checks for the planning eval (#898): the fixtures meet the shape
 * planning.eval.ts needs -- enough cases, both a seed-empty and a
 * seed-non-empty variant, the busy-week prompt from the escaped defect, a
 * non-empty seed that resolves (resolvePlanningSeed, PLAN-SEED) to real
 * list_tasks/list_agenda output dated in the current week, and no PII.
 * Construct-only: no model call, no gateway key.
 */
import { describe, expect, it } from 'vitest';
import { loadFixtures, planningCaseSchema, resolvePlanningSeed, type PlanningCase } from '../../ai/evals/fixtures.ts';

describe('planning eval fixtures (offline)', () => {
  const fixtures: PlanningCase[] = loadFixtures('planning', planningCaseSchema);
  const seedNonEmpty = (f: PlanningCase): boolean => f.seed.tasks.length > 0 || f.seed.agenda.length > 0;

  it('has at least 6 fixtures, with both an empty and a non-empty seed', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
    expect(fixtures.some(seedNonEmpty)).toBe(true);
    expect(fixtures.some((f) => !seedNonEmpty(f))).toBe(true);
  });

  it('covers the planning request from #898, busy and empty', () => {
    const planMyWeek = fixtures.filter((f) => /plan my week/i.test(f.input));
    expect(planMyWeek.length).toBeGreaterThanOrEqual(2);
    expect(planMyWeek.some(seedNonEmpty)).toBe(true);
    expect(planMyWeek.some((f) => !seedNonEmpty(f))).toBe(true);
  });

  it('resolves a non-empty seed to real list_tasks/list_agenda output dated in the current week', () => {
    const now = new Date();
    const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const dayBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    for (const fixture of fixtures.filter(seedNonEmpty)) {
      const { tasks, agenda } = resolvePlanningSeed(fixture.seed, now);
      for (const task of tasks) {
        expect(task.id.length, fixture.input).toBeGreaterThan(0);
        if (task.due !== null) {
          const due = new Date(task.due);
          expect(due.getTime(), fixture.input).toBeGreaterThanOrEqual(dayBefore.getTime());
          expect(due.getTime(), fixture.input).toBeLessThan(weekAhead.getTime());
        }
      }
      for (const event of agenda) {
        expect(event.id.length, fixture.input).toBeGreaterThan(0);
        const start = new Date(event.startIso);
        expect(start.getTime(), fixture.input).toBeGreaterThanOrEqual(dayBefore.getTime());
        expect(start.getTime(), fixture.input).toBeLessThan(weekAhead.getTime());
        expect(new Date(event.endIso).getTime(), fixture.input).toBeGreaterThan(start.getTime());
      }
    }
  });

  it('contains no emails or phone-number-like digits', () => {
    const text = JSON.stringify(fixtures);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/);
    expect(text).not.toMatch(/\+?\d[\d\s-]{8,}\d/);
  });
});
