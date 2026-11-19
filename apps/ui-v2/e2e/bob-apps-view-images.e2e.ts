import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { APIRequestContext, Locator, Page, TestInfo } from '@playwright/test';
import { expect, ok, test } from './fixtures.ts';
import { clickAppAction } from './pages/bob-app-actions.ts';
import type { AppDefinition, BobApp } from '../src/features/bob-apps/bob-apps-api';

// Exercise the real download path consistently, including browsers with a native share sheet.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
  });
});

const definition: AppDefinition = {
  schemaVersion: 1, title: 'Saved view image fixture', lifecycle: 'keep',
  tables: [{ id: 'items', fields: [{ id: 'title', type: 'text' }, { id: 'completed', type: 'boolean' }] }],
  actions: [{ id: 'create', table: 'items', operation: 'create' }, { id: 'update', table: 'items', operation: 'update' }],
  metrics: [{ id: 'count', table: 'items', operation: 'count' }],
  views: [
    { id: 'records', kind: 'checklist', title: 'Saved checklist', table: 'items', fields: ['title', 'completed'], actions: ['create', 'update'] },
    { id: 'slides', kind: 'slides', title: 'Presentation', slides: [
      { title: 'First slide stays out', body: 'First slide private to this selection', metrics: [] },
      { title: 'Second slide to share', body: 'Only this selected slide belongs in the image.', metrics: ['count'] },
    ] },
  ],
};

async function savedApp(api: APIRequestContext, cleanup: (undo: () => Promise<void>) => void, title: string, rows: string[] = [], kind: 'table' | 'checklist' = 'checklist'): Promise<string> {
  const views = definition.views.map((view) => view.id === 'records' && 'table' in view ? { ...view, kind } : view);
  const created = await api.post('/api/bob-apps', { data: { definition: { ...definition, title, views }, mutationId: randomUUID() } });
  await ok('create image fixture', created);
  let { app } = await created.json() as { app: BobApp };
  cleanup(async () => {
    const current = await api.get(`/api/bob-apps/${app.id}`);
    if (current.status() === 404) return;
    await ok('read image fixture for cleanup', current);
    const { app: latest } = await current.json() as { app: BobApp };
    await ok('delete image fixture', await api.delete(`/api/bob-apps/${latest.id}`, { data: { expectedRevision: latest.revision, mutationId: randomUUID() } }));
  });
  const active = await api.patch(`/api/bob-apps/${app.id}`, { data: { operation: 'activate', expectedRevision: app.revision, mutationId: randomUUID() } });
  await ok('activate image fixture', active);
  app = (await active.json() as { app: BobApp }).app;
  for (const [index, title] of rows.entries()) {
    const written = await api.post(`/api/bob-apps/${app.id}/actions`, { data: { expectedRevision: app.revision, mutationId: randomUUID(), command: { operation: 'write', action: 'create', id: `r_${index}`, values: { title, completed: true } } } });
    await ok('save image fixture record', written);
    app = (await written.json() as { app: BobApp }).app;
  }
  return app.id;
}

async function openPreview(page: Page): Promise<{ dialog: Locator; preview: Locator }> {
  await clickAppAction(page, 'Share view as image');
  const dialog = page.getByRole('dialog', { name: 'Share saved view', exact: true });
  const preview = dialog.getByRole('region', { name: 'Saved view image preview', exact: true });
  await expect(preview).toBeVisible();
  // The capture surface must not inherit the editor, menus, slide navigation or conversation.
  await expect(preview.getByRole('button')).toHaveCount(0);
  await expect(preview.getByRole('textbox')).toHaveCount(0);
  await expect(preview.getByRole('combobox')).toHaveCount(0);
  await expect(preview.getByRole('tablist')).toHaveCount(0);
  await expect(preview.getByRole('dialog')).toHaveCount(0);
  return { dialog, preview };
}

