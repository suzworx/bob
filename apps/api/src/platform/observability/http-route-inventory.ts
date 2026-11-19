import type { Express } from 'express';
import { getRouteSchemas, type RouteSchemas } from '../http/route.ts';

export interface HttpRoute {
  method: string;
  path: string;
}

export interface HttpRouteInventory {
  routes(): readonly HttpRoute[];
  documentedRoutes(): readonly (HttpRoute & { schemas?: RouteSchemas })[];
  resolve(method: string, path: string): string;
}

interface Layer {
  handle?: unknown;
  slash?: boolean;
  route?: { path: unknown; methods: Record<string, boolean>; stack: { handle: object }[] };
  matchers?: PathMatcher[];
}
type PathMatcher = (path: string) => false | { path: string };
type RegisteredRoute = HttpRoute & { matches: (path: string) => boolean; schemas?: RouteSchemas };

function object(value: unknown): Record<string, unknown> | undefined {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? value as Record<string, unknown> : undefined;
}

/** Express exposes route paths, but does not retain the mount path. Capture
 * that code-owned value at registration, before Express compiles its matcher.
 * WebSocketExpress wraps an Express application in its `app` property.
 */
function stack(value: unknown): Layer[] | undefined {
  const router = object(value);
  if (!router) return undefined;
  if (Array.isArray(router.stack)) return router.stack as Layer[];
  if (router.app && router.app !== value) return stack(router.app);
  if (router.router && router.router !== value) return stack(router.router);
  return undefined;
}

function paths(value: unknown): string[] {
  const values: unknown[] = Array.isArray(value) ? value : [value];
  if (!values.every((item): item is string => typeof item === 'string' && item.startsWith('/'))) {
    throw new Error('HTTP diagnostics requires registered string route templates');
  }
  return values as string[];
}

function recordMounts(app: Express, mounts: WeakMap<Layer, string[]>): void {
  const registrar = app as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ['use', 'useHTTP']) {
    const original = registrar[method];
    if (!original) continue;
    registrar[method] = function diagnosticMount(...args: unknown[]): unknown {
      const before = stack(app)?.length ?? 0;
      const first = args[0];
      const hasPath = typeof first === 'string' || first instanceof RegExp || Array.isArray(first);
      const result = original.apply(this, args);
      const added = stack(app)?.slice(before) ?? [];
      // Ordinary middleware has no nested routes and needs no mount annotation.
      for (const layer of added) {
        if (stack(layer.handle)) mounts.set(layer, paths(hasPath ? first : '/'));
      }
      return result;
    };
  }
}

function join(prefix: string, path: string): string {
  return `${prefix}${path === '/' && prefix ? '' : path}`;
}

function registeredMatcher(layer: Layer, index: number): PathMatcher {
  const match = layer.matchers?.[index];
  if (!match) throw new Error('HTTP diagnostics cannot inspect the installed Express matcher');
  return match;
}

/** Layer matchers are pure: unlike layer.match(), these do not modify live
 * params/path state. Consume mount prefixes as Express does, retaining each
 * router's case/strict settings and never returning the matched input values.
 */
function matchesRoute(matchers: PathMatcher[], incoming: string): boolean {
  let remaining = incoming;
  try {
    for (const match of matchers) {
      const result = match(remaining);
      if (!result) return false;
      remaining = remaining.slice(result.path.length) || '/';
    }
    return true;
  } catch { return false; }
}

function collect(layers: Layer[], mounts: WeakMap<Layer, string[]>, prefix = '', ancestors: PathMatcher[] = []): RegisteredRoute[] {
  return layers.flatMap((layer): RegisteredRoute[] => {
    if (layer.route) {
      const schemas = layer.route.stack.map(({ handle }) => getRouteSchemas(handle)).find((value) => value !== undefined);
      const methods = Object.entries(layer.route.methods).filter(([, enabled]) => enabled).map(([method]) => method === '_all' ? 'ALL' : method.toUpperCase());
      return paths(layer.route.path).flatMap((path, index) => {
        const matchers = [...ancestors, registeredMatcher(layer, index)];
        return methods.map((method) => ({ method, path: join(prefix, path), schemas, matches: (incoming: string) => matchesRoute(matchers, incoming) }));
      });
    }
    const nested = stack(layer.handle);
    if (!nested) return [];
    const registered = mounts.get(layer) ?? (layer.slash ? ['/'] : undefined);
    if (!registered) throw new Error('HTTP diagnostics found a router mounted before its path was registered');
    return registered.flatMap((path, index) => collect(nested, mounts, join(prefix, path === '/' ? '' : path),
      path === '/' ? ancestors : [...ancestors, registeredMatcher(layer, index)]));
  });
}

/** Install before mounting routes. The first lookup freezes the startup route
 * inventory; the server validates it before listening. Unsupported registrations
 * fail visibly instead of silently producing missing or high-cardinality labels.
 */
export function createHttpRouteInventory(app: Express, fallback: (method: string, path: string) => string = () => 'unmatched'): HttpRouteInventory {
  const mounts = new WeakMap<Layer, string[]>();
  recordMounts(app, mounts);
  let inventory: RegisteredRoute[] | undefined;
  const compiled = (): NonNullable<typeof inventory> => {
    inventory ??= collect(stack(app) ?? [], mounts);
    return inventory;
  };
  return {
    routes: () => compiled().map(({ method, path }) => ({ method, path })),
    documentedRoutes: () => compiled().map(({ method, path, schemas }) => ({ method, path, ...(schemas ? { schemas } : {}) })),
    resolve: (method, path) => {
      const match = compiled().find((route) =>
        (route.method === method || route.method === 'ALL' || (method === 'HEAD' && route.method === 'GET')) && route.matches(path));
      if (match) return match.path;
      if (method === 'OPTIONS') return compiled().find((route) => route.matches(path))?.path ?? 'unmatched';
      return fallback(method, path);
    },
  };
}
