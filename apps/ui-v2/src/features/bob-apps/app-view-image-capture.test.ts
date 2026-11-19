import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureAppViewImage, ImageCaptureError } from './app-view-image-capture';

const raster = vi.hoisted(() => ({ toCanvas: vi.fn(), getFontEmbedCSS: vi.fn() }));
vi.mock('html-to-image', () => raster);
const EMBEDDED_FONT = '@font-face { font-family: "Nunito"; src: url(data:font/woff2;base64,d09GMg==) format("woff2"); }';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function canvas(width = 400, height = 200, blob: Blob | null = new Blob(['png'], { type: 'image/png' })): HTMLCanvasElement {
  const result = document.createElement('canvas');
  result.width = width;
  result.height = height;
  Object.defineProperty(result, 'toBlob', { value: vi.fn((done: BlobCallback) => done(blob)) });
  Object.defineProperty(result, 'getContext', { value: vi.fn(() => ({
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(width * height * 4), width, height })),
  })) });
  return result;
}

function view(width = 200, height = 100, scrollWidth = width): HTMLElement {
  const result = document.createElement('section');
  result.textContent = 'A saved view';
  result.getBoundingClientRect = () => ({ width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) });
  Object.defineProperties(result, { scrollWidth: { value: scrollWidth }, scrollHeight: { value: height }, clientWidth: { value: width }, clientHeight: { value: height } });
  document.body.append(result);
  return result;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function frame(): Promise<void> {
  await settle();
  await vi.advanceTimersByTimeAsync(20);
}

