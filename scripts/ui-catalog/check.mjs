// Fast gate for the UI catalog: no stack, no network. Fails (exit 1) when the committed registry.json is
// stale or implausibly empty, a mapping component is not in the registry, or a mapping page file is missing.
// Prints, without failing, how many registry components have no mapping entry.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REGISTRY_FILE, loadRegistry, serialize } from './registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAPPING_FILE = path.join(ROOT, 'docs/ui-v2/ux-catalog/mapping.json');
export const MIN_COMPONENTS = 50;

// Pure. fileExists takes a mapping page path (relative to apps/ui-v2).
export function checkCatalog({ committed, fresh, mapping, fileExists }) {
  const errors = [
    ...plausibilityErrors('committed', committed),
    ...plausibilityErrors('fresh', fresh),
  ];
  if (serialize(committed) !== serialize(fresh)) errors.push('docs/ui-v2/ux-catalog/registry.json is stale: run npm run ui:catalog:registry');
  errors.push(...mappingErrors(fresh?.bob ?? [], mapping, fileExists));
  const mapped = new Set(Object.keys(mapping.components ?? {}));
  const unmapped = (fresh?.bob ?? []).filter((c) => !mapped.has(c.name)).length;
  return { errors, unmapped };
}

function plausibilityErrors(label, reg) {
  const errors = [];
  const n = reg?.bob?.length ?? 0;
  const used = Object.values(reg?.astryx ?? {}).filter((v) => v.files.length).length;
  if (n < MIN_COMPONENTS) errors.push(`${label} registry has ${n} components (expected at least ${MIN_COMPONENTS}); the parser found nothing`);
  if (!used) errors.push(`${label} registry marks no Astryx module as used`);
  return errors;
}

function mappingErrors(bob, mapping, fileExists) {
  const names = new Set(bob.map((c) => c.name));
  const missingNames = Object.keys(mapping.components ?? {})
    .filter((name) => !names.has(name))
    .map((name) => `mapping.components.${name}: no component of that name in the registry`);
  const missingFiles = (mapping.pages ?? []).flatMap((page) => (page.files ?? [])
    .filter((file) => !fileExists(file))
    .map((file) => `mapping.pages.${page.id}: apps/ui-v2/${file} does not exist`));
  return [...missingNames, ...missingFiles];
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
  const { errors, unmapped } = checkCatalog({
    committed: read(REGISTRY_FILE),
    fresh: loadRegistry(ROOT),
    mapping: read(MAPPING_FILE) ?? {},
    fileExists: (f) => fs.existsSync(path.join(ROOT, 'apps/ui-v2', f)),
  });
  for (const e of errors) console.error(e);
  console.log(`ui catalog: ${errors.length} error(s); ${unmapped} components without a mapping entry`);
  process.exit(errors.length ? 1 : 0);
}
