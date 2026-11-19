import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const RUNTIME_ROOTS = ['apps/ai/src', 'apps/api/src', 'apps/ui-v2/src'];
const VENDOR = /langfuse/i;
const SCANNED_ROOTS = ['apps/ai/evals', 'scripts', 'docs'];
// Files that may name the vendor, each with the reason.
const ALLOWED: Record<string, string> = {
  'apps/ai/tests/telemetry-vendor-neutral.test.ts': 'this guard names the vendor to scan for it',
  'apps/api/tests/platform/public-config.test.ts': 'asserts the vendor is absent from public config',
  'scripts/validate.mjs': 'the secret scanner keeps the old key name: stale .env files still hold it',
  'scripts/validate-secrets.test.mjs': 'tests the secret scanner against the old key name',
  'docs/observability.md': 'states once that pre-2026-10-08 history lives in the paused project',
};

function sourceFiles(root: string): string[] {
  const dir = join(REPO, root);
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.(ts|tsx|json|md)$/.test(path))
    .map((path) => join(dir, path));
}

const read = (path: string): string => readFileSync(path, 'utf8');
const rel = (path: string): string => relative(REPO, path).split(sep).join('/');
const dependencies = (manifest: string): string[] => {
  const parsed = JSON.parse(read(join(REPO, manifest))) as Record<string, Record<string, string> | undefined>;
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap((group) => Object.keys(parsed[group] ?? {}));
};

describe('vendor-neutral telemetry', () => {
  it('names no tracing vendor anywhere in runtime source, config names, comments or docs', () => {
    const offenders = RUNTIME_ROOTS.flatMap(sourceFiles).filter((path) => VENDOR.test(read(path))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('reads no platform-injected RAILWAY_ variable in the telemetry modules', () => {
    const telemetry = sourceFiles('apps/ai/src').filter((path) => /^telemetry[^/]*\.ts$/.test(basename(path)));
    expect(telemetry.length).toBeGreaterThan(0);
    expect(telemetry.filter((path) => read(path).includes('RAILWAY_')).map(rel)).toEqual([]);
  });

  it.each(['apps/ai/package.json', 'apps/api/package.json', 'apps/ui-v2/package.json'])('%s has no vendor SDK dependency', (manifest) => {
    expect(dependencies(manifest).filter((name) => VENDOR.test(name))).toEqual([]);
  });

  it('names no tracing vendor in evals, scripts, docs, package manifests or env examples', () => {
    const workspaces = readdirSync(join(REPO, 'apps')).map((app) => `apps/${app}/package.json`).filter((path) => existsSync(join(REPO, path)));
    const files = [
      ...SCANNED_ROOTS.flatMap(sourceFiles),
      ...['package.json', '.env.example', '.env.railway.example', '.railway/railway.ts', ...workspaces].map((path) => join(REPO, path)).filter((path) => existsSync(path)),
    ];
    const offenders = files.map(rel).filter((path) => !ALLOWED[path] && VENDOR.test(read(join(REPO, path))));
    expect(offenders).toEqual([]);
  });

  it('imports the browser RUM SDK only from the one web module', () => {
    const apps = readdirSync(join(REPO, 'apps')).map((app) => `apps/${app}/src`).filter((path) => existsSync(join(REPO, path)));
    const importers = apps.flatMap(sourceFiles).filter((path) => /\.tsx?$/.test(path) && /from\s+['"]@openobserve\//.test(read(path))).map(rel);
    expect(importers).toEqual(['apps/ui-v2/src/lib/observability/rum.ts']);
  });

  it('lists only allowed exceptions that still exist and still match', () => {
    for (const path of Object.keys(ALLOWED)) expect(VENDOR.test(read(join(REPO, path))), path).toBe(true);
  });
});
