/**
 * #550: the web dev server the e2e suite starts. Identical to vite.config.ts
 * except that /api proxies to the suite's own API port (BOB_E2E_API_PORT),
 * because the base config always proxies to :7444, the everyday dev server
 * the suite must never touch. The web port still comes from BOB_WEB_PORT.
 */
import type { UserConfig } from 'vite';
import baseConfig from '../vite.config.ts';

/** The API port the suite's own stack listens on. */
function e2eApiPort(): number {
  const port = Number(process.env.BOB_E2E_API_PORT ?? '7454');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 7444) {
    throw new Error(`BOB_E2E_API_PORT must be a free port other than 7444 (got "${process.env.BOB_E2E_API_PORT}")`);
  }
  return port;
}

const target = `http://127.0.0.1:${e2eApiPort()}`;
const proxy = { '/api': { target, changeOrigin: true } };
const base = baseConfig as UserConfig;

const config: UserConfig = { ...base, server: { ...base.server, proxy }, preview: { ...base.preview, proxy } };

export default config;
