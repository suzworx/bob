// One-off importer: copies the listed Lucide icons (ISC licence, see LICENSE) out of an installed
// `lucide-react` package into plain 24x24 SVG files here. The SVGs are the source of truth after that;
// build.mjs (web) and icons_build.py (device) both read them.
//   LUCIDE_DIR=<path to node_modules/lucide-react> node design/bob/icons/import-lucide.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = process.env.LUCIDE_DIR || dirname(createRequire(import.meta.url).resolve('lucide-react/package.json'));
const NAMES = ['mic', 'mic-off', 'wifi', 'wifi-high', 'wifi-low', 'wifi-zero', 'wifi-off', 'cloud', 'cloud-off', 'volume', 'volume-1', 'volume-2', 'volume-x',
  'battery', 'battery-low', 'battery-medium', 'battery-full', 'battery-charging', 'battery-warning', 'moon'];
const attr = (o) => Object.entries(o).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ');
for (const n of NAMES) {
  const mod = await import(pathToFileURL(join(pkgDir, 'dist/esm/icons', n + '.mjs')).href);
  const body = mod.__iconNode.map(([tag, a]) => `  <${tag} ${attr(a)}/>`).join('\n');
  writeFileSync(join(here, n + '.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n${body}\n</svg>\n`);
}
const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
writeFileSync(join(here, 'LICENSE'), `Lucide icons, imported from lucide-react ${version}.\n\n${readFileSync(join(pkgDir, 'LICENSE'), 'utf8')}`);
console.log('imported', NAMES.length, 'icons');
