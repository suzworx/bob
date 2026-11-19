import { describe, expect, it } from 'vitest';
import { buildRegistry, parseSource, serialize } from './registry.mjs';

const sources = {
  'src/features/card.tsx': `
import { Button } from '@astryxdesign/core/Button';
import { Child } from './child';
export function Card() {
  return <Button><Child /></Button>;
}
function Dead() {
  return <div>unused</div>;
}
`,
  'src/features/child.tsx': `
export const Child = () => <span>child</span>;
`,
  'src/app/page.tsx': `
import { Card } from '@/features/card';
export default function Page() {
  return <Card />;
}
`,
};
const opts = { astryxModules: ['Button', 'Dialog'], astryxVersion: '0.6.2' };
const byName = (reg) => Object.fromEntries(reg.bob.map((c) => [c.name, c]));

describe('parseSource', () => {
  it('finds top-level components, their tags and whether they are exported', () => {
    const { comps } = parseSource('src/features/card.tsx', sources['src/features/card.tsx']);
    expect(comps.map((c) => [c.name, c.exported, c.tags])).toEqual([
      ['Card', true, ['Button', 'Child']],
      ['Dead', false, []],
    ]);
  });
});

describe('buildRegistry', () => {
  const reg = buildRegistry(sources, opts);
  const c = byName(reg);

  it('records the Astryx modules and local children a component renders', () => {
    expect(c.Card).toMatchObject({ file: 'src/features/card.tsx', line: 4, astryx: ['Button'], local: ['Child'] });
  });

  it('records who renders whom through relative and @/ imports', () => {
    expect(c.Child.renderedBy).toEqual(['Card (src/features/card.tsx)']);
    expect(c.Card.renderedBy).toEqual(['Page (src/app/page.tsx)']);
  });

  it('leaves a dead component with an empty renderedBy', () => {
    expect(c.Dead.renderedBy).toEqual([]);
  });

  it('lists every installed Astryx module and marks only the used ones', () => {
    expect(reg.astryx).toEqual({
      Button: { files: ['src/features/card.tsx'], jsx: 1, names: ['Button'] },
      Dialog: { files: [], jsx: 0, names: [] },
    });
  });

  it('is byte-identical across builds and independent of input order', () => {
    const reversed = Object.fromEntries(Object.entries(sources).reverse());
    const modules = { ...opts, astryxModules: [...opts.astryxModules].reverse() };
    expect(serialize(buildRegistry(reversed, modules))).toBe(serialize(reg));
    expect(serialize(reg)).not.toMatch(/generatedAt/);
  });
});
