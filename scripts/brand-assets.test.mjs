import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The brand rasters are regenerated with tools CI does not have (sips, ImageMagick), so this reads the
// committed bytes directly and fails a wrong-sized, empty or truncated file before it can reach main.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_BYTES = 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const TOUCH_ICON = 'apps/ui-v2/public/apple-touch-icon.png';
const FAVICON_ICO = 'apps/ui-v2/public/favicon.ico';
const APP_ICON = 'apps/mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png';
const SPLASH_DIR = 'apps/mobile/ios/App/App/Assets.xcassets/Splash.imageset';

const splash = (await readdir(join(root, SPLASH_DIR)))
  .filter((name) => name.endsWith('.png'))
  .sort()
  .map((name) => `${SPLASH_DIR}/${name}`);

const read = (rel) => readFile(join(root, rel));

// A PNG is the 8-byte magic, then the IHDR chunk (4-byte length, "IHDR"), so its width and height are
// big-endian uint32s at byte offsets 16 and 20.
function pngSize(bytes) {
  expect(bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_MAGIC), 'starts with the PNG magic and an IHDR').toBe(true);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// An ICO starts with an ICONDIR: reserved uint16 (0), type uint16 (1 = icon), then the image count as a
// little-endian uint16 at offset 4. Each 16-byte ICONDIRENTRY follows from offset 6, with its payload size
// (uint32 LE) at +8 and payload offset (uint32 LE) at +12.
function icoDirectory(bytes) {
  const isIcon = bytes.length >= 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1;
  expect(isIcon, 'starts with an ICONDIR header').toBe(true);
  const frames = bytes.readUInt16LE(4);
  const entries = Array.from({ length: frames }, (_, i) => 6 + i * 16);
  const dirFits = 6 + frames * 16 <= bytes.length;
  expect(dirFits, 'has every ICONDIRENTRY it declares').toBe(true);
  const end = Math.max(0, ...entries.map((e) => bytes.readUInt32LE(e + 12) + bytes.readUInt32LE(e + 8)));
  return { frames, end };
}

describe('brand rasters', () => {
  it('ships exactly three splash PNGs', () => {
    expect(splash, `${SPLASH_DIR} PNG list`).toHaveLength(3);
  });

  for (const [rel, px] of [[TOUCH_ICON, 180], [APP_ICON, 1024], ...splash.map((s) => [s, 2732])]) {
    it(`${rel} is ${px}x${px}`, async () => {
      expect(pngSize(await read(rel)), `${rel} dimensions`).toEqual({ width: px, height: px });
    });
  }

  it(`${FAVICON_ICO} holds exactly 3 frames`, async () => {
    expect(icoDirectory(await read(FAVICON_ICO)).frames, `${FAVICON_ICO} frame count`).toBe(3);
  });

  // A frame that claims bytes past the end of the file means the write was cut short.
  it(`${FAVICON_ICO} is not truncated`, async () => {
    const bytes = await read(FAVICON_ICO);
    expect(icoDirectory(bytes).end, `${FAVICON_ICO} last frame end`).toBeLessThanOrEqual(bytes.length);
  });

  for (const rel of [TOUCH_ICON, FAVICON_ICO, APP_ICON, ...splash]) {
    it(`${rel} is larger than 1 KB`, async () => {
      expect((await read(rel)).length, `${rel} size in bytes`).toBeGreaterThan(MIN_BYTES);
    });
  }
});
