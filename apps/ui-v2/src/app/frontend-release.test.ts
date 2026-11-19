import { describe, expect, it } from 'vitest';
import { resolveFrontendRelease, frontendReleaseHtml } from '../../scripts/frontend-release';

describe('frontend release identity', () => {
  it('uses explicit release before Vercel and normalizes a full SHA', () => {
    expect(resolveFrontendRelease({ BOB_WEB_RELEASE: 'abcdef0'.padEnd(40, '1'), VERCEL_GIT_COMMIT_SHA: '1234567' })).toBe('abcdef0');
    expect(resolveFrontendRelease({ VERCEL_GIT_COMMIT_SHA: '1234567'.padEnd(40, '8') })).toBe('1234567');
  });
  it('preserves legacy builds and rejects invalid values', () => {
    expect(resolveFrontendRelease({})).toBeUndefined();
    for (const value of ['main', '<script>', 'ABC1234', '12345678']) expect(() => resolveFrontendRelease({ BOB_WEB_RELEASE: value })).toThrow('frontend release');
  });
  it('adds only the public identifier to HTML', () => {
    const html = '<html><head></head><body></body></html>';
    expect(frontendReleaseHtml(html, undefined)).toBe(html);
    expect(frontendReleaseHtml(html, 'abcdef0')).toContain('<meta name="bob-web-release" content="abcdef0">');
  });
});
