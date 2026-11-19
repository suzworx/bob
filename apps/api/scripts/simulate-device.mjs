// Simulates a Cardputer client against the local server to verify the MP3
// downlink stream end-to-end without flashing hardware.
// Usage: node scripts/simulate-device.mjs [host] [port]
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const HOST = process.argv[2] ?? 'localhost';
const PORT = Number(process.argv[3] ?? 7444);
const URL = `ws://${HOST}:${PORT}/v2/cardputer`;

const V = 1;
const FORMAT_MP3 = 2;
const FRAME_INTERVAL_MS = 12; // ~10ms of 16kHz PCM16 (320 bytes) per frame
const UPLINK_MS = 1500; // hold PTT for this long
const PTT_TIMEOUT_MS = 20000; // wait for a reply up to this long

const id = (p) => `${p}_${Math.random().toString(36).slice(2, 12).padEnd(12, 'x')}`.slice(0, 60);
let seq = 0;
let audioBytes = 0;
let turnRef = id('turn');

const ctl = (type, extra = {}) => JSON.stringify({ v: V, type, id: id(type), payload: {}, ...extra });

function audioFrame(sequence) {
  const payload = Buffer.alloc(320); // silent PCM16
  const buf = Buffer.alloc(20 + payload.length);
  buf.write('OLX2', 0, 'ascii');
  buf.writeUInt8(1, 4); // version
  buf.writeUInt8(1, 5); // kind audio_up
  buf.writeUInt8(1, 6); // format PCM16
  buf.writeUInt8(1, 7); // channels
  buf.writeUInt32BE(0, 8); // turn handle
  buf.writeUInt32BE(sequence, 12);
  buf.writeUInt32BE(payload.length, 16);
  payload.copy(buf, 20);
  return buf;
}

function parseDown(buf) {
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'OLX2') return null;
  return {
    kind: buf.readUInt8(5) === 2 ? 'audio_down' : 'audio_up',
    format: buf.readUInt8(6),
    seq: buf.readUInt32BE(12),
    payloadBytes: buf.readUInt32BE(16),
  };
}

const ws = new WebSocket(URL);
const stats = { control: [], downFrames: 0, mp3Bytes: 0, playbackStart: false, playbackEnd: false, statuses: [], errors: [], closed: null };
const downlinkParts = [];
const t0 = Date.now();
const log = (tag, msg) => console.log(`[${Date.now() - t0}ms] ${tag}: ${msg}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.on('open', () => {
  log('open', URL);
  ws.send(ctl('hello', { payload: { format_id: FORMAT_MP3 } }));
});

ws.on('message', async (raw, isBinary) => {
  if (isBinary) {
    const f = parseDown(raw);
    if (!f) { log('binary', 'unparseable frame'); return; }
    stats.downFrames += 1;
    stats.mp3Bytes += f.payloadBytes;
    downlinkParts.push(Buffer.from(raw.subarray(20)));
    if (stats.downFrames <= 5 || stats.downFrames % 25 === 0) log('down', `frame=${f.seq} payload=${f.payloadBytes}`);
    return;
  }
  const text = raw.toString();
  let msg;
  try { msg = JSON.parse(text); } catch { log('text', `unparseable: ${text}`); return; }
  stats.control.push(msg.type);
  switch (msg.type) {
    case 'welcome':
      log('welcome', `session=${msg.payload.session_id} format=${msg.payload.format_id}`);
      seq = 0;
      ws.send(ctl('turn_start', { turn_ref: turnRef }));
      log('turn_start', turnRef);
      const frames = Math.round(UPLINK_MS / FRAME_INTERVAL_MS);
      for (let i = 0; i < frames; i++) {
        ws.send(audioFrame(seq++));
        audioBytes += 320;
      }
      ws.send(ctl('turn_end', { turn_ref: turnRef, seq: seq - 1 }));
      log('turn_end', `sent=${frames} frames ${audioBytes} bytes`);
      break;
    case 'ack':
      break;
    case 'status':
      stats.statuses.push(msg.payload.stage);
      log('status', msg.payload.stage);
      break;
    case 'playback_start':
      stats.playbackStart = true;
      log('playback_start', 'streaming begins');
      break;
    case 'playback_end':
      stats.playbackEnd = true;
      log('playback_end', `total down=${stats.downFrames} mp3=${stats.mp3Bytes}B`);
      ws.close(1000, 'done');
      break;
    case 'error':
      stats.errors.push(msg.payload.code);
      log('error', msg.payload.code);
      break;
    default:
      log('control', msg.type);
  }
});

ws.on('close', (code, reason) => {
  stats.closed = { code, reason: reason.toString() };
  log('close', `code=${code} reason=${reason.toString()}`);
  reportAndExit();
});

ws.on('error', (e) => { log('ws-error', e.message); });

const deadline = Date.now() + PTT_TIMEOUT_MS;
const timer = setInterval(() => {
  if (Date.now() > deadline && !stats.playbackEnd && !stats.closed) {
    log('TIMEOUT', 'no playback_end within timeout; aborting');
    ws.close();
    reportAndExit();
  }
}, 500);

function reportAndExit() {
  clearInterval(timer);
  if (downlinkParts.length > 0) {
    const mp3 = Buffer.concat(downlinkParts);
    writeFileSync('downlink.mp3', mp3);
    log('capture', `saved downlink.mp3 (${mp3.length}B)`);
  }
  console.log('\n=== RESULT ===');
  console.log(JSON.stringify({
    host: URL,
    controlOrder: stats.control,
    statuses: stats.statuses,
    downFrames: stats.downFrames,
    mp3Bytes: stats.mp3Bytes,
    playbackStart: stats.playbackStart,
    playbackEnd: stats.playbackEnd,
    errors: stats.errors,
    closed: stats.closed,
    uplinkFrames: seq,
    uplinkBytes: audioBytes,
  }, null, 2));
  process.exit(0);
}
