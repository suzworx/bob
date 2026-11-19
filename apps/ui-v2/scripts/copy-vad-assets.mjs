import { copyFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(scriptDir, '..');
const outDir = join(appRoot, 'public', 'vad');

const vadWebRoot = dirname(require.resolve('@ricky0123/vad-web/package.json'));
const onnxDist = dirname(require.resolve('onnxruntime-web/wasm'));

// The exact files vad-web fetches at runtime (all same-origin under /vad/):
// - the AudioWorklet module (real-time-vad.js:36 workletFile)
// - the Silero ONNX model for model v5 (real-time-vad.js:37-41,355)
// - the onnxruntime-web threaded-simd ESM loader and its wasm binary
//   (ort.wasm.mjs importWasmModule -> "ort-wasm-simd-threaded.mjs",
//   locateFile -> prefix + "ort-wasm-simd-threaded.wasm")
const files = [
  [join(vadWebRoot, 'dist', 'vad.worklet.bundle.min.js'), 'vad.worklet.bundle.min.js'],
  [join(vadWebRoot, 'dist', 'silero_vad_v5.onnx'), 'silero_vad_v5.onnx'],
  [join(onnxDist, 'ort-wasm-simd-threaded.mjs'), 'ort-wasm-simd-threaded.mjs'],
  [join(onnxDist, 'ort-wasm-simd-threaded.wasm'), 'ort-wasm-simd-threaded.wasm'],
];

await mkdir(outDir, { recursive: true });

let totalBytes = 0;
for (const [src, name] of files) {
  await copyFile(src, join(outDir, name));
  const { size } = await stat(src);
  totalBytes += size;
  console.log(`copied ${name} (${size} bytes)`);
}
console.log(`public/vad total: ${totalBytes} bytes`);
