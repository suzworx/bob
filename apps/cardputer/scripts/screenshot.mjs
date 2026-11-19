// Takes a screenshot of the Waveshare round screen: sends `T screenshot` to the hil build's test
// console (waveshare-s3-185c-hil), collects the "S <base64>" lines between SCREENSHOT BEGIN and
// SCREENSHOT END, checks the CRC-32 and writes a PNG. No dependencies: the serial port is opened as
// a file (USB CDC needs no baud rate) and the PNG is written with node:zlib.
//
// Usage (from apps/cardputer): BOB_COM_PORT=COM4 node scripts/screenshot.mjs [out.png]
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { deflateSync } from 'node:zlib';

const port = process.env.BOB_COM_PORT ?? 'COM4';
const out = process.argv[2] ?? `screenshot-${Date.now()}.png`;
const timeoutMs = Number(process.env.BOB_SCREENSHOT_TIMEOUT_MS ?? 20000);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes, seed = 0xffffffff) {
  let c = seed;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((crc32(Buffer.concat([head.subarray(4), data])) ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

// Raw big-endian RGB565 to an 8-bit RGB PNG.
export function rgb565ToPng(raw, w, h) {
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    let o = y * (w * 3 + 1);
    rows[o++] = 0;
    for (let x = 0; x < w; x += 1) {
      const v = (raw[(y * w + x) * 2] << 8) | raw[(y * w + x) * 2 + 1];
      rows[o++] = ((v >> 11) & 31) * 255 / 31;
      rows[o++] = ((v >> 5) & 63) * 255 / 63;
      rows[o++] = (v & 31) * 255 / 31;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

// Feeds one serial line to the frame state; returns the finished frame at SCREENSHOT END.
function takeLine(frame, line) {
  const begin = /^SCREENSHOT BEGIN w=(\d+) h=(\d+)/.exec(line);
  if (begin) {
    frame.dims = [Number(begin[1]), Number(begin[2])];
    frame.parts.length = 0;
    return null;
  }
  if (frame.dims === null) return null;
  if (line.startsWith('S ')) {
    frame.parts.push(Buffer.from(line.slice(2), 'base64'));
    return null;
  }
  const end = /^SCREENSHOT END crc=([0-9a-f]+)/.exec(line);
  return end ? { raw: Buffer.concat(frame.parts), crc: Number.parseInt(end[1], 16), dims: frame.dims } : null;
}

// The serial transport. The board's USB serial only transmits while the host asserts DTR, which a plain
// file open cannot do (and .NET's SerialPort stalls this stream), so on Windows a pyserial child (PlatformIO
// ships pyserial) owns the port: it leaves DTR and RTS high, so the board is not reset; elsewhere the
// device file is read directly. readChunk() returns what arrived, or '' after 4 s of silence.
const BRIDGE = [
  'import sys, threading, serial',
  `p = serial.Serial('${port}', 115200, timeout=0.02)`,
  'def reader():',
  '    while True:',
  '        d = p.read(4096)',
  '        if d:',
  '            sys.stdout.buffer.write(d)',
  '            sys.stdout.buffer.flush()',
  'threading.Thread(target=reader, daemon=True).start()',
  'for line in sys.stdin.buffer:',
  '    p.write(line)',
].join('\n');

async function openTransport() {
  const queue = [];
  let wake = null;
  const push = (data) => {
    queue.push(data.toString('latin1'));
    if (wake) wake();
  };
  const transport = { text: '' };
  if (process.platform === 'win32') {
    const child = spawn(process.env.BOB_PYTHON ?? 'py', ['-3.11', '-u', '-c', BRIDGE], { stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdout.on('data', push);
    transport.write = (data) => child.stdin.write(data);
    transport.close = () => child.kill();
  } else {
    const fh = await open(port, 'r+');
    const buf = Buffer.alloc(65536);
    let open_ = true;
    (async () => {
      while (open_) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, null).catch(() => ({ bytesRead: 0 }));
        if (bytesRead > 0) push(buf.subarray(0, bytesRead));
      }
    })();
    transport.write = (data) => fh.write(data).catch(() => {});
    transport.close = () => { open_ = false; return fh.close(); };
  }
  transport.readChunk = async () => {
    if (queue.length === 0) await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 4000); });
    wake = null;
    return queue.splice(0).join('');
  };
  return transport;
}

// Reads lines until one frame is complete (or `timeoutMs`), re-sending `retryCmd` every 2 s: opening
// the port resets the board, which needs ~15 s to reach READY before the console answers.
async function readFrame(session, retryCmd) {
  const frame = { dims: null, parts: [] };
  const deadline = Date.now() + timeoutMs;
  const timer = setInterval(() => session.write(retryCmd), 2000);
  try {
    while (Date.now() <= deadline) {
      const chunkText = await session.readChunk();
      if (process.env.BOB_SCREENSHOT_DEBUG) console.log('chunk', chunkText.length, JSON.stringify(chunkText.slice(0, 60)));
      session.text += chunkText;
      const lines = session.text.split('\n');
      session.text = lines.pop() ?? '';
      for (const line of lines) {
        const done = takeLine(frame, line.trim());
        if (done) return done;
      }
      if (frame.dims !== null) clearInterval(timer); // the frame is streaming: no more retries
    }
    throw new Error('timeout waiting for SCREENSHOT END');
  } finally {
    clearInterval(timer);
  }
}

function savePng(file, { raw, crc, dims }) {
  const [w, h] = dims;
  if (raw.length !== w * h * 2) throw new Error(`short frame: ${raw.length} of ${w * h * 2} bytes`);
  const got = (crc32(raw) ^ 0xffffffff) >>> 0;
  if (got !== crc) throw new Error(`crc mismatch: got ${got.toString(16)}, device ${crc.toString(16)}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rgb565ToPng(raw, w, h));
  console.log(`wrote ${file} (${w}x${h}, crc ${crc.toString(16)})`);
}

// Journal lines share the serial port, so a frame can arrive with a damaged line: ask again (up to 4 times).
async function shootWithRetry(session, file) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      savePng(file, await readFrame(session, 'T screenshot\n'));
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
      console.log(`retry ${attempt}: ${error.message}`);
    }
  }
}

// Polls the console with `poll` until a reply matches (the board may still be booting).
async function waitFor(session, pattern, ms, poll) {
  const deadline = Date.now() + ms;
  const timer = setInterval(() => session.write(poll), 1000);
  while (Date.now() <= deadline) {
    session.text += await session.readChunk();
    if (pattern.test(session.text)) {
      clearInterval(timer);
      session.text = '';
      return;
    }
    session.text = session.text.slice(-4096);
  }
  clearInterval(timer);
  throw new Error(`timeout waiting for ${pattern}`);
}

// BOB_SCREENSHOT_STEPS="cmd:T touch 180 150 80;wait:800;shot:info;ui:ready;shot:ready": console
// commands, waits and screenshots (<name>.png next to <out>) run in order; `ui:<name>` is `cmd:T ui <name>`
// followed by a wait. Without STEPS: one screenshot of what is on screen, or BOB_SCREENSHOT_UI=a,b,c.
async function runStep(session, step) {
  const colon = step.indexOf(':');
  const kind = colon < 0 ? step : step.slice(0, colon);
  const arg = colon < 0 ? '' : step.slice(colon + 1);
  if (kind === 'cmd' || kind === 'ui') {
    session.write(kind === 'ui' ? `T ui ${arg}\n` : `${arg}\n`);
    await new Promise((resolve) => setTimeout(resolve, kind === 'ui' ? 1500 : 150));
  } else if (kind === 'wait') {
    await new Promise((resolve) => setTimeout(resolve, Number(arg)));
  } else if (kind === 'shot') {
    await shootWithRetry(session, `${dirname(out)}/${arg}.png`);
  } else {
    throw new Error(`unknown step ${step}`);
  }
}

async function main() {
  const session = await openTransport();
  try {
    const names = (process.env.BOB_SCREENSHOT_UI ?? '').split(',').filter(Boolean);
    const steps = process.env.BOB_SCREENSHOT_STEPS
      ? process.env.BOB_SCREENSHOT_STEPS.split(';')
      : names.flatMap((name) => [`ui:${name}`, `shot:${name}`]);
    if (steps.length === 0) {
      savePng(out, await readFrame(session, 'T screenshot\n'));
      return;
    }
    await waitFor(session, /state=READY mode=/, 90000, 'T state\n');
    for (const step of steps) await runStep(session, step);
  } finally {
    await session.close();
  }
}

if (process.argv[1]?.endsWith('screenshot.mjs')) await main();
