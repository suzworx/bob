/**
 * The caps each socket's hello advertised. A socket with no entry (older
 * firmware, or caps that failed validation) has none. Two rules read it:
 * sendDto skips a gated message (reply_text) only when caps exist and lack
 * the token; express and scene are sent only on a positive cap.
 */
import type { WebSocket } from 'ws';

const socketCaps = new WeakMap<WebSocket, ReadonlySet<string>>();

export function rememberSocketCaps(socket: WebSocket, caps: readonly string[]): void {
  socketCaps.set(socket, new Set(caps));
}

/** The socket's caps, or undefined when its hello advertised none. */
export function capsOf(socket: WebSocket): ReadonlySet<string> | undefined {
  return socketCaps.get(socket);
}

export function socketHasCap(socket: WebSocket, cap: string): boolean {
  return socketCaps.get(socket)?.has(cap) === true;
}
