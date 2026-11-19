// npm run ui:catalog: checks the stack answers, seeds the demo family (idempotent), then registry -> capture -> build.
// Prints the index.html path and a one-line summary. Pass --skip-astryx to skip the external Astryx captures.
// Env: BOB_CATALOG_WEB (default http://localhost:5173), BOB_CATALOG_API (default http://localhost:7444).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(ROOT, 'data/ui-catalog');
const WEB = process.env.BOB_CATALOG_WEB || 'http://localhost:5173';
const API = process.env.BOB_CATALOG_API || 'http://localhost:7444';

const answers = async (url) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(5000) })).ok;
  } catch {
    return false;
  }
};
if (!(await answers(`${API}/health`)) || !(await answers(WEB))) {
  console.error(`The stack is not answering (${API}/health, ${WEB}): start npm run dev:offline -- --stub-ai first.`);
  process.exit(1);
}

const run = (label, cmd, args, opts = {}) => {
  console.log(`\n==> ${label}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  return r.status === 0;
};
const node = (script, ...args) => [process.execPath, [path.join(HERE, script), ...args]];
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!run('seed demo', npm, ['run', 'seed:demo'], { shell: process.platform === 'win32' })) process.exit(1);
if (!run('registry', ...node('registry.mjs', '--write'))) process.exit(1);
// A failed capture still builds: missing images show as placeholders and count as missing captures.
if (!run('capture', ...node('capture.mjs', OUT, ...process.argv.slice(2).filter((a) => a === '--skip-astryx')))) {
  console.warn('capture did not finish; building with what it produced');
}
if (!run('build', ...node('build.mjs', OUT))) process.exit(1);