async function downloadPng(page: Page, dialog: Locator, preview: Locator, info: TestInfo, name: string, checkArt = false): Promise<void> {
  await dialog.getByRole('button', { name: 'Prepare image', exact: true }).click();
  const downloadButton = dialog.getByRole('button', { name: 'Download image', exact: true });
  await expect(downloadButton).toBeInViewport();
  // Preparation settles fonts and assets; screenshot settles the final visible animation frame.
  const previewPath = info.outputPath(`${name}-preview.png`);
  await preview.screenshot({ path: previewPath, animations: 'disabled' });
  await info.attach(`${name}-preview`, { path: previewPath, contentType: 'image/png' });
  const box = await preview.boundingBox();
  if (!box) throw new Error('Saved view preview has no rendered bounds');
  const art = checkArt ? await preview.locator('img').evaluate((image: HTMLImageElement) => {
    const rect = image.getBoundingClientRect();
    return { src: image.currentSrc, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }) : null;
  const readyPath = info.outputPath(`${name}-ready.png`);
  await dialog.screenshot({ path: readyPath, animations: 'disabled' });
  await info.attach(`${name}-prepared`, { path: readyPath, contentType: 'image/png' });
  const pending = page.waitForEvent('download');
  await downloadButton.click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  const path = info.outputPath(`${name}.png`);
  await download.saveAs(path);
  const bytes = await readFile(path);
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(bytes.readUInt32BE(16)).toBe(Math.round(box.width * 2));
  expect(bytes.readUInt32BE(20)).toBe(Math.round(box.height * 2));
  const pixels = await page.evaluate(async ({ encoded, art, box }) => {
    function matchArt(expected: Uint8ClampedArray, data: Uint8ClampedArray, width: number, height: number, outputWidth: number, originX: number, originY: number): { artSamples: number; artMatch: number } {
      let samples = 0; let matched = 0;
      const columns = Math.ceil((width - 4) / 4);
      const rows = Math.ceil((height - 4) / 4);
      for (let index = 0; index < columns * rows; index++) {
        const x = 2 + (index % columns) * 4;
        const y = 2 + Math.floor(index / columns) * 4;
        const s = (y * width + x) * 4;
        if (expected[s + 3] < 250) continue;
        // Sample Bob's colored pixels, so a blank background cannot pass as original art.
        if (Math.max(expected[s], expected[s + 1], expected[s + 2]) - Math.min(expected[s], expected[s + 1], expected[s + 2]) < 25) continue;
        const o = ((originY + y) * outputWidth + originX + x) * 4;
        samples++;
        if (Math.abs(data[o] - expected[s]) + Math.abs(data[o + 1] - expected[s + 1]) + Math.abs(data[o + 2] - expected[s + 2]) < 100) matched++;
      }
      return { artSamples: samples, artMatch: matched / Math.max(samples, 1) };
    }
    const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('No PNG decoder');
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<string>();
    for (let offset = 0; offset < data.length; offset += 64) colors.add(`${data[offset]},${data[offset + 1]},${data[offset + 2]},${data[offset + 3]}`);
    if (!art) return { colors: colors.size, artSamples: 0, artMatch: 1 };
    const original = new Image(); original.src = art.src; await original.decode();
    const source = document.createElement('canvas'); source.width = Math.round(art.width * 2); source.height = Math.round(art.height * 2);
    const sourceCtx = source.getContext('2d'); if (!sourceCtx) throw new Error('No original art decoder');
    sourceCtx.drawImage(original, 0, 0, source.width, source.height);
    const expected = sourceCtx.getImageData(0, 0, source.width, source.height).data;
    return { colors: colors.size, ...matchArt(expected, data, source.width, source.height, canvas.width, Math.round((art.x - box.x) * 2), Math.round((art.y - box.y) * 2)) };
  }, { encoded: bytes.toString('base64'), art, box });
  expect(pixels.colors).toBeGreaterThan(8);
  if (checkArt) { expect(pixels.artSamples).toBeGreaterThan(50); expect(pixels.artMatch).toBeGreaterThan(0.75); }
  await info.attach(name, { path, contentType: 'image/png' });
}

test('share the current second slide as a real PNG and keep the one unsent composer', async ({ page, api, cleanup, tag }, info) => {
  const id = await savedApp(api, cleanup, `Slide image ${tag}`, ['Unrelated saved record']);
  await page.goto(`/apps/${id}`);
  const composer = page.getByRole('combobox', { name: /^Message(?: input)?$/ });
  await expect(composer).toHaveCount(1);
  await composer.fill('Keep my unsent image idea');
  await page.getByRole('button', { name: 'Presentation', exact: true }).click();
  await page.getByRole('button', { name: 'Next slide', exact: true }).click();
  const { dialog, preview } = await openPreview(page);
  await expect(preview).toContainText('Second slide to share');
  await expect(preview).toContainText('Slide 2 of 2');
  await expect(preview).not.toContainText('First slide stays out');
  await expect(preview).not.toContainText('Unrelated saved record');
  await expect(preview).not.toContainText('Keep my unsent image idea');
  const clipping = await preview.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [element, ...element.querySelectorAll<HTMLElement>('*')].filter((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || node.scrollWidth > node.clientWidth + 1;
    }).map((node) => node.tagName);
  });
  expect(clipping, 'Every visible selected-slide element fits inside the image preview').toEqual([]);
  await downloadPng(page, dialog, preview, info, 'selected-second-slide');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(composer).toHaveCount(1);
  await expect(composer).toHaveText('Keep my unsent image idea');
});

test('an empty saved view downloads the original Bob art without losing its pixels', async ({ page, api, cleanup, tag }, info) => {
  const id = await savedApp(api, cleanup, `Empty image ${tag}`);
  await page.goto(`/apps/${id}`);
  const { dialog, preview } = await openPreview(page);
  await expect(preview).toContainText('Nothing here yet');
  await expect(preview.locator('img')).toHaveAttribute('src', '/brand/bob/bob-playful.webp');
  await downloadPng(page, dialog, preview, info, 'original-bob-empty-view', true);
});

test('an oversized saved view offers its complete JSON instead of a clipped image', async ({ page, api, cleanup, tag }, info) => {
  const id = await savedApp(api, cleanup, `Long image ${tag}`, Array.from({ length: 24 }, (_, index) => `Saved row ${index}: ${'A long saved sentence with readable words. '.repeat(45)}`), 'table');
  await page.goto(`/apps/${id}`);
  const { dialog, preview } = await openPreview(page);
  await dialog.getByRole('button', { name: 'Prepare image', exact: true }).click();
  await expect(dialog.getByText('This view is too large for one image. Export JSON to keep all its saved data.', { exact: true })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Export JSON', exact: true })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Download image', exact: true })).toHaveCount(0);
  const fallbackPath = info.outputPath('long-view-fallback.png');
  await dialog.screenshot({ path: fallbackPath });
  await info.attach('long-view-fallback', { path: fallbackPath, contentType: 'image/png' });
  await expect(preview).toContainText('Saved row 23:');
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error('JSON fallback did not download');
  const exported = JSON.parse(await readFile(path, 'utf8')) as { state: BobApp['state'] };
  expect(exported.state.items).toHaveLength(24);
});
