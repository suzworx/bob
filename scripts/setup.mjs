import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lintEnvText } from './env-lint.mjs';

/*
 * setup.mjs — conservative first-run setup for the repo.
 *
 * This does only non-destructive, local work: verify Node, install npm
 * dependencies, create .env from .env.example when missing, then check the
 * prerequisites the browser client depends on (.env contents). It never writes
 * to the OS trust
 * store; those stay explicit machine-local steps with printed remedies.
 */

const ROOT = resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const shell = process.platform === 'win32';

function run(label, command, args) {
  process.stdout.write(`\n==> ${label}\n`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function probe(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', shell });
  return { ok: result.status === 0, stdout: result.stdout ?? '' };
}

let hardFailures = 0;

const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
if (major < 22) {
  console.error(`Node >= 22 is required; current version is ${process.version}.`);
  process.exit(1);
}

const envPath = resolve(ROOT, '.env');
const examplePath = resolve(ROOT, '.env.example');
if (!existsSync(envPath)) {
  copyFileSync(examplePath, envPath);
  console.log('Created .env from .env.example.');
} else {
  console.log('.env already exists; leaving it unchanged.');
}

run('npm install', npm, ['install']);

// --- Prerequisite checks for running the project and its browser client ---

process.stdout.write('\n==> prerequisite checks\n');

for (const finding of lintEnvText(readFileSync(envPath, 'utf8'))) {
  const mark = finding.level === 'error' ? '✗' : '⚠️ ';
  if (finding.level === 'error') hardFailures += 1;
  console.log(`${mark} ${finding.message}`);
}
if (hardFailures === 0) console.log('✓ .env looks usable');

console.log(`
Setup ${hardFailures > 0 ? 'finished with errors above' : 'complete'}.

Useful next commands:
  npm run dev                 API only
  npm run dev:all             API + browser client on http://localhost:5173/
  npm run validate:non-device autonomous non-device validation
  npm run validate            full gate including firmware compile

Browser voice needs a trusted origin on every device you will speak from:
install this machine's root CA per specs/001-real-agent-web-client/quickstart.md step 3.
`);
process.exit(hardFailures > 0 ? 1 : 0);
