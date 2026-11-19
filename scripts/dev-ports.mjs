import net from 'node:net';

/*
 * dev-ports.mjs — bind-port resolution and preflight for the browser client.
 *
 * The client is served over plain HTTP on an unprivileged port, so there is no
 * privileged-bind problem to work around and no elevation or kernel redirect in
 * the dev path. What remains is the ordinary case of the port already being
 * taken, which is worth reporting clearly rather than as a vite stack trace.
 */

export const DEFAULT_WEB_PORT = 5173;

/**
 * Parses a port from the environment, falling back when unset or empty.
 * Throws on a value that is not a usable TCP port rather than silently
 * falling back — a typo'd port must not quietly serve somewhere unexpected.
 */
export function resolvePort(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${value}": expected an integer between 1 and 65535`);
  }
  return port;
}

/** True for the ports an ordinary user may not bind on macOS and Linux. */
export function isPrivilegedPort(port) {
  return port < 1024;
}

/**
 * Attempts to bind each port and reports which ones fail. Used as a preflight
 * so a failure surfaces as an explanation rather than a vite stack trace two
 * processes deep.
 */
export async function checkPorts(ports, host = '0.0.0.0') {
  const results = await Promise.all(ports.map((port) => checkPort(port, host)));
  return results.filter((result) => result.code !== null);
}

function checkPort(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve({ port, code: error.code ?? 'EUNKNOWN' }));
    server.once('listening', () => server.close(() => resolve({ port, code: null })));
    server.listen(port, host);
  });
}

/** The remedy text for a failed preflight. */
export function bindAdvice(failures, platform = process.platform) {
  const lines = failures.map(({ port, code }) => `  port ${port}: ${code}`);
  const busy = failures.filter(({ code }) => code === 'EADDRINUSE');
  const denied = failures.filter(({ code }) => code === 'EACCES');
  const advice = [`Cannot bind the web client's port:`, ...lines, ''];

  if (busy.length > 0) {
    advice.push(
      `EADDRINUSE means another process already holds the port.`,
      platform === 'win32'
        ? `  Check IIS, http.sys reservations, or another dev server.`
        : `  Find it with: lsof -nP -iTCP:${busy[0].port} -sTCP:LISTEN`,
      `  Or release Bob's dev ports with: npm run cleanup`,
      `  Or pick another port: BOB_WEB_PORT=5174 npm run dev:ui`,
      '',
    );
  }

  if (denied.length > 0) {
    advice.push(
      `EACCES means the port is privileged on this platform.`,
      `The default (${DEFAULT_WEB_PORT}) is unprivileged — set BOB_WEB_PORT to a port above 1023.`,
      '',
    );
  }

  return advice.join('\n');
}
