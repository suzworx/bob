import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MARKER, diffAgents, writeAgents, renderAgent, renderAll, renderRole } from './gen-agents.mjs';

const SCRIPT = resolve(import.meta.dirname, 'gen-agents.mjs');
const CONTRACT = '.claude/skills/bob-dev/references/agent-contract.md';
const domain = (name, owns, extra = {}) => ({
  name, summary: `The ${name} domain.`, owns, tests: [`apps/api/tests/${name}.test.ts`], skills: ['bob-dev', 'tdd'],
  mcp: [], docs: ['docs/architecture.md'], gates: ['npm run test:unit'], ...extra,
});
const frontMatter = (text) => parse(/^---\n([\s\S]*?)\n---\n/.exec(text)[1]);
const body = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, '');
const ROLE = '---\nname: bob-tester\ndescription: Writes tests.\nmodel: claude-opus-5-5\nskills: [tdd]\n---\n\n# bob-tester\n\nWrite the red test.\n';

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

describe('renderAgent', () => {
  const memory = domain('memory', ['apps/api/src/modules/memory/**', 'apps/ui-v2/src/features/memory/**'], { mcp: ['playwright'] });

  it('starts the body with the marker and has valid front matter with the 5 keys', () => {
    const text = renderAgent(memory);
    expect(text).not.toContain('\r');
    expect(body(text).startsWith(`${MARKER}\n`)).toBe(true);
    const meta = frontMatter(text);
    expect(Object.keys(meta)).toEqual(['name', 'description', 'model', 'skills', 'mcpServers']);
    expect(meta).toMatchObject({ name: 'bob-memory', model: 'inherit', skills: ['bob-dev', 'tdd'], mcpServers: ['playwright'] });
    expect(meta.description).toContain('Owns apps/api/src/modules/memory/**');
    expect(meta.description).toContain('shared seams go to bob-platform');
    expect(meta.description.length).toBeLessThan(1024);
  });

  it('omits mcpServers when the domain has no mcp', () => {
    expect(frontMatter(renderAgent(domain('games', ['apps/ai/src/games/**'])))).not.toHaveProperty('mcpServers');
  });

  it('links the contract and lists owns, tests, docs and gates', () => {
    const text = renderAgent(memory);
    expect(text).toMatch(new RegExp(`## Contract\\n\\n.*${CONTRACT.replaceAll('.', '\\.')}.*follow it exactly`));
    for (const line of ['apps/api/src/modules/memory/**', 'apps/api/tests/memory.test.ts', 'docs/architecture.md', 'npm run test:unit']) {
      expect(text).toContain(line);
    }
  });

  it('renders a UI: Astryx only section right after You own for an apps/ui-v2 owner', () => {
    const text = renderAgent(memory);
    const ui = text.indexOf('## UI: Astryx only');
    expect(ui).toBeGreaterThan(text.indexOf('## You own'));
    expect(ui).toBeLessThan(text.indexOf('## Your tests'));
    const section = text.slice(ui, text.indexOf('## Your tests'));
    for (const command of ['npm run astryx -- template --list', 'npm run astryx -- template <name> --skeleton', 'npm run astryx -- component <Name>']) {
      expect(section).toContain(command);
    }
    expect(section).toMatch(/EVIDENCE.*astryx commands.*screenshot/s);
    expect(section).toContain('a grep for CSS is not evidence');
    for (const catalog of ['docs/ui-v2/ux-catalog/', 'mapping.json', 'npm run ui:catalog:registry', 'npm run check:ui-catalog', 'npm run ui:catalog']) {
      expect(section).toContain(catalog);
    }
    expect(text.slice(text.indexOf('## Read first'), text.indexOf('## Gates'))).toContain('apps/ui-v2/CLAUDE.md');
  });

  it('renders no Astryx section for a domain outside apps/ui-v2', () => {
    const text = renderAgent(domain('games', ['apps/ai/src/games/**']));
    expect(text).not.toContain('## UI: Astryx only');
    expect(text).not.toContain('npm run astryx');
  });

  it('adds the shared-hardware line only for an apps/cardputer owner', () => {
    expect(renderAgent(domain('cardputer-ui', ['apps/cardputer/src/display*']))).toContain('shared-hardware.md');
    expect(renderAgent(memory)).not.toContain('shared-hardware.md');
  });
});

describe('renderRole', () => {
  it('inserts the marker as the first body line and appends the contract', () => {
    const text = renderRole(ROLE);
    expect(frontMatter(text)).toMatchObject({ name: 'bob-tester', model: 'inherit' });
    expect(body(text).startsWith(`${MARKER}\n`)).toBe(true);
    expect(text).toContain('Write the red test.');
    expect(text).toMatch(/## Contract\n\n.*agent-contract\.md.*follow it exactly/);
  });

  it('does not append a second contract when the template has one', () => {
    const once = renderRole(ROLE);
    expect(renderRole(once.replace(`${MARKER}\n`, '')).match(/## Contract/g)).toHaveLength(1);
  });
});

describe('renderAll', () => {
  it('covers every domain and every role', () => {
    const roles = mkdtempSync(join(tmpdir(), 'gen-roles-'));
    writeFileSync(join(roles, 'bob-tester.md'), ROLE);
    const files = renderAll({ domains: [domain('games', ['apps/ai/src/games/**'])] }, roles);
    expect([...files.keys()].sort()).toEqual(['bob-games.md', 'bob-tester.md']);
  });
});

describe('CLI', () => {
  it('--check flags a hand-edited file and passes a fresh write', () => {
    const out = mkdtempSync(join(tmpdir(), 'gen-out-'));
    expect(run('--out', out).status).toBe(0);
    expect(run('--check', '--out', out).status).toBe(0);
    const path = join(out, 'bob-memory.md');
    writeFileSync(path, `${readFileSync(path, 'utf8')}hand edit\n`);
    const checked = run('--check', '--out', out);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain('bob-memory.md');
  });

  it('never overwrites a file that lacks the marker', () => {
    const out = mkdtempSync(join(tmpdir(), 'gen-out-'));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'bob-memory.md'), 'hand written\n');
    expect(run('--out', out).status).toBe(0);
    expect(readFileSync(join(out, 'bob-memory.md'), 'utf8')).toBe('hand written\n');
  });

  it('--dry writes nothing and reports the count', () => {
    const dry = run('--dry');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/would write \d+ agents/);
  });
});


describe('generated Claude inventory', () => {
  it('detects stale generated roles and preserves custom files without rewriting unchanged output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gen-claude-inventory-'));
    const files = new Map([['bob-tester.md', renderRole(ROLE)]]);
    writeAgents(files, dir);
    expect(writeAgents(files, dir).written).toEqual([]);
    writeFileSync(join(dir, 'old.md'), `---\nname: old\n---\n${MARKER}\nOld role\n`);
    writeFileSync(join(dir, 'custom.md'), 'Custom agent\n');
    expect(diffAgents(files, dir)).toEqual(['old.md: stale generated agent (review removal manually)']);
  });
});
