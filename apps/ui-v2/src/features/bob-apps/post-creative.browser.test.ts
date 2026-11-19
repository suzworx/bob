// jsdom has no canvas, so this runs the real renderer in Chromium with real art and Nunito, from a same-origin server.
// Skipped where no Chromium is installed. POST_CREATIVE_OUT=<dir> also saves the PNGs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { transformWithOxc } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as Renderer from './post-creative-render';
import { CREATIVE_BACKGROUND } from './post-creative-render';

const PAGE = '<!doctype html><style>@font-face{font-family:Nunito;font-weight:700;src:url(/nunito.woff2) format("woff2")}</style><script type="module">import * as renderer from "/render.js"; window.renderer = renderer;</script>';
const here = import.meta.dirname;
const brand = join(here, '../../../public/brand/bob');
const fontFile = createRequire(import.meta.url).resolve('@fontsource/nunito/files/nunito-latin-700-normal.woff2');
const SHORT = 'Meet Bob. He is small, kind, and always happy to help.';
const LONG = 'Bob remembers the little things so you do not have to. Ask him about your day, your plans, or the name of that song stuck in your head, and he will happily help, again and again and again, without ever once getting tired of it.';

type BobCheck = { differing: number; control: number; total: number; bob: Renderer.CreativeRect; png: string; lines: number };

describe.skipIf(!existsSync(chromium.executablePath()))('post creative in a real browser', () => {
  let browser: Browser;
  let page: Page;
  let server: Server;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    const source = (await transformWithOxc(readFileSync(join(here, 'post-creative-render.ts'), 'utf8'), 'post-creative-render.ts')).code;
    // A real server: the page is on localhost, and the same server on 127.0.0.1 is a real foreign origin with no CORS.
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://x').pathname;
      const [type, body] = path === '/' ? ['text/html', PAGE]
        : path === '/render.js' ? ['text/javascript', source]
          : path === '/nunito.woff2' ? ['font/woff2', readFileSync(fontFile)]
            : ['image/webp', readFileSync(join(brand, path))];
      response.writeHead(200, { 'content-type': type });
      response.end(body);
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    await page.goto(`http://localhost:${(server.address() as AddressInfo).port}/`);
  }, 60_000);
  afterAll(async () => { await browser?.close(); server?.close(); });

  const samples = [
    ['instagram', 'bob-helper.webp', SHORT],
    ['linkedin', 'bob-helper.webp', SHORT],
    ['instagram', 'bob-playful.webp', LONG],
    ['linkedin', 'bob-playful.webp', LONG],
  ] as const;
  for (const [channel, art, text] of samples) {
    it(`${channel} ${art}: the Bob region is pixel-identical to a direct draw of the art`, async () => {
      const result = await page.evaluate(async ({ channel, art, text, background }): Promise<BobCheck> => {
        const { renderer } = window as unknown as { renderer: typeof Renderer };
        const image = await renderer.loadCreativeArt(channel, text, `/${art}`);
        const canvas = document.createElement('canvas');
        const { bob, lines } = renderer.paintCreative(canvas, channel, text, image);
        const direct = (filter: string): Uint8ClampedArray => {
          const reference = document.createElement('canvas');
          reference.width = bob.width;
          reference.height = bob.height;
          const context = reference.getContext('2d') as CanvasRenderingContext2D;
          context.fillStyle = background;
          context.fillRect(0, 0, bob.width, bob.height);
          context.filter = filter;
          context.drawImage(image, 0, 0, bob.width, bob.height);
          return context.getImageData(0, 0, bob.width, bob.height).data;
        };
        const drawn = (canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(bob.x, bob.y, bob.width, bob.height).data;
        const count = (other: Uint8ClampedArray): number => drawn.reduce((sum, value, index) => sum + (value === other[index] ? 0 : 1), 0);
        return { differing: count(direct('none')), control: count(direct('saturate(1.1)')), total: drawn.length, bob, png: canvas.toDataURL('image/png'), lines: lines.length };
      }, { channel, art, text, background: CREATIVE_BACKGROUND });
      expect(result.differing).toBe(0);
      expect(result.control).toBeGreaterThan(1000); // The comparison can fail: a slight recolour is caught.
      expect(result.total).toBe(result.bob.width * result.bob.height * 4);
      expect(result.lines).toBeGreaterThan(0);
      const out = process.env.POST_CREATIVE_OUT;
      if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, `${channel}-${art.replace('.webp', '')}${text === LONG ? '-long' : ''}.png`), Buffer.from(result.png.split(',')[1] ?? '', 'base64'));
      }
    });
  }

  it('uses Nunito, not a fallback, and produces a named PNG of the exact size', async () => {
    const result = await page.evaluate(async () => {
      const { renderer } = window as unknown as { renderer: typeof Renderer };
      const canvas = document.createElement('canvas');
      renderer.paintCreative(canvas, 'linkedin', 'Hi', await renderer.loadCreativeArt('linkedin', 'Hi', '/bob-helper.webp'));
      const file = await renderer.canvasToPngFile(canvas, 'linkedin');
      const bitmap = await createImageBitmap(file);
      return { name: file.name, type: file.type, size: [bitmap.width, bitmap.height], faces: [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family) };
    });
    expect(result).toEqual({ name: 'bob-linkedin.png', type: 'image/png', size: [1200, 627], faces: ['Nunito'] });
  });

  it('fails on a missing font, cross-origin art without CORS and a tainted canvas', async () => {
    const elsewhere = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bob-helper.webp`;
    const result = await page.evaluate(async (elsewhere) => {
      const { renderer } = window as unknown as { renderer: typeof Renderer };
      const outcome = (work: () => Promise<unknown>): Promise<string> => work().then(() => 'ok', (error: Error) => error.name);
      const crossOrigin = await outcome(() => renderer.loadCreativeArt('instagram', 'Hi', elsewhere));
      const image = new Image();
      image.src = elsewhere;
      await image.decode();
      const canvas = document.createElement('canvas');
      (canvas.getContext('2d') as CanvasRenderingContext2D).drawImage(image, 0, 0);
      const tainted = await outcome(() => renderer.canvasToPngFile(canvas, 'instagram'));
      document.querySelector('style')?.remove();
      const noFont = await outcome(() => renderer.loadCreativeArt('instagram', 'Hi', '/bob-helper.webp'));
      return { crossOrigin, tainted, noFont };
    }, elsewhere);
    expect(result.crossOrigin).not.toBe('ok');
    expect(result.tainted).toBe('SecurityError');
    expect(result.noFont).toBe('Error');
  });
});
