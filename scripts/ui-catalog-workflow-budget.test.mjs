import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The catalog job's contract: a step timeout fails (continue-on-error keeps the
// suite green), a job timeout cancels and turns main's check suite red. So
// every step is bounded and the job outlasts the sum of its steps.
const CLEANUP_HEADROOM_MIN = 3;
const CATALOG_STEP_CAP_MIN = 15;

const workflow = parse(readFileSync(new URL('../.github/workflows/ui-catalog.yml', import.meta.url), 'utf8'));

describe('ui-catalog workflow time budget', () => {
  it('runs only on schedule and manual dispatch', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('has the catalog and report jobs', () => {
    expect(Object.keys(workflow.jobs)).toEqual(expect.arrayContaining(['catalog', 'report']));
  });

  for (const [name, job] of Object.entries(workflow.jobs)) {
    describe(`job ${name}`, () => {
      it('bounds every step with a finite positive timeout', () => {
        for (const step of job.steps) {
          const label = step.name ?? step.uses ?? step.run;
          expect(Number.isFinite(step['timeout-minutes']), `step "${label}" is unbounded`).toBe(true);
          expect(step['timeout-minutes'], `step "${label}"`).toBeGreaterThan(0);
        }
      });

      it('leaves cleanup headroom beyond the sum of its step budgets', () => {
        const total = job.steps.reduce((sum, step) => sum + step['timeout-minutes'], 0);
        expect(Number.isFinite(job['timeout-minutes'])).toBe(true);
        expect(total + CLEANUP_HEADROOM_MIN).toBeLessThanOrEqual(job['timeout-minutes']);
      });
    });
  }

  it('keeps the 15 minute cap on the catalog step and continue-on-error on both jobs', () => {
    const step = workflow.jobs.catalog.steps.find((s) => s.name === 'UI catalog');
    expect(step['timeout-minutes']).toBe(CATALOG_STEP_CAP_MIN);
    expect(workflow.jobs.catalog['continue-on-error']).toBe(true);
    expect(workflow.jobs.report['continue-on-error']).toBe(true);
  });
});
