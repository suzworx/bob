import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAgents, checkCoverage, checkManifest, checkMcp, checkRepo, checkSkills } from './check-agents.mjs';
import { renderAll, writeAgents } from './gen-agents.mjs';

const domain = (name, owns = [], extra = {}) => ({
  name, summary: `${name} domain`, owns, tests: [], skills: [], mcp: [], docs: [], gates: [], ...extra,
});

describe('checkManifest', () => {
  it('passes unique kebab-case names with every field', () => {
    expect(checkManifest({ domains: [domain('speech'), domain('turn-pipeline')] })).toEqual([]);
  });

  it('fails a duplicate name', () => {
    expect(checkManifest({ domains: [domain('speech'), domain('speech')] }))
      .toEqual(['domains[1]: name "speech" is used more than once']);
  });

  it('fails a name that is not kebab-case and a field of the wrong type', () => {
    const bad = { ...domain('Speech'), owns: 'apps/**' };
    expect(checkManifest({ domains: [bad] })).toEqual([
      'domains[0]: name "Speech" is not kebab-case',
      'domains[0]: owns must be an array of strings',
    ]);
  });

  it('fails a manifest without a domains array', () => {
    expect(checkManifest({})).toEqual(['domains: must be an array']);
  });
});

describe('checkCoverage', () => {
  const manifest = {
    domains: [domain('speech', ['apps/api/src/voice/audio/**']), domain('platform', ['apps/api/src/voice/*.ts', 'apps/api/src/voice/audio/wav.ts'])],
  };

  it('reports a file matched by two domains as doubleOwned', () => {
    const { doubleOwned } = checkCoverage(manifest, ['apps/api/src/voice/audio/wav.ts', 'apps/api/src/voice/audio/mp3.ts']);
    expect(doubleOwned).toEqual([{ file: 'apps/api/src/voice/audio/wav.ts', owners: ['speech', 'platform'] }]);
  });

  it('reports a file matched by no domain as unowned', () => {
    const { unowned, doubleOwned } = checkCoverage(manifest, ['apps/api/src/voice/index.ts', 'apps/api/src/memory/store.ts']);
    expect(unowned).toEqual(['apps/api/src/memory/store.ts']);
    expect(doubleOwned).toEqual([]);
  });
});

describe('checkSkills', () => {
  it('reports a skill that is not installed', () => {
    const manifest = { domains: [domain('speech', [], { skills: ['vitest', 'no-such-skill'] })] };
    expect(checkSkills(manifest, ['vitest', 'tdd'])).toEqual(['speech: skill "no-such-skill" is not installed']);
  });
});

describe('checkMcp', () => {
  it('reports an MCP server missing from .mcp.json', () => {
    const manifest = { domains: [domain('web-voice', [], { mcp: ['playwright', 'astryx'] })] };
    expect(checkMcp(manifest, { mcpServers: { playwright: {} } }))
      .toEqual(['web-voice: mcp server "astryx" is not in .mcp.json']);
  });
});

describe('checkAgents', () => {
  const manifest = { domains: [domain('speech', ['apps/api/src/voice/audio/**'])] };

  it('reports every rendered agent missing from the agents directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-agents-'));
    const problems = await checkAgents(manifest, dir);
    expect(problems).toContain('.claude/agents/bob-speech.md: missing (run npm run gen:agents)');
    expect(problems).toContain('.claude/agents/bob-reviewer.md: missing (run npm run gen:agents)');
  });

  it('passes a fresh render and fails a hand-edited agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-agents-'));
    writeAgents(renderAll(manifest), dir);
    expect(await checkAgents(manifest, dir)).toEqual([]);
    writeFileSync(join(dir, 'bob-speech.md'), 'edited\n');
    expect(await checkAgents(manifest, dir))
      .toEqual(['.claude/agents/bob-speech.md: differs from what scripts/gen-agents.mjs renders']);
  });

  it('names CR characters when an agent differs only by CRLF line endings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-agents-'));
    const files = renderAll(manifest);
    writeAgents(files, dir);
    writeFileSync(join(dir, 'bob-speech.md'), files.get('bob-speech.md').replace(/\n/g, '\r\n'));
    expect(await checkAgents(manifest, dir))
      .toEqual(['.claude/agents/bob-speech.md: contains CR characters (LF expected; see .gitattributes)']);
  });
});

describe('checkRepo', () => {
  it('passes the repo manifest: every source file has exactly one owner', () => {
    const { domains, files, failures } = checkRepo();
    expect(failures).toEqual([]);
    expect(domains).toBeGreaterThan(0);
    expect(files).toBeGreaterThan(0);
  });
});
