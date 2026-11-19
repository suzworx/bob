import { defineConfig, type Plugin } from 'vite';
import { frontendReleasePlugin } from './scripts/frontend-release.ts';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { uiActionInstrumentation } from './scripts/ui-action-instrumentation.ts';

/**
 * The port the web dev server binds. It defaults to 5173 and is shared with
 * the development API proxy. Plain HTTP on localhost is a secure context.
 */
function resolveWebPort(): number {
  const value = process.env.BOB_WEB_PORT;
  if (value === undefined || value === '') return 5173;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid BOB_WEB_PORT "${value}": expected an integer between 1 and 65535`);
  }
  return port;
}

const webPort = resolveWebPort();
const proxy = {
  '/api': {
    target: 'http://localhost:7444',
    changeOrigin: true,
  },
};

const vadPublicDir = fileURLToPath(new URL('./public/vad', import.meta.url));
const VAD_CONTENT_TYPES: Record<string, string> = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};

/**
 * Dev-only: serve apps/ui-v2/public/vad/* verbatim, ahead of Vite's own
 * middlewares. Those files (the AudioWorklet bundle, the Silero ONNX model,
 * and the onnxruntime-web threaded-simd glue + wasm binary) are copied into
 * /public by scripts/copy-vad-assets.mjs and are meant to be served as-is —
 * production `vite build` + `vite preview` does exactly that and voice works.
 * But onnxruntime-web *dynamically imports* its own `.mjs` glue at runtime
 * (`import('/vad/ort-wasm-simd-threaded.mjs')`), and in dev that request gets
 * routed through Vite's import-analysis/transform pipeline (it arrives with a
 * `?import` query). Vite refuses to transform a /public asset as a module —
 * "should not be imported from source code" — and the request 500s, so
 * hands-free voice never loads under `npm run dev`. Because this hook
 * registers its middleware directly inside `configureServer` (instead of
 * returning a post-hook function), Vite installs it *before* its internal
 * middlewares, so it answers `/vad/*` on the way in and Vite's transform
 * pipeline never sees the request. `apply: 'serve'` plus the fact that
 * `configureServer` is never invoked for `vite build`/`vite preview` means
 * this cannot change what the production build serves — do not delete this
 * thinking it's dead code, and do not "fix" it by adding COOP/COEP headers or
 * moving the assets out of /public instead.
 */
function vadDevAssetsPlugin(): Plugin {
  return {
    name: 'bob-vad-dev-assets',
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        const pathname = req.url.split('?')[0];
        if (!pathname || !pathname.startsWith('/vad/')) return next();

        const relative = pathname.slice('/vad/'.length);
        if (!relative || relative.includes('/') || relative.includes('..')) return next();

        const filePath = normalize(join(vadPublicDir, relative));
        if (!filePath.startsWith(vadPublicDir) || !existsSync(filePath)) return next();

        try {
          const data = await readFile(filePath);
          res.setHeader('Content-Type', VAD_CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream');
          res.statusCode = 200;
          res.end(data);
        } catch {
          next();
        }
      });
    },
  };
}

// No StyleX plugin: Astryx ships pre-built JS and CSS (src/main.tsx imports the CSS).
export default defineConfig({
  plugins: [frontendReleasePlugin(), uiActionInstrumentation(), react(), vadDevAssetsPlugin()],
  resolve: {
    alias: {
      // Production React otherwise disables Profiler callbacks entirely.
      'react-dom/client': 'react-dom/profiling',
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    // keep one React for dev and production.
    dedupe: ['react', 'react-dom'],
  },
  // Production ships no source maps. The post-deploy job rebuilds the deployed commit with
  // BOB_SOURCEMAP=hidden (same JS, no sourceMappingURL comment) and uploads the maps to the RUM backend.
  build: { sourcemap: process.env.BOB_SOURCEMAP === 'hidden' ? 'hidden' : false },
  server: { port: webPort, host: '0.0.0.0', proxy },
  preview: { port: webPort, host: '0.0.0.0', proxy },
});
