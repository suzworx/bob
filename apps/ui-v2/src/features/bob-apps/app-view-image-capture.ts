export type ImageCaptureErrorCode =
  | 'too_large'
  | 'incomplete_asset'
  | 'aborted'
  | 'timeout'
  | 'invalid_output'
  | 'capture_failed';

export class ImageCaptureError extends Error {
  constructor(readonly code: ImageCaptureErrorCode) {
    super(code);
    this.name = 'ImageCaptureError';
  }
}

export interface AppViewImage {
  blob: Blob;
  width: number;
  height: number;
}

interface CaptureState {
  error?: ImageCaptureError;
  canvases: Set<HTMLCanvasElement>;
  finishFrame?: () => void;
}

interface CaptureSize {
  width: number;
  height: number;
}

function checkActive(state: CaptureState): void {
  if (state.error) throw state.error;
}

function release(canvas: HTMLCanvasElement | undefined): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function isScreenReaderOnly(node: HTMLElement): boolean {
  const style = getComputedStyle(node);
  return style.position === 'absolute'
    && style.width === '1px'
    && style.height === '1px'
    && style.overflow === 'hidden'
    && style.clip.replace(/\s|px/g, '') === 'rect(0,0,0,0)';
}

function measure(element: HTMLElement): CaptureSize {
  const box = element.getBoundingClientRect();
  const width = Math.round(box.width * 2);
  const height = Math.round(box.height * 2);
  if (!Number.isFinite(width + height) || width <= 0 || height <= 0 || width > 8192 || height > 8192 || width * height > 8_000_000) {
    throw new ImageCaptureError('too_large');
  }
  const nodes = [element, ...element.querySelectorAll<HTMLElement>('*')];
  if (nodes.some((node) => node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1 && (node === element || !isScreenReaderOnly(node)))) {
    throw new ImageCaptureError('too_large');
  }
  return { width, height };
}

function isApprovedArt(image: HTMLImageElement): boolean {
  const url = new URL(image.currentSrc || image.src, window.location.href);
  return url.origin === window.location.origin && /^\/brand\/bob\/[a-z0-9-]+\.(webp|png)$/.test(url.pathname) && !url.search;
}

async function readyResources(element: HTMLElement, state: CaptureState): Promise<HTMLImageElement[]> {
  await document.fonts.ready;
  checkActive(state);
  const font = getComputedStyle(element).font || '16px Nunito';
  if (!document.fonts.check(font) || [...document.fonts].some((face) => face.status === 'error')) {
    throw new ImageCaptureError('incomplete_asset');
  }
  const images = [...element.querySelectorAll<HTMLImageElement>('img')];
  for (const image of images) {
    if (!isApprovedArt(image)) throw new ImageCaptureError('incomplete_asset');
    try {
      await image.decode();
    } catch {
      throw new ImageCaptureError('incomplete_asset');
    }
    checkActive(state);
    if (!image.complete || !image.naturalWidth || !image.naturalHeight) throw new ImageCaptureError('incomplete_asset');
  }
  return images;
}

function background(element: HTMLElement): string {
  let node: HTMLElement | null = element;
  while (node) {
    const color = getComputedStyle(node).backgroundColor;
    if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color;
    node = node.parentElement;
  }
  return 'white';
}

function validateDimensions(canvas: HTMLCanvasElement, size: CaptureSize): void {
  if (canvas.width !== size.width || canvas.height !== size.height) throw new ImageCaptureError('invalid_output');
}

