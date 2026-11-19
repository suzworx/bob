import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { collectUiActions } from './ui-action-instrumentation';
import { collectUiListeners } from './ui-listener-coverage';

function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true }).map(String).map((file) => file.replaceAll('\\', '/'))
    .filter((file) => /\.tsx?$/.test(file) && !/(?:\.test\.|test-setup|lib\/observability\/)/.test(file)).sort();
}

export function readUiActionCatalog(root: string): Array<{ id: string; trigger: string; category: string }> {
  return sourceFiles(root).flatMap((file) => collectUiActions(readFileSync(join(root, file), 'utf8'), file).map(({ id, trigger, category }) => ({ id, trigger, category })));
}

export function readUiListenerCatalog(root: string): ReturnType<typeof collectUiListeners> {
  return sourceFiles(root).flatMap((file) => collectUiListeners(readFileSync(join(root, file), 'utf8'), file));
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/generate-ui-action-catalog.ts')) {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const actions = readUiActionCatalog(root);
  const json = JSON.stringify(actions, null, 2) + '\n';
  writeFileSync(join(root, 'lib/observability/ui-action-catalog.json'), json);
  writeFileSync(join(root, 'lib/observability/ui-listener-catalog.json'), JSON.stringify(readUiListenerCatalog(root), null, 2) + '\n');
  writeFileSync(fileURLToPath(new URL('../../api/src/platform/observability/ui-action-catalog.json', import.meta.url)), json);
  writeFileSync(fileURLToPath(new URL('../../api/src/platform/observability/ui-route-catalog.json', import.meta.url)), readFileSync(join(root, 'lib/observability/ui-route-catalog.json')));
  const inventory = JSON.parse(readFileSync(fileURLToPath(new URL('../../api/tests/fixtures/http-route-inventory.json', import.meta.url)), 'utf8')) as Array<{ method: string; path: string }>;
  const endpoints = JSON.stringify(inventory.filter(({ path }) => path.startsWith('/api/')), null, 2) + '\n';
  writeFileSync(join(root, 'lib/observability/ui-endpoint-catalog.json'), endpoints);
  writeFileSync(fileURLToPath(new URL('../../api/src/platform/observability/ui-endpoint-catalog.json', import.meta.url)), endpoints);
  console.log(`UI catalog: ${actions.length} fixed source action IDs.`);
}
