import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { casesFor, cmakeArgs, collectRenders, dockerProblem, infoProblem, simArgs, stillnessProblem } from './candidate.mjs';

const SIM = resolve(import.meta.dirname, 'sim');

describe('the rig variant is explicit (bug: a CMake grep left the candidate on the whole-pose Bob)', () => {
  it('passes the variant to the checkout option and to the gate overlay', () => {
    expect(cmakeArgs('/cache/b', true)).toEqual(expect.arrayContaining(['-DBOBSIM_RIG=ON', '-DGATE_RIG=ON']));
    expect(cmakeArgs('/cache/b', false)).toEqual(expect.arrayContaining(['-DBOBSIM_RIG=OFF', '-DGATE_RIG=OFF']));
  });

  it('refuses a binary compiled as the other variant', () => {
    expect(infoProblem('rig=1\nfreeze=1\n', true)).toBeNull();
    expect(infoProblem('rig=0\nfreeze=1\n', false)).toBeNull();
    expect(infoProblem('rig=0\nfreeze=1\n', true)).toMatch(/compiled with rig=0 but the gate asked for rig=1/);
    expect(infoProblem('', true)).toMatch(/printed no variant/);
  });


  it('never decides anything from the text of the checkout CMakeLists', () => {
    const prepare = readFileSync(join(SIM, 'prepare.sh'), 'utf8');
    expect(prepare).not.toMatch(/grep/);
    expect(prepare).toMatch(/include\(\/gate\/overlay\.cmake\)/);
    const overlay = readFileSync(join(SIM, 'overlay.cmake'), 'utf8');
    expect(overlay).toMatch(/get_target_property\(_gate_sources bob-sim SOURCES\)/);
    expect(overlay).toMatch(/get_target_property\(_gate_defs bob-sim COMPILE_DEFINITIONS\)/);
    expect(overlay).not.toMatch(/file\(READ|file\(STRINGS|string\(FIND/);
  });
});

describe('a missing candidate is a hard error that names the cause (bug: scene cases silently had no render)', () => {
  const cases = [{ id: 'ready' }, { id: 'scene-clap' }, { id: 'scene-hop' }];

  it('moves every render to <id>.png when all are there', () => {
    const out = mkdtempSync(join(tmpdir(), 'gate-cand-'));
    for (const c of cases) {
      mkdirSync(join(out, c.id));
      writeFileSync(join(out, c.id, 'x.png'), 'png');
    }
    expect(() => collectRenders(out, cases)).not.toThrow();
    expect(readFileSync(join(out, 'scene-clap.png'), 'utf8')).toBe('png');
  });

  it('throws with each missing case and the simulator message', () => {
    const out = mkdtempSync(join(tmpdir(), 'gate-cand-'));
    mkdirSync(join(out, 'ready'));
    writeFileSync(join(out, 'ready', 'ready.png'), 'png');
    writeFileSync(join(out, 'scene-clap.err'), 'move clap not available (rig off or unknown)\n');
    expect(() => collectRenders(out, cases)).toThrow(
      /no candidate render for 2\/3 case\(s\):\n {2}scene-clap: move clap not available \(rig off or unknown\)\n {2}scene-hop: bob-sim wrote no PNG/,
    );
  });
});

describe('every docker call has a deadline (a hung engine piled up ~100 stuck calls)', () => {
  it('names a timed-out call and says no pass was written', () => {
    const timedOut = { status: null, signal: 'SIGKILL', error: Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
    expect(dockerProblem(timedOut, 'run', 1_200_000)).toMatch(/docker run did not finish within 1200 s: the Docker engine looks hung .*no pass was written/);
    expect(dockerProblem({ status: null, signal: 'SIGKILL' }, 'probe', 20_000)).toMatch(/docker probe did not finish within 20 s/);
  });

  it('reports a docker that cannot start, and lets a finished call through whatever its exit code', () => {
    expect(dockerProblem({ status: null, error: new Error('spawnSync docker ENOENT') }, 'probe', 20_000)).toMatch(/could not start: spawnSync docker ENOENT/);
    expect(dockerProblem({ status: 1, signal: null }, 'inspect', 30_000)).toBeNull();
    expect(dockerProblem({ status: 0, signal: null }, 'run', 1_200_000)).toBeNull();
  });
});

describe('REST mode: Bob held still on both sides (motion phase was most of the Bob-region gap)', () => {
  it('asks the sim for the rest pose, and for a move at its key pose by normalised t', () => {
    expect(simArgs({ state: 'ready', atMs: 1980 })).toEqual(['--state', 'ready', '--frames', '60', '--freeze']);
    expect(simArgs({ state: 'ready', emotion: 'Love', atMs: 1980 })).toEqual(expect.arrayContaining(['--freeze', '--emotion', 'Love']));
    expect(simArgs({ state: 'ready', move: 'hop', t: 0.5, atMs: 1980 })).toEqual(expect.arrayContaining(['--freeze', '--move', 'hop', '--pose-t', '0.5']));
  });

  it('stops when the firmware lacks the freeze hooks, instead of judging a moving Bob', () => {
    expect(infoProblem('rig=1\nfreeze=0\n', true)).toMatch(/no BOBSIM_FREEZE hooks/);
    expect(infoProblem('rig=1\n', true)).toMatch(/no BOBSIM_FREEZE hooks/);
  });

  it('always builds with BOBSIM_FREEZE and keeps the weak fallbacks that report freeze=0', () => {
    expect(readFileSync(join(SIM, 'overlay.cmake'), 'utf8')).toMatch(/target_compile_definitions\(bob-sim PRIVATE BOBSIM_FREEZE=1\)/);
    const stubs = readFileSync(join(SIM, 'gate_stubs.cpp'), 'utf8');
    expect(stubs).toMatch(/__attribute__\(\(weak\)\) void bobMotionFreeze/);
    expect(stubs).toMatch(/__attribute__\(\(weak\)\) bool bobMotionPoseAt/);
  });

  it('names a key pose for every scene case', () => {
    const { cases } = JSON.parse(readFileSync(resolve(import.meta.dirname, 'cases.json'), 'utf8'));
    const scenes = cases.filter((c) => c.kind === 'scene');
    expect(scenes.length).toBe(12);
    for (const c of scenes) {
      expect(['anticipation', 'apex', 'landing']).toContain(c.key);
      expect(c.t).toBeGreaterThan(0);
      expect(c.t).toBeLessThan(1);
    }
  });

  it('makes every move rig-only: the rig-off list keeps no rig-only case', () => {
    const { cases } = JSON.parse(readFileSync(resolve(import.meta.dirname, 'cases.json'), 'utf8'));
    for (const c of cases) expect(Boolean(c.rigOnly), c.id).toBe(Boolean(c.move));
    expect(casesFor(false).some((c) => c.rigOnly)).toBe(false);
    expect(casesFor(false)).toHaveLength(15);
    expect(casesFor(true)).toHaveLength(27);
  });
});

describe('REST mode proves Bob is still: a render 891 ms earlier must match byte for byte', () => {
  const twin = (out, id, bytes) => { mkdirSync(join(out, `_still-${id}`)); writeFileSync(join(out, `_still-${id}`, 'x.png'), bytes); };

  it('passes when the earlier renders match', () => {
    const out = mkdtempSync(join(tmpdir(), 'gate-still-'));
    writeFileSync(join(out, 'ready.png'), 'same');
    twin(out, 'ready', 'same');
    expect(stillnessProblem(out, ['ready'])).toBeNull();
  });

  it('names a case whose Bob moved between the two times, and one without a twin', () => {
    const out = mkdtempSync(join(tmpdir(), 'gate-still-'));
    writeFileSync(join(out, 'ready.png'), 'at 1980 ms');
    twin(out, 'ready', 'at 1089 ms');
    writeFileSync(join(out, 'thinking.png'), 'x');
    expect(stillnessProblem(out, ['ready', 'thinking'])).toMatch(
      /Bob is not held still in REST mode \(ready: the render 891 ms earlier differs; thinking: no earlier render\)/,
    );
  });

  it('refuses a move case without its key pose', () => {
    expect(() => simArgs({ id: 'scene-x', state: 'ready', move: 'hop', atMs: 1980 })).toThrow(/needs its key pose t/);
  });
});
