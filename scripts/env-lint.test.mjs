import { describe, expect, it } from 'vitest';
import { lintEnvText } from './env-lint.mjs';

describe('lintEnvText', () => {
  it('flags the OPEN_ROUTER_API_KEY misspelling when the real key is absent', () => {
    const findings = lintEnvText('OPEN_ROUTER_API_KEY=sk-secret\n');
    expect(findings.some((f) => f.code === 'typo_key' && f.level === 'error')).toBe(true);
  });

  it('downgrades to a warning when both spellings exist', () => {
    const findings = lintEnvText('OPEN_ROUTER_API_KEY=x\nAI_GATEWAY_API_KEY=y\n');
    expect(findings.some((f) => f.code === 'redundant_typo' && f.level === 'warn')).toBe(true);
    expect(findings.some((f) => f.code === 'typo_key')).toBe(false);
  });

  it('accepts a correctly named key with no provider finding', () => {
    const findings = lintEnvText('AI_GATEWAY_API_KEY=y\n');
    expect(findings.some((f) => f.code === 'no_provider')).toBe(false);
  });

  it('suppresses the provider warning under BOB_SYSTEM_TEST=1', () => {
    const findings = lintEnvText('BOB_SYSTEM_TEST=1\n');
    expect(findings.some((f) => f.code === 'no_provider')).toBe(false);
  });

  it('warns when the browser token is missing', () => {
    const findings = lintEnvText('AI_GATEWAY_API_KEY=y\n');
    expect(findings.some((f) => f.code === 'weak_token' && f.level === 'warn')).toBe(true);
  });

  it('warns on a too-short browser token but never echoes values', () => {
    const findings = lintEnvText(`BOB_WEB_TOKEN=abc\n`);
    const weak = findings.find((f) => f.code === 'weak_token');
    expect(weak).toBeTruthy();
    expect(weak.message).not.toContain('abc');
  });

  it('passes a healthy .env with no findings', () => {
    const token = 't'.repeat(32);
    const findings = lintEnvText(`AI_GATEWAY_API_KEY=y\nBOB_WEB_TOKEN=${token}\n`);
    expect(findings).toEqual([]);
  });
});