function validateEmbeddedFonts(css: string): void {
  const urls = [...css.matchAll(/url\(([^)]*)\)/g)];
  const valid = urls.every((match) => {
    const url = match[1].trim().replace(/^["']|["']$/g, '');
    return /^data:(?:font\/[^;,]+|application\/[^;,]+);base64,[a-zA-Z0-9+/=]+$/.test(url);
  });
  if (!css.includes('@font-face') || urls.length === 0 || !valid) throw new ImageCaptureError('incomplete_asset');
}

function matchesArt(source: Uint8ClampedArray, output: Uint8ClampedArray): boolean {
  let sampled = 0;
  let matched = 0;
  // Sample opaque, colored pixels from the original decoded art, never a hand-drawn replacement.
  for (let index = 0; index < source.length; index += 16) {
    const red = source[index];
    const green = source[index + 1];
    const blue = source[index + 2];
    if (source[index + 3] < 220 || Math.max(red, green, blue) - Math.min(red, green, blue) < 20) continue;
    sampled += 1;
    const difference = Math.abs(red - output[index]) + Math.abs(green - output[index + 1]) + Math.abs(blue - output[index + 2]);
    if (difference < 120 && output[index + 3] > 200) matched += 1;
  }
  return sampled > 10 && matched / sampled > 0.7;
}

function validateArt(element: HTMLElement, images: HTMLImageElement[], canvas: HTMLCanvasElement): void {
  const root = element.getBoundingClientRect();
  const output = canvas.getContext('2d');
  if (!output) throw new ImageCaptureError('invalid_output');
  for (const image of images) {
    const box = image.getBoundingClientRect();
    const width = Math.round(box.width * 2);
    const height = Math.round(box.height * 2);
    const x = Math.round((box.x - root.x) * 2);
    const y = Math.round((box.y - root.y) * 2);
    if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > canvas.width || y + height > canvas.height) throw new ImageCaptureError('incomplete_asset');
    const reference = document.createElement('canvas');
    try {
      reference.width = width;
      reference.height = height;
      const context = reference.getContext('2d');
      if (!context) throw new ImageCaptureError('incomplete_asset');
      context.drawImage(image, 0, 0, width, height);
      if (!matchesArt(context.getImageData(0, 0, width, height).data, output.getImageData(x, y, width, height).data)) throw new ImageCaptureError('incomplete_asset');
    } finally {
      release(reference);
    }
  }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob || blob.type !== 'image/png' || blob.size === 0) reject(new ImageCaptureError('invalid_output'));
      else resolve(blob);
    }, 'image/png');
  });
}

async function render(element: HTMLElement, state: CaptureState): Promise<AppViewImage> {
  checkActive(state);
  measure(element);
  const images = await readyResources(element, state);
  checkActive(state);
  const { toCanvas, getFontEmbedCSS } = await import('html-to-image');
  checkActive(state);
  const size = measure(element);
  const resourceOptions = {
    pixelRatio: 2,
    skipAutoScale: true,
    backgroundColor: background(element),
    includeQueryParams: true,
    // The library globally caches failed resource fetches. Public fonts/art finish loading
    // after caller cancellation; only their resulting canvases are discarded.
    fetchRequestInit: { credentials: 'omit' as const, referrerPolicy: 'no-referrer' as const },
  };
  const fontEmbedCSS = await getFontEmbedCSS(element, resourceOptions);
  checkActive(state);
  validateEmbeddedFonts(fontEmbedCSS);
  const options = { ...resourceOptions, fontEmbedCSS };
  let first: HTMLCanvasElement | undefined;
  let final: HTMLCanvasElement | undefined;
  const capture = async (): Promise<HTMLCanvasElement> => {
    const canvas = await toCanvas(element, options);
    if (state.error) {
      release(canvas);
      throw state.error;
    }
    state.canvases.add(canvas);
    return canvas;
  };
  try {
    first = await capture();
    validateDimensions(first, size);
    await new Promise<void>((resolve) => {
      const frame = requestAnimationFrame(() => { state.finishFrame = undefined; resolve(); });
      state.finishFrame = () => { cancelAnimationFrame(frame); resolve(); };
    });
    checkActive(state);
    const current = measure(element);
    if (current.width !== size.width || current.height !== size.height) throw new ImageCaptureError('invalid_output');
    final = await capture();
    validateDimensions(final, size);
    validateArt(element, images, final);
    const blob = await toBlob(final);
    checkActive(state);
    return { blob, ...size };
  } finally {
    release(first);
    release(final);
    state.canvases.clear();
  }
}

export async function captureAppViewImage(
  element: HTMLElement,
  { signal }: { signal?: AbortSignal } = {},
): Promise<AppViewImage> {
  const state: CaptureState = { canvases: new Set() };
  let cancel: (code: 'aborted' | 'timeout') => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    cancel = (code) => {
      state.error = new ImageCaptureError(code);
      for (const canvas of state.canvases) release(canvas);
      state.canvases.clear();
      state.finishFrame?.();
      reject(state.error);
    };
  });
  const abort = (): void => cancel('aborted');
  const timer = setTimeout(() => cancel('timeout'), 8000);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    // DOM cloning cannot be interrupted. Race rejects promptly; render discards late canvases.
    return await Promise.race([interrupted, render(element, state)]);
  } catch (error) {
    if (error instanceof ImageCaptureError) throw error;
    throw new ImageCaptureError('capture_failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
