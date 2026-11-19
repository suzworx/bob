import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { makePassRecord } from '../device-attest.mjs';
import { firmwareHashAt } from './firmware-hash.mjs';
import { decidePush, judgePush, parsePushLines, resolveBase, ZERO_SHA } from './push-gate.mjs';

const FW = '1'.repeat(64);
const OTHER_FW = '2'.repeat(64);
const SHA = 'c'.repeat(40);
const REMOTE = 'd'.repeat(40);

const passing = makePassRecord({
  firmwareHash: FW,
  tree: 'a'.repeat(40),
  runId: '20260923-120000-ab12',
  scenarios: [{ name: 'boot-ready', issue: '#baseline', status: 'pass' }],
  deviceId: 'c1799564f2ee',
  ts: '2026-09-23T12:00:00Z',
  runnerVersion: '1',
});

const ref = (overrides = {}) => ({
  localSha: SHA,
  remoteSha: REMOTE,
  changedFiles: ['apps/cardputer/src/main.cpp'],
  firmwareHash: FW,
  ...overrides,
});

describe('parsePushLines', () => {
  it('reads git’s "<local ref> <local sha> <remote ref> <remote sha>" lines', () => {
    const text = `refs/heads/x ${SHA} refs/heads/x ${REMOTE}\nrefs/heads/y ${ZERO_SHA} refs/heads/y ${REMOTE}\n`;
    expect(parsePushLines(text)).toEqual([
      { localRef: 'refs/heads/x', localSha: SHA, remoteRef: 'refs/heads/x', remoteSha: REMOTE },
      { localRef: 'refs/heads/y', localSha: ZERO_SHA, remoteRef: 'refs/heads/y', remoteSha: REMOTE },
    ]);
  });

  it('ignores blank lines', () => {
    expect(parsePushLines('\n\n')).toEqual([]);
  });
});

describe('decidePush', () => {
  it('allows a push that changes no firmware input, silently', () => {
    const decision = decidePush({ refs: [ref({ changedFiles: ['apps/api/src/server.ts', 'scripts/hil/run.mjs'] })], record: null });
    expect(decision).toEqual({ allow: true, message: '' });
  });

  it('allows a branch deletion', () => {
    expect(decidePush({ refs: [ref({ localSha: ZERO_SHA, changedFiles: [] })], record: null }).allow).toBe(true);
  });

  it('allows a firmware change backed by a passing HIL run of the same firmware', () => {
    const decision = decidePush({ refs: [ref()], record: passing });
    expect(decision.allow).toBe(true);
    expect(decision.message).toMatch(/20260923-120000-ab12/);
  });

  it('blocks a firmware change with no HIL run, and says how to run one', () => {
    const decision = decidePush({ refs: [ref()], record: null });
    expect(decision.allow).toBe(false);
    expect(decision.message).toMatch(/node scripts\/hil\/run\.mjs/);
    expect(decision.message).toMatch(/apps\/cardputer\/src\/main\.cpp/);
  });

  it('blocks when the HIL run tested different firmware', () => {
    const decision = decidePush({ refs: [ref({ firmwareHash: OTHER_FW })], record: passing });
    expect(decision.allow).toBe(false);
    expect(decision.message).toMatch(/firmware/);
  });

  it('blocks when the HIL run had a failing scenario', () => {
    const failed = { ...passing, scenarios: [...passing.scenarios, { name: 'stop', issue: '#315', status: 'fail' }] };
    expect(decidePush({ refs: [ref()], record: failed }).allow).toBe(false);
  });

  it('checks every pushed ref that touches firmware', () => {
    const refs = [ref(), ref({ localSha: 'e'.repeat(40), firmwareHash: OTHER_FW })];
    expect(decidePush({ refs, record: passing }).allow).toBe(false);
  });

  it('lets BOB_SKIP_HOOKS through, loudly, when firmware changed untested', () => {
    const decision = decidePush({ refs: [ref()], record: null, skip: true });
    expect(decision.allow).toBe(true);
    expect(decision.message).toMatch(/WARNING/);
    expect(decision.message).toMatch(/firmware-hil/);
  });

  it('stays quiet about the bypass when nothing firmware changed', () => {
    const decision = decidePush({ refs: [ref({ changedFiles: ['README.md'] })], record: null, skip: true });
    expect(decision).toEqual({ allow: true, message: '' });
  });
});

