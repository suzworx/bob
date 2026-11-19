import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_CATALOG } from '../../src/tools/catalog.ts';
function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? sources(resolve(folder, entry.name)) : entry.name.endsWith('.ts') ? [readFileSync(resolve(folder, entry.name), 'utf8')] : []);
}
describe('catalog coverage', () => {
  it('covers every Core SDK tool name, including runtime provider and routine maps', () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const code = [...sources(resolve(root, 'apps/ai/src')), ...sources(resolve(root, 'apps/api/src/integrations')), ...sources(resolve(root, 'apps/api/src/timeline'))].join('\n');
    const discovered = [...code.matchAll(/\b([a-zA-Z_]+):\s*(?:tool|routineTool)\(/g), ...code.matchAll(/tools\.([a-zA-Z_]+)\s*=\s*providerTool\(/g)].map((match) => match[1]);
    const ids = new Set(TOOL_CATALOG.map((entry) => entry.id));
    expect(discovered.filter((id) => !id || !ids.has(id))).toEqual([]);
    expect(ids.has('currentDateTime')).toBe(true);
    expect(ids.size).toBe(TOOL_CATALOG.length);
  });
});
