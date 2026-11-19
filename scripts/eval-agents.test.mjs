import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractInterface, loadTasks, parseChangedFiles, scoreRun, validateTask } from './eval-agents.mjs';

describe('extractInterface', () => {
  it('lists the missing TS modules a test imports, with their named, default and type imports', () => {
    const text = [
      "import { describe, it } from 'vitest';",
      "import type { MemoryJudge } from '@bob/ai';",
      'import {',
      '  applyReconcile,',
      '  planReconcile,',
      "} from '../../../src/modules/memory/reconcile.ts';",
      "import reconcileCli, { type ReconcilePlan, runCli as run } from '../../../src/modules/memory/reconcile-cli.ts';",
      "import type { MemoryRow } from '../../../src/modules/memory/types.ts';",
      "import { withUser } from '../../../src/platform/db/db.ts';",
    ].join('\n');
    const exists = (path) => path === 'apps/api/src/platform/db/db.ts';
    expect(extractInterface(text, 'apps/api/tests/modules/memory/memory-reconcile.db.test.ts', exists)).toEqual([
      { module: 'apps/api/src/modules/memory/reconcile.ts', names: ['applyReconcile', 'planReconcile'] },
      { module: 'apps/api/src/modules/memory/reconcile-cli.ts', names: ['default', 'ReconcilePlan', 'runCli'] },
      { module: 'apps/api/src/modules/memory/types.ts', names: ['MemoryRow'] },
    ]);
  });

  it('lists a C++ #include of a header missing at base, resolved against the test file', () => {
    const text = '#include <vector>\n#include "doctest.h"\n#include "../../src/mp3_ring_source.h"\n';
    const exists = (path) => path === 'apps/cardputer/test/host/doctest.h';
    expect(extractInterface(text, 'apps/cardputer/test/host/test_mp3_ring_source.cpp', exists)).toEqual([
      { module: 'apps/cardputer/src/mp3_ring_source.h', names: [] },
    ]);
  });

  describe('C++ qualified symbols', () => {
    const text = '#include <vector>\n#include "../../src/x.h"\n\nstd::vector<int> v;\nbob::endThing(&s);\nRing::drain(r);\n';
    const path = 'apps/cardputer/test/host/test_x.cpp';

    it('names the bob:: functions and Class::members absent at base under the missing header', () => {
      expect(extractInterface(text, path, () => false, () => false)).toEqual([
        { module: 'apps/cardputer/src/x.h', names: ['endThing', 'Ring::drain'] },
      ]);
    });

    it('names nothing when the symbols already exist at base', () => {
      expect(extractInterface(text, path, () => false, () => true)).toEqual([
        { module: 'apps/cardputer/src/x.h', names: [] },
      ]);
    });

    it('files a missing symbol under "(new symbol)" when every include exists', () => {
      expect(extractInterface(text, path, () => true, (name) => name !== 'endThing')).toEqual([
        { module: '(new symbol)', names: ['endThing'] },
      ]);
    });
  });
});

describe('parseChangedFiles', () => {
  it('drops line-ending-only changes, the copied agent config and the hidden tests, and adds untracked files', () => {
    const numstat = [
      '12\t3\tapps/api/src/modules/memory/reconcile.ts',
      '0\t0\tapps/api/tests/contract/__snapshots__/thread-conversation-contract.test.ts.snap',
      '-\t-\tapps/cardputer/data/earcon.bin',
      '0\t40\tapps/api/tests/hidden.test.ts',
      '2\t0\t.claude/agents/bob-memory.md',
      '',
    ].join('\n');
    const untracked = 'apps/api/src/modules/memory/reconcile-cli.ts\n.mcp.json\n';
    expect(parseChangedFiles(numstat, untracked, { hiddenTests: ['apps/api/tests/hidden.test.ts'] })).toEqual([
      'apps/api/src/modules/memory/reconcile.ts',
      'apps/cardputer/data/earcon.bin',
      'apps/api/src/modules/memory/reconcile-cli.ts',
    ]);
  });
});

const ROOT = resolve(import.meta.dirname, '..');
const DOMAIN = {
  name: 'memory',
  owns: ['apps/ai/src/memory-*.ts', 'apps/api/src/modules/memory/**'],
  tests: ['apps/api/tests/modules/memory/**', 'apps/ai/tests/{memory-a,memory-b}.test.ts'],
};
const MANIFEST = { domains: [DOMAIN] };
const REPORT = [
  '## PLAN', 'x', '## CHANGES', 'x', '## GATES RUN', 'x', '## EVIDENCE', 'x', '## RISKS', 'x',
  '## Findings outside owns:', 'None',
].join('\n');
const run = (overrides = {}) => scoreRun({
  changedFiles: ['apps/ai/src/memory-judge.ts', 'apps/ai/tests/memory-b.test.ts'],
  domain: DOMAIN,
  gateResults: [{ command: 'npx vitest run x', exitCode: 0, tail: '' }],
  resultText: REPORT,
  costUsd: 1.25,
  turns: 12,
  ...overrides,
});

