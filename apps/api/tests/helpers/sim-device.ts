/**
 * SimDevice: a minimal Cardputer client for the real v2 server, used by the
 * deterministic device e2e test (e2e-device-flow.test.ts). Built on the `ws`
 * package that is already a dependency of @bob/api.
 *
 * It speaks the OLX2 wire contract from schemas.ts: control messages as JSON
 * envelopes, uplink audio as binary OLX2 frames (serialized with
 * serializeAudioFrame). It resolves the HTTP status when a WebSocket upgrade
 * is rejected ('unexpected-response'), which is how the auth and limit cases
 * observe 401/429/503 without a connection.
 */
import WebSocket, { type RawData } from 'ws';
import { serializeAudioFrame, type AudioFrameDto } from '../../src/voice/protocol.ts';

export interface SimControlDto {
  v: number;
  type: string;
  id: string;
  turn_ref?: string;
  seq?: number;
  payload: Record<string, unknown>;
}

export interface SimAudioDownFrame {
  kind: 'audio_down';
  formatId: number;
  turnHandle: number;
  sequence: number;
  payload: Buffer;
}

export type ReceivedControl = SimControlDto & { receivedAt: number };

export type SimOpenResult = { connected: true } | { connected: false; status: number };

/** Parses one incoming OLX2 binary frame into its header fields plus payload. */
function parseAudioFrame(raw: RawData): SimAudioDownFrame {
  const frame = Buffer.from(raw as Buffer);
  return {
    kind: 'audio_down',
    formatId: frame.readUInt8(6),
    turnHandle: frame.readUInt32BE(8),
    sequence: frame.readUInt32BE(12),
    payload: Buffer.from(frame.subarray(20)),
  };
}

export class SimDevice {
  private socket: WebSocket;
  private controls: ReceivedControl[] = [];
  private audioFrames: SimAudioDownFrame[] = [];
  private controlWaiters: Array<{ type: string; resolve: (dto: SimControlDto) => void; reject: (error: Error) => void }> = [];
  private closeWaiters: Array<() => void> = [];
  private closed = false;

  constructor(
    url: string,
    options: { auth?: string; autoPong?: boolean } = {},
  ) {
    const headers: Record<string, string> = {};
    if (options.auth) headers.authorization = `Bearer ${options.auth}`;
    this.socket = new WebSocket(url, { headers, autoPong: options.autoPong ?? true });

    this.socket.on('message', (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        this.audioFrames.push(parseAudioFrame(raw));
        return;
      }
      const dto = JSON.parse(raw.toString()) as SimControlDto;
      const received: ReceivedControl = { ...dto, receivedAt: Date.now() };
      this.controls.push(received);
      const index = this.controlWaiters.findIndex((waiter) => waiter.type === dto.type);
      if (index >= 0) {
        const waiter = this.controlWaiters[index]!;
        this.controlWaiters.splice(index, 1);
        waiter.resolve(dto);
      }
    });

    this.socket.on('close', () => {
      this.closed = true;
      for (const resolve of this.closeWaiters) resolve();
      this.closeWaiters = [];
    });
  }

  /**
   * Resolves once the socket is open, or with the HTTP status when the server
   * rejects the upgrade (401/429/503). Rejects on error or timeout.
   *
   * Default budget is generous (15000 ms) on purpose: the WS upgrade path can
   * hide real async work (e.g. device-auth's getDb() lookup, which may open a
   * fresh database connection) that a loaded machine can push
   * well past a "should be instant" budget with nothing actually wrong.
   * Callers with tighter latency expectations can still pass a smaller value.
   */
  open(timeoutMs = 15000): Promise<SimOpenResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (value: SimOpenResult | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      const timer = setTimeout(
        () => done(new Error(`SimDevice open timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.socket.once('open', () => done({ connected: true }));
      this.socket.once('unexpected-response', (_request, response: { statusCode: number; resume?: () => void }) => {
        response.resume?.();
        done({ connected: false, status: response.statusCode });
      });
      this.socket.once('error', (error: Error) => done(error));
    });
  }

  /** Sends a JSON control message in the OLX2 envelope. */
  sendControl(dto: SimControlDto): void {
    this.socket.send(JSON.stringify(dto));
  }

  /** Sends one uplink audio frame, serialized into the OLX2 binary layout. */
  sendAudioFrame(frame: AudioFrameDto): void {
    this.socket.send(serializeAudioFrame(frame));
  }

  /**
   * Resolves with the next control message of the given type, or rejects on
   * timeout. Matches a message already received OR one that arrives after the
   * call: ws delivers every message from one network receive synchronously in
   * a single batch, so a strictly future-only match can miss a playback_*
   * that arrived in the same batch as the previous one. Cross-turn leakage is
   * prevented by calling reset() at each turn boundary.
   */
  waitFor(type: string, timeoutMs = 5000): Promise<SimControlDto> {
    const existing = this.controls.find((dto) => dto.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter = {
        type,
        resolve: (dto: SimControlDto): void => {
          if (timer) clearTimeout(timer);
          resolve(dto);
        },
        reject: (error: Error): void => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      };
      timer = setTimeout(() => {
        this.controlWaiters = this.controlWaiters.filter((candidate) => candidate !== waiter);
        reject(new Error(`Timed out waiting for control message '${type}'`));
      }, timeoutMs);
      this.controlWaiters.push(waiter);
    });
  }

  /** Clears received messages and pending waiters, for a fresh turn on one socket. */
  reset(): void {
    const pending = this.controlWaiters;
    this.controlWaiters = [];
    for (const waiter of pending) waiter.reject(new Error('SimDevice reset'));
    this.controls = [];
    this.audioFrames = [];
  }

  /** Resolves when the socket closes, or rejects on timeout. */
  waitForClose(timeoutMs = 5000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onClose = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.closeWaiters = this.closeWaiters.filter((candidate) => candidate !== onClose);
        reject(new Error('Timed out waiting for the socket to close'));
      }, timeoutMs);
      this.closeWaiters.push(onClose);
    });
  }

  /** Control messages received so far, in arrival order, with arrival timestamps. */
  controlEvents(): ReceivedControl[] {
    return this.controls;
  }

  /** Audio downlink frames received so far, in arrival order. */
  audioEvents(): SimAudioDownFrame[] {
    return this.audioFrames;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Socket already gone; nothing to do.
    }
  }
}
