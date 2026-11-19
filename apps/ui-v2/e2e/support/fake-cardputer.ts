/**
 * #565 U7: a fake Cardputer for the e2e suite. A Node WebSocket client that
 * speaks the real device contract (apps/api/src/voice/protocol.ts: its DTO schemas
 * check every frame the server sends, its OLX2 codec builds the uplink), and
 * pairs the way a real device pairs: hello -> pairing_required, pair_request ->
 * pair_code, the account approves the code over REST, the socket gets `paired`,
 * and the device reconnects with its olxd_ token. Only ever pointed at the
 * suite's own API (E2E_API_PORT), whose STT and agent are stubbed.
 */
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import {
  ActiveConversationDtoSchema, ActiveSpaceDtoSchema, PCM16_16K_MONO_FORMAT, PCM16_16K_MONO_RATE_HZ, PairCodeDtoSchema,
  PairedDtoSchema, PairingRequiredDtoSchema, ServerControlDtoSchema, V2_PATH, V2_VERSION, messageId, serializeAudioFrame,
} from '../../../api/src/voice/protocol.ts';

const SERVER_SCHEMAS = [ServerControlDtoSchema, ActiveConversationDtoSchema, ActiveSpaceDtoSchema,
  PairingRequiredDtoSchema, PairCodeDtoSchema, PairedDtoSchema];
const WAIT_MS = 30_000;

export interface DeviceMessage { type: string; turn_ref?: string; payload: Record<string, unknown> }
export interface PairedCardputer { token: string; deviceId: string }

export class FakeCardputer {
  /** Every control message the server sent, in order. */
  readonly received: DeviceMessage[] = [];
  /** Server frames that matched no schema in schemas.ts: a broken contract. */
  readonly violations: string[] = [];
  private readonly waiters = new Set<() => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data, isBinary) => {
      if (isBinary) return; // audio_down frames: playback_start/_end bracket them
      const json: unknown = JSON.parse(data.toString());
      if (!SERVER_SCHEMAS.some((schema) => schema.safeParse(json).success)) this.violations.push(data.toString());
      this.received.push(json as DeviceMessage);
      for (const wake of [...this.waiters]) wake();
    });
  }

  static async connect(port: number, token?: string): Promise<FakeCardputer> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${V2_PATH}`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return new FakeCardputer(socket);
  }

  /** The index the next message will have: pass it to waitFor to ignore older ones. */
  mark(): number {
    return this.received.length;
  }

  send(type: string, payload: Record<string, unknown> = {}, extra: { turn_ref?: string; seq?: number } = {}): void {
    this.socket.send(JSON.stringify({ v: V2_VERSION, type, id: messageId(type.slice(0, 8)), ...extra, payload }));
  }

  /** The first message of `type` at or after `since` that `match` accepts; waits for it. */
  waitFor(type: string, match: (message: DeviceMessage) => boolean = () => true, since = 0): Promise<DeviceMessage> {
    return new Promise((resolve, reject) => {
      const check = (): void => {
        const found = this.received.slice(since).find((message) => message.type === type && match(message));
        if (!found) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(found);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`no ${type} within ${WAIT_MS} ms; got ${this.received.slice(since).map((m) => m.type).join(', ')}`));
      }, WAIT_MS);
      this.waiters.add(check);
      check();
    });
  }

  /** hello as a PCM16 device; resolves with the welcome. */
  async hello(board?: string): Promise<DeviceMessage> {
    const since = this.mark();
    this.send('hello', { format_id: PCM16_16K_MONO_FORMAT, fw_version: '0.9.0', ...(board === undefined ? {} : { board }) });
    return this.waitFor('welcome', undefined, since);
  }

  /** One push-to-talk turn: turn_start, 320 ms of tone as OLX2 audio_up, turn_end; resolves at playback_end. */
  async voiceTurn(): Promise<void> {
    const turnRef = messageId('turn');
    const since = this.mark();
    this.send('turn_start', {}, { turn_ref: turnRef });
    const frames = 32;
    for (let sequence = 0; sequence < frames; sequence += 1) {
      const payload = Buffer.alloc(320);
      for (let sample = 0; sample < 160; sample += 1) {
        const phase = sequence * 160 + sample;
        payload.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * phase) / PCM16_16K_MONO_RATE_HZ)), sample * 2);
      }
      this.socket.send(serializeAudioFrame({
        header: { magic: 'OLX2', version: V2_VERSION, kind: 'audio_up', formatId: PCM16_16K_MONO_FORMAT, channels: 1,
          turnHandle: 1, sequence, payloadBytes: payload.length },
        payload,
      }));
    }
    this.send('turn_end', {}, { turn_ref: turnRef, seq: frames - 1 });
    const byTurn = (message: DeviceMessage): boolean => message.turn_ref === turnRef;
    await this.waitFor('playback_start', byTurn, since);
    await this.waitFor('playback_end', byTurn, since);
  }

  close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.close();
    });
  }
}

/**
 * Pairs a new fake Cardputer to the account behind `approve`, which is handed
 * the displayed user code and must look it up and approve it over REST
 * (POST /api/pair/lookup then /api/pair/approve), as the account's owner does.
 */
export async function pairFakeCardputer(port: number, approve: (userCode: string) => Promise<void>, model = 'M5Stack Cardputer'): Promise<PairedCardputer> {
  const device = await FakeCardputer.connect(port);
  try {
    device.send('hello', { format_id: PCM16_16K_MONO_FORMAT });
    await device.waitFor('pairing_required');
    device.send('pair_request', { model, fw_version: '0.9.0', claim: randomBytes(16).toString('hex') });
    const code = await device.waitFor('pair_code');
    await approve(String(code.payload.user_code));
    const paired = await device.waitFor('paired');
    return { token: String(paired.payload.device_token), deviceId: String(paired.payload.device_id) };
  } finally {
    await device.close();
  }
}

/** The REST calls the revoke helpers need: an APIRequestContext signed in as the account. */
interface DevicesApi {
  get(url: string): Promise<{ ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<unknown> }>;
  delete(url: string): Promise<{ status(): number; text(): Promise<string> }>;
}

/** Revokes one device (DELETE /api/devices/:id); a 404 is one already revoked, e.g. by revokeAllDevices. */
export async function revokeDevice(api: DevicesApi, deviceId: string): Promise<void> {
  const response = await api.delete(`/api/devices/${deviceId}`);
  if (response.status() !== 204 && response.status() !== 404) {
    throw new Error(`revoke device failed (${response.status()}): ${await response.text()}`);
  }
}

/** The account's paired devices (GET /api/devices), with whether each is connected now. */
export async function listDevices(api: DevicesApi): Promise<Array<{ id: string; connected: boolean }>> {
  const response = await api.get('/api/devices');
  if (!response.ok()) throw new Error(`list devices failed (${response.status()}): ${await response.text()}`);
  const body = (await response.json()) as { devices?: Array<{ id: string; connected?: boolean }> };
  return (body.devices ?? []).map((device) => ({ id: device.id, connected: device.connected === true }));
}

/** Revokes every device the account has paired, so a spec can start from "no Cardputer" whatever ran before it. */
export async function revokeAllDevices(api: DevicesApi): Promise<void> {
  for (const device of await listDevices(api)) await revokeDevice(api, device.id);
}