describe('scoreRun', () => {
  it('scores 1 when the gates pass and every change is inside owns or tests', () => {
    expect(run()).toEqual({
      gatesPass: true, ownsRespected: true, outsideOwns: [], reportFormat: true, costUsd: 1.25, turns: 12, score: 1,
    });
  });

  it('scores 0.5 and lists the file when a change falls outside owns', () => {
    const result = run({ changedFiles: ['apps/ai/src/memory-judge.ts', 'apps/api/src/server.ts'] });
    expect(result.ownsRespected).toBe(false);
    expect(result.outsideOwns).toEqual(['apps/api/src/server.ts']);
    expect(result.score).toBe(0.5);
  });

  it('scores 0 when a gate fails', () => {
    const result = run({ gateResults: [{ command: 'a', exitCode: 0 }, { command: 'b', exitCode: 1 }] });
    expect(result.gatesPass).toBe(false);
    expect(result.score).toBe(0);
  });

  it('scores 0 when there are no gate results', () => {
    expect(run({ gateResults: [] }).score).toBe(0);
  });

  it('detects the report headings only when all six are present', () => {
    expect(run().reportFormat).toBe(true);
    expect(run({ resultText: REPORT.replace('## RISKS', '## Risks') }).reportFormat).toBe(false);
    expect(run({ resultText: undefined }).reportFormat).toBe(false);
  });
});

describe('validateTask', () => {
  const task = (overrides = {}) => ({
    id: 'memory-x',
    agent: 'bob-memory',
    commit: 'e454801c',
    base: 'e454801c^',
    prompt: 'Fix it.',
    hiddenTests: ['scripts/check-skills.test.mjs'],
    gates: ['npx vitest run scripts/check-skills.test.mjs'],
    maxBudgetUsd: 3,
    ...overrides,
  });

  // Fake git lookups: the unit tests never depend on repository history (CI clones shallow).
  const git = {
    resolveCommit: (rev) => rev === 'e454801c^',
    hasFile: (commit, path) => commit === 'e454801c' && path === 'scripts/check-skills.test.mjs',
  };
  const noGit = {
    resolveCommit: () => { throw new Error('history was read'); },
    hasFile: () => { throw new Error('history was read'); },
  };

  it('accepts a well-formed task', () => {
    expect(validateTask(task(), MANIFEST, git)).toEqual([]);
  });

  it('rejects an unknown agent', () => {
    expect(validateTask(task({ agent: 'bob-nope' }), MANIFEST, git)).toEqual([
      expect.stringMatching(/unknown agent "bob-nope"/),
    ]);
  });

  it('rejects a base that does not resolve', () => {
    expect(validateTask(task({ base: 'deadbeef^' }), MANIFEST, git)).toEqual([
      expect.stringMatching(/base "deadbeef\^" does not resolve/),
    ]);
  });

  it('rejects a hidden test path that does not exist in the commit', () => {
    expect(validateTask(task({ hiddenTests: ['scripts/missing.test.mjs'] }), MANIFEST, git)).toEqual([
      expect.stringMatching(/scripts\/missing\.test\.mjs/),
    ]);
  });

  it('checks only the schema and the agent when history checks are off', () => {
    expect(validateTask(task(), MANIFEST, { ...noGit, checkHistory: false })).toEqual([]);
    expect(validateTask(task({ agent: 'bob-nope', maxBudgetUsd: '3' }), MANIFEST, { ...noGit, checkHistory: false }))
      .toEqual(['maxBudgetUsd must be a number']);
    expect(validateTask(task({ agent: 'bob-nope' }), MANIFEST, { ...noGit, checkHistory: false }))
      .toEqual([expect.stringMatching(/unknown agent/)]);
  });
});

describe('CLI --dry', () => {
  it('validates the real task files and exits 0', () => {
    const result = spawnSync(process.execPath, ['scripts/eval-agents.mjs', '--dry'], { cwd: ROOT, encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`eval-agents: ${loadTasks().length} tasks valid`);
  }, 120_000); // a child node + git under validate's parallel workers can take >30 s
});
