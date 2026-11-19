import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createHttpRouteInventory } from '../../src/platform/observability/http-route-inventory.ts';

describe('registered HTTP route inventory', () => {
  it('resolves a mounted route before its middleware executes without exporting path values', () => {
    const app = express();
    const inventory = createHttpRouteInventory(app);
    app.use('/api', (_request, response) => response.status(401).end());
    const devices = express.Router();
    devices.patch('/:id/settings', (_request, response) => response.end());
    app.use('/api/devices', devices);
    app.get('/health', (_request, response) => response.end());

    expect(inventory.routes()).toEqual([
      { method: 'PATCH', path: '/api/devices/:id/settings' },
      { method: 'GET', path: '/health' },
    ]);
    expect(inventory.resolve('PATCH', '/api/devices/private-id/settings')).toBe('/api/devices/:id/settings');
    expect(inventory.resolve('GET', '/api/devices/private-id/settings')).toBe('unmatched');
    expect(inventory.resolve('GET', '/private-email@example.com')).toBe('unmatched');
  });

  it('resolves implicit HEAD in registration order and preflight OPTIONS', () => {
    const app = express();
    const inventory = createHttpRouteInventory(app);
    app.get('/api/items/:id', (_request, response) => response.end());
    app.head('/api/items/:itemId', (_request, response) => response.end());
    app.post('/api/submit/:id', (_request, response) => response.end());
    app.get('/health', (_request, response) => response.end());
    expect(inventory.resolve('HEAD', '/api/items/private-id')).toBe('/api/items/:id');
    expect(inventory.resolve('HEAD', '/health')).toBe('/health');
    expect(inventory.resolve('OPTIONS', '/api/submit/private-id')).toBe('/api/submit/:id');
    expect(inventory.resolve('OPTIONS', '/absent')).toBe('unmatched');
    expect(inventory.resolve('POST', '/health')).toBe('unmatched');
  });

  it('matches mounted alternatives using Express case, slash and encoded-parameter behavior', () => {
    const app = express();
    const inventory = createHttpRouteInventory(app);
    const router = express.Router();
    router.get(['/items/:id', '/entries/:id'], (_request, response) => response.end());
    app.use(['/api', '/legacy'], router);
    expect(inventory.routes()).toHaveLength(4);
    expect(inventory.resolve('GET', '/API/items/private%2Fid/')).toBe('/api/items/:id');
    expect(inventory.resolve('GET', '/legacy/entries/private')).toBe('/legacy/entries/:id');
    expect(inventory.resolve('GET', '/api/items/%E0%A4%A')).toBe('unmatched');
  });

  it('rejects undiscoverable nested mount templates instead of silently losing routes', () => {
    const app = express();
    const inventory = createHttpRouteInventory(app);
    const parent = express.Router();
    const child = express.Router();
    child.get('/:id', (_request, response) => response.end());
    parent.use('/children', child);
    app.use('/api', parent);
    expect(() => inventory.routes()).toThrow('mounted before its path was registered');
  });

  it('does not register synthetic routes during discovery or resolution', () => {
    const app = express();
    const inventory = createHttpRouteInventory(app);
    app.get('/api/items/:id', (_request, response) => response.end());
    const prototype = (express.Router as unknown as { prototype: { route: (...args: unknown[]) => unknown } }).prototype;
    const register = vi.spyOn(prototype, 'route');
    try {
      inventory.routes();
      expect(inventory.resolve('GET', '/api/items/private-id')).toBe('/api/items/:id');
      expect(register).not.toHaveBeenCalled();
    } finally { register.mockRestore(); }
  });
});
