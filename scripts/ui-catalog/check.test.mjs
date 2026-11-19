import { describe, expect, it } from 'vitest';
import { MIN_COMPONENTS, checkCatalog } from './check.mjs';

const registry = (n = MIN_COMPONENTS, used = true) => ({
  astryxVersion: '0.6.2',
  astryx: { Button: { files: used ? ['src/c0.tsx'] : [], jsx: used ? 1 : 0, names: used ? ['Button'] : [] } },
  bob: Array.from({ length: n }, (_, i) => ({
    name: `Comp${i}`, file: `src/c${i}.tsx`, line: 1, lines: 3, exported: true, astryx: [], local: [], renderedBy: [],
  })),
});
const mapping = { components: { Comp0: { rec: 'Button', kind: 'component' } }, pages: [{ id: 'home', files: ['src/c0.tsx'] }] };
const check = (over = {}) => checkCatalog({ committed: registry(), fresh: registry(), mapping, fileExists: () => true, ...over });

describe('checkCatalog', () => {
  it('passes a clean tree and counts components without a mapping entry', () => {
    expect(check()).toEqual({ errors: [], unmapped: MIN_COMPONENTS - 1 });
  });

  it('fails a stale committed registry with the regenerate hint', () => {
    const fresh = registry(MIN_COMPONENTS + 1);
    expect(check({ fresh }).errors).toEqual([expect.stringContaining('run npm run ui:catalog:registry')]);
  });

  it('fails an empty registry even when committed and fresh agree', () => {
    const empty = { astryxVersion: '0.6.2', astryx: {}, bob: [] };
    const { errors } = check({ committed: empty, fresh: empty });
    expect(errors.some((e) => e.includes('0 components'))).toBe(true);
    expect(errors.some((e) => e.includes('no Astryx module'))).toBe(true);
  });

  it('fails a registry with fewer components than the floor', () => {
    const small = registry(MIN_COMPONENTS - 1);
    expect(check({ committed: small, fresh: small }).errors).toHaveLength(2);
  });

  it('fails when no Astryx module is used', () => {
    const unused = registry(MIN_COMPONENTS, false);
    expect(check({ committed: unused, fresh: unused }).errors).toEqual([
      expect.stringContaining('no Astryx module'), expect.stringContaining('no Astryx module'),
    ]);
  });

  it('fails a mapping component that is not in the registry', () => {
    const errors = check({ mapping: { ...mapping, components: { Nope: {} } } }).errors;
    expect(errors).toEqual([expect.stringContaining('mapping.components.Nope')]);
  });

  it('fails a mapping page file that does not exist', () => {
    expect(check({ fileExists: () => false }).errors).toEqual([expect.stringContaining('apps/ui-v2/src/c0.tsx')]);
  });
});
