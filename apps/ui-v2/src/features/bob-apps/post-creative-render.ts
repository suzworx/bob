// Draws a shareable post image on the device: no AI, no server, no cost. Bob's art is painted once, at
// no more than its own size, so the model-sheet rule holds: nothing about him is scaled up, recoloured or redrawn.
export type CreativeChannel = 'instagram' | 'linkedin';
export type CreativeRect = { x: number; y: number; width: number; height: number };
export type CreativeLayout = { width: number; height: number; bob: CreativeRect; font: string; align: CanvasTextAlign; lines: { text: string; x: number; y: number }[] };
type Measure = (text: string) => number;

/** heybob sky and ink, the same palette as the Bob theme in bob-theme.ts. */
export const CREATIVE_BACKGROUND = '#bbddf0';
const CREATIVE_INK = '#173e57';
const ELLIPSIS = '…';

export const CREATIVE_SPECS = {
  instagram: { width: 1080, height: 1080, margin: 72, gap: 48, font: '700 56px Nunito', lineHeight: 72, maxLines: 4 },
  linkedin: { width: 1200, height: 627, margin: 56, gap: 48, font: '700 48px Nunito', lineHeight: 62, maxLines: 6 },
} as const;

function graphemes(text: string): string[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment);
}

/** The longest start of `text` that fits; at least one grapheme, so wrapping always moves on. */
function longestFit(text: string, maxWidth: number, measure: Measure): string {
  const parts = graphemes(text);
  let fit = parts[0] ?? '';
  for (let end = 2; end <= parts.length && measure(parts.slice(0, end).join('')) <= maxWidth; end += 1) fit = parts.slice(0, end).join('');
  return fit;
}

function withEllipsis(line: string, maxWidth: number, measure: Measure): string {
  const parts = graphemes(line);
  for (let end = parts.length; end > 0; end -= 1) {
    const candidate = `${parts.slice(0, end).join('').trimEnd()}${ELLIPSIS}`;
    if (measure(candidate) <= maxWidth) return candidate;
  }
  return ELLIPSIS;
}

/** Wraps on spaces, breaks only a word too long for a line, and ends with an ellipsis when text is cut. */
export function wrapCaption(text: string, maxWidth: number, maxLines: number, measure: Measure): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (lines.length > maxLines) break;
    const joined = line ? `${line} ${word}` : word;
    if (measure(joined) <= maxWidth) { line = joined; continue; }
    if (line) lines.push(line);
    let rest = word;
    while (measure(rest) > maxWidth && lines.length <= maxLines) {
      const head = longestFit(rest, maxWidth, measure);
      lines.push(head);
      rest = rest.slice(head.length);
    }
    line = rest;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), withEllipsis(lines[maxLines - 1] ?? '', maxWidth, measure)];
}

/** Whole-pixel size for Bob inside a box: aspect kept, never scaled above the art's own size. */
function fitBob(art: { width: number; height: number }, boxWidth: number, boxHeight: number): { width: number; height: number } {
  if (art.width <= 0 || art.height <= 0) throw new Error('art has no size');
  const scale = Math.min(1, boxWidth / art.width, boxHeight / art.height);
  return { width: Math.round(art.width * scale), height: Math.round(art.height * scale) };
}

/** Pure: where everything goes. Instagram stacks Bob over a centred caption; LinkedIn puts the caption beside him. */
export function layoutCreative(channel: CreativeChannel, text: string, art: { width: number; height: number }, measure: Measure): CreativeLayout {
  const { width, height, margin, gap, font, lineHeight, maxLines } = CREATIVE_SPECS[channel];
  if (channel === 'instagram') {
    const size = fitBob(art, width - margin * 2, height - margin * 2 - gap - maxLines * lineHeight);
    const captions = wrapCaption(text, width - margin * 2, maxLines, measure);
    const content = size.height + (captions.length ? gap + captions.length * lineHeight : 0);
    const top = Math.round((height - content) / 2);
    const bob = { ...size, x: Math.round((width - size.width) / 2), y: top };
    const lines = captions.map((line, index) => ({ text: line, x: width / 2, y: top + size.height + gap + index * lineHeight }));
    return { width, height, bob, font, align: 'center', lines };
  }
  const size = fitBob(art, Math.round(width * 0.45), height - margin * 2);
  const captions = wrapCaption(text, width - margin * 2 - gap - size.width, maxLines, measure);
  const bob = { ...size, x: captions.length ? width - margin - size.width : Math.round((width - size.width) / 2), y: Math.round((height - size.height) / 2) };
  const top = Math.round((height - captions.length * lineHeight) / 2);
  return { width, height, bob, font, align: 'left', lines: captions.map((line, index) => ({ text: line, x: margin, y: top + index * lineHeight })) };
}

/** Waits for Nunito (no silent fallback font in a brand image) and the decoded art. */
export async function loadCreativeArt(channel: CreativeChannel, text: string, artUrl: string): Promise<HTMLImageElement> {
  const { font } = CREATIVE_SPECS[channel];
  const faces = await document.fonts.load(font, 'Bob');
  if (faces.length === 0) throw new Error('caption font unavailable');
  if (text) await document.fonts.load(font, text);
  const art = new Image();
  // A cross-origin image without CORS then fails here, instead of tainting the canvas later.
  art.crossOrigin = 'anonymous';
  art.src = artUrl;
  await art.decode();
  return art;
}

export function paintCreative(canvas: HTMLCanvasElement, channel: CreativeChannel, text: string, art: HTMLImageElement): CreativeLayout {
  canvas.width = CREATIVE_SPECS[channel].width;
  canvas.height = CREATIVE_SPECS[channel].height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas unavailable');
  context.font = CREATIVE_SPECS[channel].font;
  const layout = layoutCreative(channel, text, { width: art.naturalWidth, height: art.naturalHeight }, (line) => context.measureText(line).width);
  context.fillStyle = CREATIVE_BACKGROUND;
  context.fillRect(0, 0, layout.width, layout.height);
  context.drawImage(art, layout.bob.x, layout.bob.y, layout.bob.width, layout.bob.height);
  context.fillStyle = CREATIVE_INK;
  context.textAlign = layout.align;
  context.textBaseline = 'top';
  for (const line of layout.lines) context.fillText(line.text, line.x, line.y);
  return layout;
}

/** Rejects on a tainted canvas (toBlob throws SecurityError) as well as on a failed encode. */
export function canvasToPngFile(canvas: HTMLCanvasElement, channel: CreativeChannel): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(new File([blob], `bob-${channel}.png`, { type: 'image/png' }));
      else reject(new Error('image encode failed'));
    }, 'image/png');
  });
}

type ShareNavigator = { share?: (data: ShareData) => Promise<void>; canShare?: (data: ShareData) => boolean };

export function chooseDelivery(nav: ShareNavigator, file: File): 'share' | 'download' {
  return typeof nav.share === 'function' && nav.canShare?.({ files: [file] }) === true ? 'share' : 'download';
}

/** Closing the share sheet is a choice, not a failure. */
export async function shareFile(nav: ShareNavigator, file: File): Promise<'done' | 'cancelled' | 'failed'> {
  try {
    await nav.share?.({ files: [file] });
    return 'done';
  } catch (error) {
    return (error as { name?: unknown } | null)?.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}

export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
