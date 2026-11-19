import { readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * clean-logs.mjs — remove runtime log files written by the API server,
 * journal, and device monitor. Run from the repo root via `npm run logs:clean`.
 *
 * Deletes data/device.log, data/api.log, data/v2-journal.log and the journal
 * written by workspace dev runs (apps/api/data/v2-journal.log), plus any
 * leftover *.log files in those directories. Files still open by a running
 * server or monitor (Windows) are skipped with a warning.
 */

// Repo root is the directory of this script file. The URL-based resolution is
// used deliberately over import.meta.dirname for Node <20.11 compatibility.
const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)));

const LOG_DIRS = ['data', 'apps/api/data'];
const EXTRA_FILES = [join('data', 'api-smoke.txt')];

let removed = 0;
let skipped = 0;

function remove(path) {
  try {
    rmSync(path, { force: true });
    removed += 1;
  } catch (err) {
    skipped += 1;
    console.warn(`[clean-logs] skip ${path}: ${err.message}`);
  }
}

for (const dir of LOG_DIRS) {
  const abs = resolve(ROOT, dir);
  let entries;
  try {
    entries = readdirSync(abs);
  } catch {
    continue;
  }
  for (const name of entries) {
    if (name.endsWith('.log')) {
      remove(join(abs, name));
    }
  }
}

for (const file of EXTRA_FILES) {
  remove(resolve(ROOT, file));
}

console.log(`[clean-logs] removed ${removed} file(s)${skipped > 0 ? `, skipped ${skipped} (in use)` : ''}.`);