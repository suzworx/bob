import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  acquireHilDatabase, cleanup, hilDatabaseName, PRODUCT_ENV, releaseHilDatabase, resolveEnvs, restoreProduct, runLogged,
  serverRigCommand, soundPlayerCommand, startServer, startServerAgain, stopServer,
} from './rig.mjs';

const logFile = () => join(mkdtempSync(join(tmpdir(), 'hil-rig-')), 'flash.log');
const node = (code) => [process.execPath, ['-e', code]];

// A stand-in for the server-harness child: killed means it exits.
function fakeHarness(pid) {
  const child = new EventEmitter();
  Object.assign(child, { pid, exitCode: null, signalCode: null });
  return child;
}
const killFake = (killed) => (child) => {
  killed.push(child.pid);
  setTimeout(() => { child.exitCode = 1; child.emit('exit', 1, null); }, 10);
};

// A loopback URL as hil-db.ts prints it; never dialled here.
const DB_URL = 'postgresql://bob_server:pw@127.0.0.1:54322/bob_hil_x';

describe('resolveEnvs', () => {
  it('defaults to the Cardputer envs', () => {
    expect(resolveEnvs({})).toEqual({ hil: 'm5stack-cardputer-hil', product: 'm5stack-cardputer-v2-poc' });
    expect(resolveEnvs({ BOB_HIL_ENV: '', BOB_PRODUCT_ENV: '' })).toEqual(resolveEnvs({}));
  });

  it('takes BOB_HIL_ENV and BOB_PRODUCT_ENV overrides', () => {
    expect(resolveEnvs({ BOB_HIL_ENV: 'waveshare-s3-185c-hil', BOB_PRODUCT_ENV: 'waveshare-s3-185c' }))
      .toEqual({ hil: 'waveshare-s3-185c-hil', product: 'waveshare-s3-185c' });
  });
});

describe('the per-run HIL database (acquireHilDatabase, releaseHilDatabase)', () => {
  const runner = (status = 0, stdout = `${DB_URL}
`) => {
    const calls = [];
    return { calls, run: (args) => { calls.push(args); return { status, stdout }; } };
  };

  it('names it bob_hil_<run id>, which the per-test leftover cleanup (bob_test_*) never matches', () => {
    expect(hilDatabaseName('20260924-082431-3E28')).toBe('bob_hil_20260924_082431_3e28');
    expect(hilDatabaseName('20260924-082431-3e28')).not.toMatch(/^bob_test_/);
  });

  it('acquires it once per run, returns its URL and drops it exactly once', () => {
    const fake = runner();
    expect(acquireHilDatabase('20260924-082431-3e28', { run: fake.run })).toBe(DB_URL);
    releaseHilDatabase();
    releaseHilDatabase();
    expect(fake.calls).toEqual([
      ['acquire', 'bob_hil_20260924_082431_3e28'],
      ['release', 'bob_hil_20260924_082431_3e28'],
    ]);
  });

  it('returns null and drops nothing when the local stack cannot create it', () => {
    const fake = runner(1, '');
    expect(acquireHilDatabase('r1', { run: fake.run })).toBeNull();
    releaseHilDatabase();
    expect(fake.calls).toEqual([['acquire', 'bob_hil_r1']]);
  });

  it('cleanup() drops it, so every exit path of a run leaves no database behind', () => {
    const fake = runner();
    acquireHilDatabase('r2', { run: fake.run });
    cleanup();
    expect(fake.calls).toEqual([['acquire', 'bob_hil_r2'], ['release', 'bob_hil_r2']]);
  });
});

// Module state: these run in order, one fake server at a time.
describe('server-stop / server-start (stopServer, startServerAgain)', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'hil-rig-server-'));
  const spawned = [];
  const spawnChild = (spec) => { spawned.push(spec); return fakeHarness(100 + spawned.length); };

  it('does nothing before a server was started', async () => {
    await expect(stopServer({ kill: () => { throw new Error('no kill'); } })).resolves.toBe(false);
  });

  it('server-stop kills the harness by the PID it recorded and waits for the port to free', async () => {
    startServer({ runDir, port: 7999, databaseUrl: DB_URL, spawnChild });
    const killed = [];
    let checks = 0;
    const inUse = async (port) => { expect(port).toBe(7999); return ++checks < 3; };
    await expect(stopServer({ kill: killFake(killed), inUse, pauseMs: 1 })).resolves.toBe(true);
    expect(killed).toEqual([101]);
    expect(checks).toBe(4);  // busy, busy, free, then the confirming check.
  });

  it('server-start spawns the same port, database and journal, and answers health', async () => {
    const ports = [];
    await expect(startServerAgain({ spawnChild, healthy: async (port) => { ports.push(port); return true; } })).resolves.toBe(true);
    expect(spawned).toHaveLength(2);
    expect(spawned[1]).toEqual(spawned[0]);
    expect(spawned[1]).toMatchObject({ runDir, port: 7999, databaseUrl: DB_URL, journalPath: join(runDir, 'server-journal.log') });
    expect(ports).toEqual([7999]);
  });

  it('server-start spawns nothing while the harness still runs, and only checks health', async () => {
    await expect(startServerAgain({ spawnChild, healthy: async () => true })).resolves.toBe(true);
    await expect(startServerAgain({ spawnChild, healthy: async () => false })).resolves.toBe(false);
    expect(spawned).toHaveLength(2);
  });

  it('server-stop reports a port that never frees', async () => {
    const killed = [];
    await expect(stopServer({ kill: killFake(killed), inUse: async () => true, pauseMs: 0 })).resolves.toBe(false);
    expect(killed).toEqual([102]);
  });
});

