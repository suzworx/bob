// Minimal mock v2 server: on hello, immediately streams a static local MP3
// file down as OLX2 audio_down frames (same chunk size/pacing as the real
// server's downlinkMp3Frames), skipping STT/agent/TTS entirely. Used to
// isolate whether the wire transport (server chunking -> WS binary frames ->
// client reassembly) preserves bytes faithfully, independent of TTS content
// and independent of the device's decode pipeline.
// Usage: node scripts/mock-mp3-server.mjs [port] [file.mp3] [--repeat=N] [--gap-ms=M]
//
// --repeat streams the file N times over the SAME connection, as N separate
// playback_start/audio_down/playback_end cycles. Soaking downlink reliability
// used to mean killing and respawning this server once per run, but that made
// the device fall into its reconnect backoff (kSocketReconnectMaxMs = 30 s),
// so consecutive runs were minutes apart and the soak measured reconnect
// behaviour rather than downlink behaviour. Repeating on one socket keeps the
// device connected and isolates the thing under test.
import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const PORT = Number(positional[0] ?? 7445);
const FILE = positional[1] ?? '../../audio.mp3';
const REPEAT = Math.max(1, Number(flag('repeat', '1')));
const GAP_MS = Number(flag('gap-ms', '1500'));
const CHUNK_BYTES = 1024;
const CHUNK_INTERVAL_MS = 20;

const mp3 = readFileSync(FILE);
const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT, path: '/v2/cardputer' });
console.log(`mock-mp3-server listening on ${PORT}, streaming ${FILE} (${mp3.length}B)`);

function olx2Frame(kind, format, seq, payload) {
  const buf = Buffer.alloc(20 + payload.length);
  buf.write('OLX2', 0, 'ascii');
  buf.writeUInt8(1, 4); // version
  buf.writeUInt8(kind, 5);
  buf.writeUInt8(format, 6);
  buf.writeUInt8(1, 7); // channels
  buf.writeUInt32BE(0, 8); // turn handle
  buf.writeUInt32BE(seq, 12);
  buf.writeUInt32BE(payload.length, 16);
  payload.copy(buf, 20);
  return buf;
}

// An 'error' event with no listener is fatal to the process; without this a
// receiver-level protocol error would kill the mock and surface only as
// cascading harness timeouts.
wss.on('error', (err) => console.error(`server error: ${err.message}`));

wss.on('connection', (ws) => {
  console.log('client connected');
  ws.on('error', (err) => console.error(`socket error: ${err.message}`));
  // One stream loop per socket: a duplicate hello would otherwise interleave
  // two cycles' frames and produce phantom sequence gaps on the device.
  let streaming = false;
  ws.on('close', () => console.log('client disconnected'));
  ws.on('message', async (raw, isBinary) => {
    if (isBinary) return; // ignore uplink audio frames
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== 'hello' || streaming) return;
    streaming = true;

    ws.send(JSON.stringify({
      v: 1, type: 'welcome', id: 'welcome_mock',
      payload: { session_id: 'session_mock00000000000000', format_id: 2 },
    }));
    for (let cycle = 1; cycle <= REPEAT; cycle++) {
      if (ws.readyState !== ws.OPEN) {
        console.log(`aborted at cycle ${cycle}/${REPEAT}: socket closed`);
        return;
      }
      ws.send(JSON.stringify({ v: 1, type: 'playback_start', id: `ps_mock_${cycle}`, payload: {} }));

      // Sequence numbers restart each cycle, matching the real server's
      // per-turn numbering, so the device's seq-gap check stays meaningful.
      let seq = 0;
      const sendStartedAt = Date.now();
      for (let off = 0; off < mp3.length; off += CHUNK_BYTES) {
        // Re-check inside the loop, not just at the cycle boundary: ws.send()
        // after close neither throws nor emits, it just buffers, so a device
        // that drops at frame 5 would still be reported as a full 30-frame
        // send. The harness treats that line as evidence the bytes left the
        // process, so a false success here is worse than no line at all.
        if (ws.readyState !== ws.OPEN) {
          console.log(`aborted mid-cycle ${cycle}/${REPEAT} after ${seq} frames: socket closed`);
          return;
        }
        const chunk = mp3.subarray(off, Math.min(off + CHUNK_BYTES, mp3.length));
        ws.send(olx2Frame(2, 2, seq, chunk));
        seq += 1;
        await new Promise((r) => setTimeout(r, CHUNK_INTERVAL_MS));
      }
      const sendMs = Date.now() - sendStartedAt;
      ws.send(JSON.stringify({ v: 1, type: 'playback_end', id: `pe_mock_${cycle}`, payload: {} }));
      console.log(`streamed ${seq} frames, ${mp3.length}B total in ${sendMs}ms (cycle ${cycle}/${REPEAT})`);

      // Let the device finish decoding and playing before the next cycle; a
      // new playback_start mid-playback would be a different test.
      if (cycle < REPEAT) await new Promise((r) => setTimeout(r, GAP_MS));
    }
  });
});
