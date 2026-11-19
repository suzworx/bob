import { loadEnv, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

type ReleaseEnvironment = { BOB_WEB_RELEASE?: string; VERCEL_GIT_COMMIT_SHA?: string };

export function resolveFrontendRelease(environment: ReleaseEnvironment): string | undefined {
  const value = environment.BOB_WEB_RELEASE || environment.VERCEL_GIT_COMMIT_SHA;
  if (!value) return undefined;
  if (!/^(?:[0-9a-f]{7}|[0-9a-f]{40})$/.test(value)) {
    throw new Error('Invalid frontend release: BOB_WEB_RELEASE / VERCEL_GIT_COMMIT_SHA must be a lowercase 7- or 40-character Git SHA');
  }
  return value.slice(0, 7);
}

export function frontendReleaseHtml(html: string, release: string | undefined): string {
  if (!release) return html;
  return html.replace('</head>', `<meta name="bob-web-release" content="${release}">\n</head>`);
}

/** Only a public commit identifier is embedded; server environment files are never read. */
export function frontendReleasePlugin(): Plugin {
  let release: string | undefined;
  return {
    name: 'frontend-release-identity',
    config(config, environment) {
      const appDirectory = fileURLToPath(new URL('../', import.meta.url));
      const local = loadEnv(environment.mode, config.envDir ?? appDirectory, 'BOB_WEB_');
      release = resolveFrontendRelease({
        BOB_WEB_RELEASE: process.env.BOB_WEB_RELEASE ?? local.BOB_WEB_RELEASE,
        VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
      });
      return { define: { 'import.meta.env.BOB_WEB_RELEASE': JSON.stringify(release) ?? 'undefined' } };
    },
    transformIndexHtml: html => frontendReleaseHtml(html, release),
  };
}
