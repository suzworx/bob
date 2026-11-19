import { describe, expect, it, vi } from 'vitest';
import { CREATIVE_SPECS, chooseDelivery, layoutCreative, shareFile, wrapCaption } from './post-creative-render';

const measure = (text: string): number => Array.from(text).length * 10;
const file = new File(['png'], 'bob-instagram.png', { type: 'image/png' });
const art = { width: 480, height: 470 };

describe('wrapCaption', () => {
  it('wraps on spaces and collapses whitespace', () => {
    expect(wrapCaption('  one two\n\nthree   four ', 90, 3, measure)).toEqual(['one two', 'three', 'four']);
  });
  it('keeps text that fits exactly, with no ellipsis', () => {
    expect(wrapCaption('one two', 70, 1, measure)).toEqual(['one two']);
  });
  it('ends a cut caption with an ellipsis inside the width', () => {
    const lines = wrapCaption('one two three four five six', 70, 2, measure);
    expect(lines).toEqual(['one two', 'three…']);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(70);
  });
  it('makes room for the ellipsis on a full last line', () => {
    expect(wrapCaption('abcdefg hijklmn', 70, 1, measure)).toEqual(['abcdef…']);
  });
  it('breaks a word too long for a line, and never splits an emoji', () => {
    expect(wrapCaption('abcdefghij', 40, 3, measure)).toEqual(['abcd', 'efgh', 'ij']);
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const lines = wrapCaption(family.repeat(3), 50, 9, (text) => Array.from(new Intl.Segmenter().segment(text)).length * 20);
    expect(lines).toEqual([family.repeat(2), family]);
  });
  it('ends when one glyph is wider than the line', () => {
    expect(wrapCaption('abc', 5, 9, measure)).toEqual(['a', 'b', 'c']);
  });
  it('gives no lines for empty text', () => {
    expect(wrapCaption(' \n ', 70, 2, measure)).toEqual([]);
  });
});

describe('layoutCreative', () => {
  const long = 'word '.repeat(400);
  for (const channel of ['instagram', 'linkedin'] as const) {
    it(`${channel}: exact size, Bob native and whole-pixel, text inside and clear of him`, () => {
      const layout = layoutCreative(channel, long, art, measure);
      const spec = CREATIVE_SPECS[channel];
      expect([layout.width, layout.height]).toEqual([spec.width, spec.height]);
      expect([layout.bob.width, layout.bob.height]).toEqual([480, 470]);
      expect(Number.isInteger(layout.bob.x) && Number.isInteger(layout.bob.y)).toBe(true);
      expect(layout.lines).toHaveLength(spec.maxLines);
      expect(layout.lines.at(-1)?.text.endsWith('…')).toBe(true);
      for (const line of layout.lines) {
        expect(line.y).toBeGreaterThanOrEqual(spec.margin);
        expect(line.y + spec.lineHeight).toBeLessThanOrEqual(spec.height - spec.margin);
        if (channel === 'instagram') expect(line.y).toBeGreaterThanOrEqual(layout.bob.y + layout.bob.height);
        else expect(line.x + measure(line.text)).toBeLessThanOrEqual(layout.bob.x);
      }
    });
    it(`${channel}: never upscales small art, shrinks big art with its aspect kept`, () => {
      expect(layoutCreative(channel, 'hi', { width: 100, height: 50 }, measure).bob).toMatchObject({ width: 100, height: 50 });
      const big = layoutCreative(channel, 'hi', { width: 2000, height: 2000 }, measure).bob;
      expect(big.width).toBe(big.height);
      expect(big.y + big.height).toBeLessThanOrEqual(CREATIVE_SPECS[channel].height);
    });
    it(`${channel}: centres Bob when there is no caption`, () => {
      const layout = layoutCreative(channel, '', art, measure);
      expect(layout.lines).toEqual([]);
      expect(layout.bob.x).toBe((layout.width - 480) / 2);
    });
  }
  it('refuses art with no size', () => {
    expect(() => layoutCreative('instagram', 'hi', { width: 0, height: 0 }, measure)).toThrow();
  });
});

describe('delivery', () => {
  const share = vi.fn(async () => undefined);
  it('shares only when the browser can share this file', () => {
    expect(chooseDelivery({ share, canShare: () => true }, file)).toBe('share');
    expect(chooseDelivery({ share, canShare: () => false }, file)).toBe('download');
    expect(chooseDelivery({ share }, file)).toBe('download');
    expect(chooseDelivery({ canShare: () => true }, file)).toBe('download');
    expect(chooseDelivery({}, file)).toBe('download');
  });
  it('tells a closed share sheet from a failure', async () => {
    expect(await shareFile({ share }, file)).toBe('done');
    expect(share).toHaveBeenCalledWith({ files: [file] });
    expect(await shareFile({ share: () => Promise.reject(new DOMException('closed', 'AbortError')) }, file)).toBe('cancelled');
    expect(await shareFile({ share: () => Promise.reject(new DOMException('no', 'NotAllowedError')) }, file)).toBe('failed');
  });
});
