import routes from './ui-route-catalog.json';

const patterns = routes.filter((route) => route !== 'other').map((route) => ({
  route,
  pattern: new RegExp(`^${route.replace(/:[A-Za-z]+/g, '[^/]+')}$`),
}));

/**
 * Match only a fixed template; never return a path segment, query or fragment.
 * A space's /conversations URLs (IDS) report under the catalog's /threads
 * templates, which the server's route enum still names.
 */
export function uiRoute(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0] ?? '';
  const template = pathname.replace(/^(\/spaces\/[^/]+)\/conversations(?=\/|$)/, '$1/threads');
  return patterns.find(({ pattern }) => pattern.test(template))?.route ?? 'other';
}
