import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
describe('static hosting metadata', () => {
  it('provides Bob crawler metadata before JavaScript runs', () => {
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(document.title).toBe('Bob');
    expect(document.querySelectorAll('title')).toHaveLength(1);
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://app.heybob.xyz/');
    for (const [key, value] of Object.entries({ 'og:image': 'https://app.heybob.xyz/brand/bob/bob-playful.webp', 'og:image:type': 'image/webp', 'og:image:width': '480', 'og:image:height': '480', 'og:image:alt': 'Bob, a friendly little helper' })) {
      expect(document.querySelector(`meta[property="${key}"]`)?.getAttribute('content')).toBe(value);
    }
    expect(document.querySelector('meta[name="twitter:title"]')?.getAttribute('content')).toBe('Bob');
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('/brand/bob/icon.png');
    expect(document.querySelectorAll('link[rel="icon"]')).toHaveLength(1);
  });
});

// Evaluate the ordered hosting rules independently of the SPA router.
describe('static hosting routing', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
    installCommand: string; buildCommand: string; outputDirectory: string;
    routes: Array<{ src?: string; dest?: string; status?: number; handle?: string; continue?: boolean; headers?: Record<string, string> }>;
  };
  function route(path: string, exists = false): { dest?: string; status?: number; headers: Record<string, string> } {
    const headers: Record<string, string> = {};
    for (const rule of config.routes) {
      if (rule.handle === 'filesystem' && exists) return { dest: path, headers };
      const expression = new RegExp(`^${rule.src ?? '(?!)'}$`);
      if (!expression.test(path)) continue;
      Object.assign(headers, rule.headers);
      if (rule.continue) continue;
      const dest = rule.dest && path.replace(expression, rule.dest);
      return { dest, status: rule.status, headers };
    }
    return { headers };
  }
  it('installs the root lockfile and builds only the web workspace', () => {
    expect(config.installCommand).toBe('cd ../.. && npm ci');
    expect(config.buildCommand).toBe('npm run build');
    expect(config.outputDirectory).toBe('dist');
  });
  it('routes API requests directly to the API host without caching', () => {
    expect(route('/api/public-config')).toEqual({ dest: 'https://api.heybob.xyz/api/public-config', status: undefined, headers: { 'Cache-Control': 'no-store' } });
  });
  it('serves existing assets but never returns SPA HTML for missing assets', () => {
    expect(route('/assets/chat.js', true).dest).toBe('/assets/chat.js');
    for (const path of ['/assets/missing.js', '/vad/missing.wasm', '/brand/missing.webp', '/missing.css']) expect(route(path).status).toBe(404);
  });
  it('allows deep links and revalidates even direct index.html requests', () => {
    expect(route('/spaces/example/thread').dest).toBe('/index.html');
    expect(route('/index.html', true).headers['Cache-Control']).toBe('no-cache');
    expect(route('/c/example').headers['Cache-Control']).toBe('no-cache');
  });
});