// A real repository: "origin/main" is a remote-tracking ref, the pushed branch
// a local one, and git's pre-push stdin names both.
//
// Every git call is a new process, and on Windows the process start is the
// cost: a rev-parse git traces at 12 ms took 1-8 s on a busy machine, so
// rebuilding the repo in every test (about 12 spawns) hit the 30 s timeout.
// The two starting repos are built once and copied per test with fs, and git
// runs on fixed config, identity and dates, never the machine's own.
describe('judgePush on a real repository', () => {
  let dir;
  let root;
  const run = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
    run('add', '--', path);
    run('commit', '-q', '-m', `edit ${path}`);
    return run('rev-parse', 'HEAD');
  };
  const pushLine = (localSha, remoteSha = ZERO_SHA, branch = 'refs/heads/feature') =>
    `${branch} ${localSha} ${branch} ${remoteSha}\n`;
  const passFor = (sha) => makePassRecord({
    firmwareHash: firmwareHashAt(sha, dir),
    tree: run('rev-parse', `${sha}^{tree}`),
    runId: '20260924-090000-cd34',
    scenarios: [{ name: 'boot-ready', issue: '#baseline', status: 'pass' }],
    mac: 'aa:bb:cc:dd:ee:ff',
    ts: '2026-09-24T09:00:00Z',
    runnerVersion: '1',
  });

  let mainSha;
  let mainMovedSha;
  let main2Sha;
  let main3Sha;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'bob-push-gate-'));
    writeFileSync(join(root, 'gitconfig'), '');
    const env = {
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
      GIT_AUTHOR_NAME: 'gate', GIT_AUTHOR_EMAIL: 'gate@bob.test', GIT_AUTHOR_DATE: '2026-09-24T09:00:00Z',
      GIT_COMMITTER_NAME: 'gate', GIT_COMMITTER_EMAIL: 'gate@bob.test', GIT_COMMITTER_DATE: '2026-09-24T09:00:00Z',
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

    dir = join(root, 'main');
    mkdirSync(dir);
    run('init', '-q', '-b', 'main');
    commit('apps/cardputer/src/main.cpp', 'int main() { return 0; }\n');
    mainSha = commit('README.md', 'bob\n');
    // Where main moves on later, with a firmware change (mainChangesFirmware).
    mainMovedSha = commit('apps/cardputer/include/display.h', '#pragma once\n');
    run('update-ref', 'refs/fixture/main-moved', mainMovedSha);
    run('reset', '-q', '--hard', mainSha);
    run('update-ref', 'refs/remotes/origin/main', mainSha);
    run('checkout', '-q', '-b', 'feature');

    // main2 forks from main with a firmware change of its own (origin/main2
    // follows it); a new branch is cut from main2. PRs now merge into main2.
    cpSync(dir, join(root, 'main2'), { recursive: true });
    dir = join(root, 'main2');
    run('checkout', '-q', '-b', 'main2', 'main');
    main2Sha = commit('apps/cardputer/src/protocol.h', '#pragma once\n');
    run('update-ref', 'refs/remotes/origin/main2', main2Sha);
    run('checkout', '-q', '-b', 'voice-id');

    // main3 forks from main2 with more firmware (#669), so main2 now differs
    // from main3 in firmware; a docs branch is cut from main3.
    cpSync(dir, join(root, 'main3'), { recursive: true });
    dir = join(root, 'main3');
    run('checkout', '-q', '-b', 'main3', 'main2');
    main3Sha = commit('apps/cardputer/src/wifi_setup.cpp', 'int wifi = 1;\n');
    run('update-ref', 'refs/remotes/origin/main3', main3Sha);
    run('checkout', '-q', '-b', 'docs-fix');
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  /** A fresh copy of a starting repo: 'main' (on feature) or 'main2' (on voice-id). */
  const startFrom = (template) => {
    if (dir.startsWith(join(root, 'test-'))) rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(root, 'test-'));
    cpSync(join(root, template), dir, { recursive: true });
  };

  beforeEach(() => {
    startFrom('main');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** main moves on with a firmware change; origin/main follows it. */
  const mainChangesFirmware = () => {
    run('update-ref', 'refs/heads/main', mainMovedSha);
    run('update-ref', 'refs/remotes/origin/main', mainMovedSha);
    return mainMovedSha;
  };

  it('allows a docs-only branch that merged in a main which changed firmware', () => {
    const pushed = commit('docs/notes.md', 'notes\n');
    const remote = pushed; // the branch was already on the remote before the merge
    mainChangesFirmware();
    run('merge', '-q', '--no-edit', 'origin/main');
    const local = run('rev-parse', 'HEAD');

    const decision = judgePush({ stdin: pushLine(local, remote), record: null, cwd: dir });
    expect(decision).toEqual({ allow: true, message: '' });
  });

  it('blocks a branch that itself changes firmware, with no HIL pass', () => {
    const local = commit('apps/cardputer/src/main.cpp', 'int main() { return 1; }\n');
    const decision = judgePush({ stdin: pushLine(local, mainSha), record: null, cwd: dir });
    expect(decision.allow).toBe(false);
    expect(decision.message).toMatch(/apps\/cardputer\/src\/main\.cpp/);
  });

  it('lists only the branch’s own firmware inputs when it also merged main', () => {
    const remote = commit('apps/cardputer/src/main.cpp', 'int main() { return 1; }\n');
    mainChangesFirmware();
    run('merge', '-q', '--no-edit', 'origin/main');
    const local = run('rev-parse', 'HEAD');

    const decision = judgePush({ stdin: pushLine(local, remote), record: null, cwd: dir });
    expect(decision.allow).toBe(false);
    expect(decision.message).toMatch(/apps\/cardputer\/src\/main\.cpp/);
    expect(decision.message).not.toMatch(/display\.h/);
  });

  it('allows a branch that changes firmware when a HIL pass matches it', () => {
    const local = commit('apps/cardputer/src/main.cpp', 'int main() { return 1; }\n');
    const decision = judgePush({ stdin: pushLine(local, mainSha), record: passFor(local), cwd: dir });
    expect(decision.allow).toBe(true);
    expect(decision.message).toMatch(/20260924-090000-cd34/);
  });

  it('judges a new branch against its merge-base with origin/main', () => {
    const docs = commit('docs/notes.md', 'notes\n');
    expect(judgePush({ stdin: pushLine(docs), record: null, cwd: dir })).toEqual({ allow: true, message: '' });

    const fw = commit('apps/cardputer/platformio.ini', '[env]\n');
    const decision = judgePush({ stdin: pushLine(fw), record: null, cwd: dir });
    expect(decision.allow).toBe(false);
    expect(decision.message).toMatch(/platformio\.ini/);
  });

  it('falls back to the pushed range, and says so, when origin/main is missing', () => {
    const remote = commit('docs/notes.md', 'notes\n');
    const local = commit('apps/cardputer/src/main.cpp', 'int main() { return 1; }\n');
    run('update-ref', '-d', 'refs/remotes/origin/main');

    const decision = judgePush({ stdin: pushLine(local, remote), record: null, cwd: dir });
    expect(decision.allow).toBe(false);
    expect(decision.message).toMatch(/apps\/cardputer\/src\/main\.cpp/);
    expect(decision.message).toMatch(/origin\/main is unavailable/);
  });

  it('says so even when the fallback range has no firmware in it', () => {
    const remote = commit('docs/notes.md', 'notes\n');
    const local = commit('docs/more.md', 'more\n');
    run('update-ref', '-d', 'refs/remotes/origin/main');

    const decision = judgePush({ stdin: pushLine(local, remote), record: null, cwd: dir });
    expect(decision.allow).toBe(true);
    expect(decision.message).toMatch(/origin\/main is unavailable/);
  });

  it('judges a push to main on the pushed range, as before', () => {
    run('checkout', '-q', 'main');
    const local = commit('apps/cardputer/src/main.cpp', 'int main() { return 2; }\n');
    // origin/main is still mainSha, so the pushed range is exactly the new commit.
    const decision = judgePush({ stdin: pushLine(local, mainSha, 'refs/heads/main'), record: null, cwd: dir });
    expect(decision.allow).toBe(false);
    expect(decision.message).toMatch(/apps\/cardputer\/src\/main\.cpp/);
  });

  it('allows a branch deletion', () => {
    const decision = judgePush({ stdin: `(delete) ${ZERO_SHA} refs/heads/feature ${mainSha}\n`, record: null, cwd: dir });
    expect(decision).toEqual({ allow: true, message: '' });
  });

  const noEnv = {};
  const integration = (branch) => {
    mkdirSync(join(dir, '.flywheel'), { recursive: true });
    writeFileSync(join(dir, '.flywheel', 'config.json'), JSON.stringify({ version: 1, integration: { branch } }));
  };

  /** The main2 starting repo, on a new branch voice-id cut from main2, with
   *  integration.branch naming main2 (PRs merge into it). */
  const branchOffMain2 = () => {
    startFrom('main2');
    integration('main2');
    return main2Sha;
  };

  it('judges a branch off main2 against origin/main2: docs only is not blocked', () => {
    branchOffMain2();
    const local = commit('docs/voice-id/plan.md', 'plan\n');
    const decision = judgePush({ stdin: pushLine(local, ZERO_SHA, 'refs/heads/voice-id'), record: null, cwd: dir, env: noEnv });
    expect(decision).toEqual({ allow: true, message: '' });
  });

  it('blocks a branch off main2 that changes firmware, listing only its own files', () => {
    branchOffMain2();
    const local = commit('apps/cardputer/src/x.cpp', 'int x = 1;\n');
    const decision = judgePush({ stdin: pushLine(local, ZERO_SHA, 'refs/heads/voice-id'), record: null, cwd: dir, env: noEnv });
    expect(decision.allow).toBe(false);
    expect(decision.message).toMatch(/apps\/cardputer\/src\/x\.cpp/);
    expect(decision.message).not.toMatch(/protocol\.h/);
  });

  it('lets BOB_PUSH_BASE override the default base, and names it when it is missing', () => {
    branchOffMain2();
    const local = commit('docs/voice-id/plan.md', 'plan\n');
    const stdin = pushLine(local, ZERO_SHA, 'refs/heads/voice-id');

    const againstMain = judgePush({ stdin, record: null, cwd: dir, env: { BOB_PUSH_BASE: 'origin/main' } });
    expect(againstMain.allow).toBe(false);
    expect(againstMain.message).toMatch(/apps\/cardputer\/src\/protocol\.h/);

    const missing = judgePush({ stdin, record: null, cwd: dir, env: { BOB_PUSH_BASE: 'origin/release' } });
    expect(missing.message).toMatch(/origin\/release is unavailable/);
  });

  it('judges a push to main2 itself on the pushed range', () => {
    const main2 = branchOffMain2();
    run('checkout', '-q', 'main2');
    const local = commit('apps/cardputer/src/x.cpp', 'int x = 2;\n');
    const decision = judgePush({ stdin: pushLine(local, main2, 'refs/heads/main2'), record: null, cwd: dir, env: noEnv });
    expect(decision.allow).toBe(false);
    expect(decision.message).toMatch(/apps\/cardputer\/src\/x\.cpp/);
    expect(decision.message).not.toMatch(/protocol\.h/);
  });

  /** The main3 starting repo, on a docs branch cut from main3. */
  const branchOffMain3 = () => startFrom('main3');
  let docsEdits = 0;
  const docsPush = () => pushLine(commit('docs/wifi.md', `wifi ${++docsEdits}\n`), ZERO_SHA, 'refs/heads/docs-fix');

  it('judges a branch off main against origin/main, though retired origin/main3 and origin/main2 still exist', () => {
    // main moved on with firmware (as origin/main did with the OTA headers);
    // a docs branch cut from it changes no firmware of its own. Judged against
    // main3, whose merge-base predates that move, it listed main's firmware.
    branchOffMain3();
    run('update-ref', 'refs/remotes/origin/main', mainMovedSha);
    run('checkout', '-q', '-b', 'docs-off-main', mainMovedSha);
    const local = commit('docs/notes.md', 'notes\n');

    expect(resolveBase(dir, noEnv)).toBe('origin/main');
    const decision = judgePush({ stdin: pushLine(local, ZERO_SHA, 'refs/heads/docs-off-main'), record: null, cwd: dir, env: noEnv });
    expect(decision).toEqual({ allow: true, message: '' });
  });

  it('takes the base from integration.branch in .flywheel/config.json', () => {
    branchOffMain3();
    integration('main2');
    const decision = judgePush({ stdin: docsPush(), record: null, cwd: dir, env: noEnv });
    expect(decision.allow).toBe(false);
    expect(decision.message).toMatch(/wifi_setup\.cpp/);

    integration('main3');
    expect(judgePush({ stdin: docsPush(), record: null, cwd: dir, env: noEnv })).toEqual({ allow: true, message: '' });
  });

  it('skips an integration.branch that has no origin ref and uses origin/main', () => {
    branchOffMain3();
    integration('release');
    expect(resolveBase(dir, noEnv)).toBe('origin/main');
    const decision = judgePush({ stdin: docsPush(), record: null, cwd: dir, env: noEnv });
    expect(decision.allow).toBe(false);
    expect(decision.message).toMatch(/wifi_setup\.cpp/);
  });

  it('lets BOB_PUSH_BASE win over integration.branch', () => {
    branchOffMain3();
    integration('main3');
    const decision = judgePush({ stdin: docsPush(), record: null, cwd: dir, env: { BOB_PUSH_BASE: 'origin/main2' } });
    expect(decision.allow).toBe(false);
  });
});