describe('captureAppViewImage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    raster.toCanvas.mockReset();
    raster.getFontEmbedCSS.mockReset();
    raster.getFontEmbedCSS.mockResolvedValue(EMBEDDED_FONT);
    raster.toCanvas.mockImplementation(async () => canvas());
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve(), status: 'loaded', check: () => true, [Symbol.iterator]: function* () {} } });
  });

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); });

  it('uses bounded error messages without including source content', () => {
    const error = new ImageCaptureError('too_large');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('too_large');
  });

  it.each([[4097, 100], [2000, 1001], [0, 100]])('refuses unsafe %i by %i geometry before raster dispatch', async (width, height) => {
    await expect(captureAppViewImage(view(width, height))).rejects.toMatchObject({ code: 'too_large' });
    expect(raster.toCanvas).not.toHaveBeenCalled();
  });

  it('refuses horizontally clipped content before raster dispatch', async () => {
    await expect(captureAppViewImage(view(200, 100, 400))).rejects.toMatchObject({ code: 'too_large' });
    expect(raster.toCanvas).not.toHaveBeenCalled();
  });

  it('allows Astryx screen-reader-only checkbox labels without treating them as clipped view data', async () => {
    const node = view();
    const label = document.createElement('label');
    label.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0px, 0px, 0px, 0px)';
    Object.defineProperties(label, { clientWidth: { value: 1 }, scrollWidth: { value: 155 } });
    node.append(label);
    const result = captureAppViewImage(node);
    void result.catch(() => {});
    await frame();
    await expect(result).resolves.toMatchObject({ width: 400, height: 200 });
  });

  it('continues refusing visible clipped descendants with the same small geometry', async () => {
    const node = view();
    const child = document.createElement('div');
    child.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden';
    Object.defineProperties(child, { clientWidth: { value: 1 }, scrollWidth: { value: 155 } });
    node.append(child);
    await expect(captureAppViewImage(node)).rejects.toMatchObject({ code: 'too_large' });
    expect(raster.toCanvas).not.toHaveBeenCalled();
  });

  it('returns only the second serial render at double resolution and releases both canvases', async () => {
    const first = deferred<HTMLCanvasElement>();
    const discarded = canvas();
    const finalBlob = new Blob(['second'], { type: 'image/png' });
    const final = canvas(400, 200, finalBlob);
    raster.toCanvas.mockReturnValueOnce(first.promise).mockResolvedValueOnce(final);
    const result = captureAppViewImage(view());
    void result.catch(() => {});
    await settle();
    expect(raster.toCanvas).toHaveBeenCalledTimes(1);
    first.resolve(discarded);
    await frame();
    expect(await result).toEqual({ blob: finalBlob, width: 400, height: 200 });
    expect(raster.toCanvas).toHaveBeenCalledTimes(2);
    expect(raster.toCanvas).toHaveBeenNthCalledWith(2, expect.any(HTMLElement), expect.objectContaining({ pixelRatio: 2, skipAutoScale: true }));
    expect(discarded.width * discarded.height).toBe(0);
    expect(final.width * final.height).toBe(0);
  });

  it('waits for required fonts before dispatching either render', async () => {
    const fonts = deferred<void>();
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: fonts.promise, check: () => true, [Symbol.iterator]: function* () {} } });
    const result = captureAppViewImage(view());
    void result.catch(() => {});
    await settle();
    expect(raster.toCanvas).not.toHaveBeenCalled();
    fonts.resolve();
    await frame();
    await expect(result).resolves.toMatchObject({ width: 400, height: 200 });
  });

  it('rejects failed required fonts rather than silently exporting fallback text', async () => {
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve(), check: () => false, [Symbol.iterator]: function* () { yield { status: 'error' }; } } });
    await expect(captureAppViewImage(view())).rejects.toMatchObject({ code: 'incomplete_asset' });
    expect(raster.toCanvas).not.toHaveBeenCalled();
  });

  it.each([
    ['empty font CSS', ''],
    ['empty embedded URL', '@font-face { font-family: "Nunito"; src: url("") format("woff2"); }'],
    ['unembedded remote font', '@font-face { font-family: "Nunito"; src: url(https://public.example/font.woff2) format("woff2"); }'],
  ])('refuses %s from font embedding before either raster dispatch', async (_name, fontCSS) => {
    raster.getFontEmbedCSS.mockResolvedValue(fontCSS);
    const rejected = expect(captureAppViewImage(view())).rejects.toMatchObject({ code: 'incomplete_asset' });
    void rejected.catch(() => {});
    await frame();
    await rejected;
    expect(raster.toCanvas).not.toHaveBeenCalled();
  });

  it('uses one verified embedded font stylesheet for both raster passes', async () => {
    const result = captureAppViewImage(view());
    void result.catch(() => {});
    await frame();
    await result;
    expect(raster.getFontEmbedCSS).toHaveBeenCalledTimes(1);
    expect(raster.toCanvas).toHaveBeenNthCalledWith(1, expect.any(HTMLElement), expect.objectContaining({ fontEmbedCSS: EMBEDDED_FONT }));
    expect(raster.toCanvas).toHaveBeenNthCalledWith(2, expect.any(HTMLElement), expect.objectContaining({ fontEmbedCSS: EMBEDDED_FONT }));
  });

  it('refuses an undecodable required image without leaking its URL', async () => {
    const node = view();
    const image = document.createElement('img');
    image.src = '/brand/bob/bob-playful.webp';
    image.decode = vi.fn().mockRejectedValue(new Error('private resource URL'));
    node.append(image);
    await expect(captureAppViewImage(node)).rejects.toMatchObject({ code: 'incomplete_asset', message: 'incomplete_asset' });
    expect(raster.toCanvas).not.toHaveBeenCalled();
  });

  it('rejects an already aborted request before raster dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(captureAppViewImage(view(), { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(raster.toCanvas).not.toHaveBeenCalled();
  });

  it('refuses a blank final canvas when required original Bob art decoded in the source', async () => {
    const pixels = new Uint8ClampedArray(200 * 200 * 4);
    for (let index = 0; index < pixels.length; index += 4) pixels.set([200, 120, 50, 255], index);
    // Source-only sampling is controlled here; output raster canvases remain fully blank.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(), getImageData: () => ({ data: pixels }),
    } as unknown as CanvasRenderingContext2D);
    const node = view();
    const image = document.createElement('img');
    image.src = '/brand/bob/bob-playful.webp';
    image.decode = vi.fn().mockResolvedValue(undefined);
    Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 100 }, naturalHeight: { value: 100 } });
    image.getBoundingClientRect = () => ({ width: 100, height: 100, x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 100, toJSON: () => ({}) });
    node.append(image);
    const rejected = expect(captureAppViewImage(node)).rejects.toMatchObject({ code: 'incomplete_asset' });
    void rejected.catch(() => {});
    await frame();
    await rejected;
  });

  it('aborts promptly while native raster work is pending and disposes its late canvas', async () => {
    const native = deferred<HTMLCanvasElement>();
    raster.toCanvas.mockReturnValue(native.promise);
    const controller = new AbortController();
    const result = captureAppViewImage(view(), { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ code: 'aborted' });
    void rejected.catch(() => {});
    await settle();
    controller.abort();
    await rejected;
    const late = canvas();
    native.resolve(late);
    await settle();
    expect(raster.toCanvas).toHaveBeenCalledTimes(1);
    const options = raster.toCanvas.mock.calls[0]?.[1] as { fetchRequestInit: RequestInit };
    // Aborting globally cached public fetches poisons retries; caller abort still wins.
    expect(options.fetchRequestInit.signal).toBeUndefined();
    expect(late.width * late.height).toBe(0);
  });

  it('ends preparation at eight seconds when a required font never settles', async () => {
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: new Promise<void>(() => {}), check: () => true, [Symbol.iterator]: function* () {} } });
    const result = captureAppViewImage(view());
    const rejected = expect(result).rejects.toMatchObject({ code: 'timeout' });
    void rejected.catch(() => {});
    await vi.advanceTimersByTimeAsync(8000);
    await rejected;
    expect(raster.toCanvas).not.toHaveBeenCalled();
  });

  it('releases the first canvas immediately when cancellation interrupts the second native render', async () => {
    const first = canvas();
    const second = deferred<HTMLCanvasElement>();
    raster.toCanvas.mockResolvedValueOnce(first).mockReturnValueOnce(second.promise);
    const controller = new AbortController();
    const result = captureAppViewImage(view(), { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ code: 'aborted' });
    void rejected.catch(() => {});
    await frame();
    expect(raster.toCanvas).toHaveBeenCalledTimes(2);
    controller.abort();
    await rejected;
    expect(first.width * first.height).toBe(0);
    const late = canvas();
    second.resolve(late);
    await settle();
    expect(late.width * late.height).toBe(0);
  });

  it.each(['wrong dimensions', 'null blob'] as const)('refuses %s from the final render and releases canvases', async (failure) => {
    const first = canvas();
    const final = failure === 'wrong dimensions' ? canvas(399, 200) : canvas(400, 200, null);
    raster.toCanvas.mockResolvedValueOnce(first).mockResolvedValueOnce(final);
    const rejected = expect(captureAppViewImage(view())).rejects.toMatchObject({ code: 'invalid_output' });
    void rejected.catch(() => {});
    await frame();
    await rejected;
    expect(first.width * first.height).toBe(0);
    expect(final.width * final.height).toBe(0);
  });
});
