/**
 * Serves the built ui-v2 web UI when present. Development runs the Vite dev server
 * instead, so when the dist is not found this mounts nothing.
 */
import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RequestHandler } from 'express';
import express from 'express';

/** Hashed build output never changes under the same name, so it is cached for a year. */
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Walks up from `start` looking for a directory that owns `apps/ui-v2/dist/index.html`. */
function findDist(start: string): string | null {
  let dir = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'apps', 'ui-v2', 'dist');
    if (existsSync(join(candidate, 'index.html'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Resolves the built ui-v2 UI to serve. Returns null when the dist is not found.
 */
export function resolveUiDist(start = process.cwd()): string | null {
  return findDist(start);
}

function isExcluded(path: string): boolean {
  return path === '/health' || path === '/metrics' || path.startsWith('/api/') || path.startsWith('/v2/');
}

/** A request for a file (a hashed bundle, font, icon), as opposed to a client-side route. */
function isFileRequest(path: string): boolean {
  return path.startsWith('/assets/') || extname(path) !== '';
}

/** Shared by serving and diagnostics: filenames and client-side identifiers
 * never become trace names, and HEAD retains the existing pass-through policy. */
export function staticUiRouteTemplate(method: string, path: string): 'static_asset' | 'static_ui' | null {
  if (method !== 'GET' || isExcluded(path)) return null;
  return isFileRequest(path) ? 'static_asset' : 'static_ui';
}

/**
 * Serves dist statically, falling back to index.html for non-excluded GETs of
 * client-side routes. A missing file is a plain 404: answering it with
 * index.html (status 200, text/html) makes a tab on a previous build fail
 * with a MIME-type error on its old chunks instead of a real, detectable miss.
 */
export function createStaticUiHandler(distPath: string): RequestHandler {
  const root = resolve(distPath);
  const staticMiddleware = express.static(distPath, {
    setHeaders: (response, filePath) => {
      const relativePath = relative(root, filePath);
      if (relativePath === 'index.html') {
        response.setHeader('Cache-Control', 'no-cache');
      } else if (relativePath.split(sep)[0] === 'assets') response.setHeader('Cache-Control', IMMUTABLE_CACHE_CONTROL);
    },
  });
  const indexFile = isAbsolute(distPath) ? join(distPath, 'index.html') : resolve(distPath, 'index.html');
  return (request, response, next) => {
    const route = staticUiRouteTemplate(request.method, request.path);
    if (route === null) return next();
    const fallback = (error?: unknown): void => {
      if (error) return next(error);
      if (route === 'static_asset') {
        response.status(404).end();
        return;
      }
      response.setHeader('Cache-Control', 'no-cache');
      response.sendFile(indexFile);
    };
    staticMiddleware(request, response, fallback);
  };
}
