// Assembles the Bob UX catalog: one index.html next to the captured img/ from the registry, the mapping,
// the capture json and the installed Astryx template docs. A missing capture shows as a placeholder.
// Usage: node scripts/ui-catalog/build.mjs [dataDir]   (default data/ui-catalog)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGISTRY_FILE, packageDir } from './registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'data/ui-catalog'));
const readJson = (f, fallback) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback);
const registry = readJson(REGISTRY_FILE);
const mapping = readJson(path.join(ROOT, 'docs/ui-v2/ux-catalog/mapping.json'));
const bobCap = readJson(path.join(OUT, 'bob-capture.json'), { shot: {}, mounted: {} });
const astryxCap = readJson(path.join(OUT, 'astryx-capture.json'), {});

const tplDocs = {};
const tplRoot = path.join(packageDir('@astryxdesign/cli', ROOT), 'assets/templates/pages');
for (const slug of fs.readdirSync(tplRoot).sort()) {
  const docFile = path.join(tplRoot, slug, 'template.doc.mjs');
  if (!fs.existsSync(docFile)) continue;
  const doc = fs.readFileSync(docFile, 'utf8');
  const g = (k) => (doc.match(new RegExp(`${k}:\\s*'((?:[^'\\\\]|\\\\.)*)'`)) || [])[1]?.replace(/\\'/g, "'") ?? '';
  tplDocs[slug] = { name: g('displayName') || g('name'), category: g('category'), description: g('description'), ready: /isReady:\s*true/.test(doc) };
}

// Images are referenced only when the capture produced them.
const img = (d, f) => (fs.existsSync(path.join(OUT, 'img', d, f)) ? `img/${d}/${f}` : null);

// Astryx modules: union of the installed dist modules and the Storybook components.
const astryx = {};
for (const [m, v] of Object.entries(registry.astryx)) astryx[m] = { files: v.files.length, jsx: v.jsx, names: v.names, story: null };
for (const [c, v] of Object.entries(astryxCap)) {
  astryx[c] ||= { files: 0, jsx: 0, names: [], storybookOnly: true };
  astryx[c].story = v.story;
  astryx[c].stories = v.stories;
  astryx[c].img = img('astryx', `${c}.jpg`);
}
// Which Astryx names the mapping recommends (for the "use next" state).
const recText = JSON.stringify(mapping.pages.flatMap((p) => p.ops.map((o) => o.use))) + JSON.stringify(Object.values(mapping.components).map((c) => c.rec));
for (const [k, v] of Object.entries(astryx)) v.recommended = new RegExp(`\\b${k}\\b`).test(recText);

const components = registry.bob.map((c) => {
  const m = mapping.components[c.name];
  const shot = bobCap.shot[c.name];
  return {
    ...c,
    img: shot ? img('components', shot.file) : null,
    shotState: shot?.state ?? null,
    mounted: bobCap.mounted[c.name] ?? [],
    rec: m?.rec ?? null, kind: m?.kind ?? null, fixes: m?.fixes ?? null,
  };
});

const tplImg = (slug, vp) => img('templates', `${slug}-${vp}.jpg`);
const pages = mapping.pages.map((p) => ({
  ...p,
  shots: p.states.map((s) => ({ state: s, desktop: img('pages', `${s}-desktop.jpg`), phone: img('pages', `${s}-phone.jpg`) })),
  templates: p.templates.map((t) => ({ ...t, ...tplDocs[t.slug], desktop: tplImg(t.slug, 'desktop'), phone: tplImg(t.slug, 'phone') })),
}));
const future = mapping.future.map((f) => ({ ...f, ...tplDocs[f.template], desktop: tplImg(f.template, 'desktop') }));

const data = {
  generatedAt: new Date().toISOString().slice(0, 10),
  astryxVersion: registry.astryxVersion,
  findings: mapping.findings,
  pages, components, astryx, future,
  templatesAll: Object.entries(tplDocs).map(([slug, d]) => ({ slug, ...d, used: mapping.pages.some((p) => p.templates.some((t) => t.slug === slug)) || mapping.future.some((f) => f.template === slug) })),
};
const tpl = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8');
const body = tpl.replace('__DATA__', () => JSON.stringify(data).replace(/</g, '\\u003c'));
fs.mkdirSync(OUT, { recursive: true });
const indexFile = path.join(OUT, 'index.html');
fs.writeFileSync(indexFile, `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${body}\n</body>\n</html>\n`);

const axList = Object.values(astryx);
const missing = pages.flatMap((p) => p.shots.flatMap((s) => [s.desktop, s.phone])).filter((x) => !x).length
  + axList.filter((v) => v.story && !v.img).length
  + [...pages.flatMap((p) => p.templates), ...future].filter((t) => !t.desktop).length;
console.log(indexFile);
console.log(`screens ${pages.reduce((n, p) => n + p.shots.length, 0)}, components ${components.length}, rendered ${components.filter((c) => c.img).length}, astryx used ${axList.filter((v) => v.files > 0).length}/${axList.length}, templates ${Object.keys(tplDocs).length}, missing captures ${missing}`);
