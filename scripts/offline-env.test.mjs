import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { mainCheckout, offlineEnvPath } from './offline-env.mjs';

const ROOT = resolve(import.meta.dirname, '..');

describe('offline env path', () => {
  it('resolves every worktree of the repo to the main checkout', () => {
    const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).stdout.trim();
    expect(mainCheckout(ROOT)).toBe(dirname(common));
    expect(offlineEnvPath(ROOT)).toBe(join(dirname(common), 'data', 'offline.env'));
  });

  it('falls back to the given root outside a git checkout', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bob-offline-env-')));
    try {
      expect(offlineEnvPath(dir)).toBe(join(dir, 'data', 'offline.env'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