describe('serverRigCommand', () => {
  const serialLog = () => join(mkdtempSync(join(tmpdir(), 'hil-rig-')), 'serial.log');
  const device = () => { const lines = []; return { lines, push: (l) => lines.push(l) }; };
  const commands = (result) => ({
    'T rig server-stop': { run: result, note: 'stop', notOk: 'server_port_busy', thrown: 'server_stop' },
    'T rig server-start': { run: result, note: 'start', notOk: 'server_not_healthy', thrown: 'server_start' },
  });

  it('answers ok rig once the command is done, and logs it', async () => {
    const out = device();
    const log = serialLog();
    await serverRigCommand('T rig server-stop', out, log, commands(async () => true));
    expect(out.lines).toEqual(['T> ok rig']);
    expect(readFileSync(log, 'utf8')).toBe('>> T rig server-stop  (stop)\n');
  });

  it('answers the error when it resolves false or throws', async () => {
    const out = device();
    await serverRigCommand('T rig server-start', out, serialLog(), commands(async () => false));
    await serverRigCommand('T rig server-stop', out, serialLog(), commands(async () => { throw new Error('x'); }));
    expect(out.lines).toEqual(['T> err server_not_healthy', 'T> err server_stop']);
  });

  it('leaves other commands alone', () => {
    const out = device();
    expect(serverRigCommand('T rig nope', out, serialLog(), commands(async () => true))).toBe(false);
    expect(out.lines).toEqual([]);
  });

  it('knows server-stop, server-start and server-restart', async () => {
    const { SERVER_RIG_COMMANDS } = await import('./rig.mjs');
    expect(Object.keys(SERVER_RIG_COMMANDS).sort()).toEqual(['T rig server-restart', 'T rig server-start', 'T rig server-stop']);
  });
});

describe('soundPlayerCommand', () => {
  it('plays the WAV synchronously through PowerShell, the path single-quoted', () => {
    const [cmd, args] = soundPlayerCommand("D:\\rig\\it's.wav");
    expect(cmd).toBe('powershell.exe');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(args[3]).toBe("(New-Object System.Media.SoundPlayer 'D:\\rig\\it''s.wav').PlaySync()");
  });
});

describe('runLogged', () => {
  it('waits for the process to exit, streams its output to the log and records the exit', async () => {
    const file = logFile();
    const [cmd, args] = node("console.log('Compiling a.o'); setTimeout(() => { console.log('Hash of data verified.'); }, 300)");
    const result = await runLogged(cmd, args, { logFile: file, label: 'pio run -t upload' });
    expect(result).toMatchObject({ ok: true, code: 0, how: 'exit 0' });
    expect(readFileSync(file, 'utf8')).toBe('$ pio run -t upload\nCompiling a.o\nHash of data verified.\n$ exit 0\n');
  });

  it('reports a non-zero exit as not ok', async () => {
    const file = logFile();
    const [cmd, args] = node("process.stderr.write('A fatal error occurred'); process.exit(3)");
    const result = await runLogged(cmd, args, { logFile: file });
    expect(result).toMatchObject({ ok: false, code: 3, how: 'exit 3' });
    expect(readFileSync(file, 'utf8')).toMatch(/A fatal error occurred\n\$ exit 3\n$/);
  });

  it('reports a process killed midway, and the log keeps what it printed', async () => {
    const file = logFile();
    const [cmd, args] = node("console.log('Compiling b.o'); setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100); setTimeout(() => {}, 10000)");
    const result = await runLogged(cmd, args, { logFile: file });
    expect(result.ok).toBe(false);
    expect(result.how).toMatch(/killed by SIGTERM|exit 1/);  // Windows reports a kill as exit 1.
    expect(readFileSync(file, 'utf8')).toMatch(/Compiling b\.o\n\$ (killed by SIGTERM|exit 1)\n$/);
  });

  it('reports a command that cannot start', async () => {
    const result = await runLogged('bob-no-such-command', [], { logFile: logFile() });
    expect(result).toMatchObject({ ok: false, how: expect.stringMatching(/failed to start/) });
  });

  it('redacts MACs in the log', async () => {
    const file = logFile();
    const [cmd, args] = node("console.log('MAC: 12:34:56:78:9a:bc')");
    await runLogged(cmd, args, { logFile: file });
    expect(readFileSync(file, 'utf8')).not.toMatch(/12:34:56:78:9a:bc/);
  });
});

describe('restoreProduct', () => {
  const capture = () => {
    const lines = [];
    return { lines, log: (l) => lines.push(`log ${l}`), error: (l) => lines.push(`error ${l}`) };
  };

  it('awaits the product upload and reports SUCCESS', async () => {
    const out = capture();
    const calls = [];
    const flash = async (args) => {
      calls.push(args);
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true, how: 'exit 0' };
    };
    await expect(restoreProduct({ keepHil: false, flash, ...out })).resolves.toBe(true);
    expect(calls).toEqual([['run', '-e', PRODUCT_ENV, '--target', 'upload', '--upload-port', expect.any(String)]]);
    expect(out.lines.at(-1)).toMatch(/^log restore: SUCCESS/);
  });

  it('reports FAIL with how the flash ended, and resolves false', async () => {
    const out = capture();
    const flash = async () => ({ ok: false, how: 'killed by SIGTERM' });
    await expect(restoreProduct({ keepHil: false, flash, ...out })).resolves.toBe(false);
    expect(out.lines.at(-1)).toMatch(/^error restore: FAIL \(killed by SIGTERM\).*npm run device:flash/);
  });

  it('flashes nothing with --keep-hil', async () => {
    const out = capture();
    let called = false;
    await expect(restoreProduct({ keepHil: true, flash: async () => { called = true; return { ok: true }; }, ...out })).resolves.toBe(true);
    expect(called).toBe(false);
    expect(out.lines[0]).toMatch(/--keep-hil/);
  });
});
