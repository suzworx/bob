#!/usr/bin/env node
/*
 * turn-timeline.mjs — one timing waterfall per voice turn, from the journal.
 *
 *   node scripts/turn-timeline.mjs [conv_id ... | latest] [--file <log>] [--out <dir>]
 *
 * Reads the `v2.*` journal events of Bob conversations from a saved log
 * (default: the local journal, apps/api/data/v2-journal.log or
 * data/v2-journal.log; a `.json` file is read as an array of log-store search
 * hits) and writes a self-contained HTML
 * page to data/turn-timeline/ with a bar per stage: recording, end of turn,
 * speech-to-text, preparation, the model, speech generation and playback.
 *
 * Device milestones (`v2.device_turn_timing`) are offsets on the device clock
 * from the turn's capture start, never comparable with server time. They are
 * placed on the server clock by putting the device's turn_end at the server's
 * STT start, which ignores the uplink's last-frame latency (tens of ms).
 *
 * The page carries numbers, enums and model ids only: never an id, transcript,
 * reply text or any other field of the source lines (docs/log-reference.md).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = join(ROOT, 'data/turn-timeline');

/** A wait from "you stop" to "Bob speaks" above this is flagged on the page. */
export const SLOW_WAIT_MS = 5000;

const DEVICE_OFFSETS = ['capture_end_ms', 'turn_end_ms', 'playback_start_ms', 'playback_end_ms'];
const KV_RE = / ([a-z_]+)=("[^"]*"|-?[0-9.]+)/gu;
const EVENT_RE = /\] (v2\.[a-z_]+)/u;

/**
 * One journal line as `{ event, ...fields }` (string values unquoted), or null
 * for a line that is not a `v2.*` event. A leading log timestamp is kept
 * as `line_ts` for lines without a `ts` field.
 */
export function parseLine(line) {
  const event = EVENT_RE.exec(line);
  if (!event) return null;
  const fields = { line_ts: line.split(' ', 1)[0] };
  for (const [, key, value] of line.matchAll(KV_RE)) fields[key] = value.replace(/^"|"$/gu, '');
  fields.event = event[1];
  return fields;
}

/**
 * One log-store search hit (a flat JSON row) as the `{ event, ...fields }` shape parseLine returns:
 * every value as a string, and `ts` from the hit's `_timestamp` (µs).
 */
export function hitToFields(hit) {
  const fields = {};
  for (const [key, value] of Object.entries(hit)) {
    if (value !== null && value !== undefined && key !== '_timestamp') fields[key] = String(value);
  }
  fields.ts = new Date(Math.floor(Number(hit._timestamp) / 1000)).toISOString();
  return fields;
}

/** Journal events grouped by turn_id, first occurrence of each event wins. */
function groupByTurn(events) {
  const turns = new Map();
  for (const fields of events) {
    if (!fields?.turn_id) continue;
    const turn = turns.get(fields.turn_id) ?? {};
    turn[fields.event] ??= fields;
    turns.set(fields.turn_id, turn);
  }
  return turns;
}

const epochMs = (fields) => Date.parse(fields.ts ?? fields.line_ts);
const num = (value) => Number(value ?? 0);
const isOffset = (value) => /^-?\d+$/u.test(value ?? '');

/** Stage end on the server clock and its start, from the event's ts and duration_ms. */
function span(fields) {
  const end = epochMs(fields);
  return { start: end - num(fields.duration_ms), end };
}

/** The agent stage split into preparation and the model call. */
function agentRows(agent, at) {
  if (!agent) return [];
  const { start, end } = span(agent);
  const prep = num(agent.prep_ms);
  const tools = agent.called_tools || 'none';
  const model = agent.model ? `${agent.model}, ` : '';
  return [
    { name: 'Preparation', start: at(start), end: at(start + prep), kind: 'server', note: `${prep} ms (memory ${agent.retrieval_ms ?? '?'} ms)` },
    { name: 'AI model', start: at(start + prep), end: at(end), kind: 'server', note: `${model}${num(agent.model_ms)} ms, ${agent.steps ?? '?'} step(s), tools: ${tools}` },
  ];
}

/** Speech generation, with the per-sentence split when the reply was streamed. */
function ttsRows(tts, done, at) {
  if (!tts) return [];
  const { start, end } = span(tts);
  const perSentence = done?.tts_ms_per_sentence;
  const note = `${num(tts.duration_ms)} ms total${perSentence ? `, per sentence ${perSentence}` : ', whole reply'}`;
  return [{ name: 'Speech generation', start: at(start), end: at(end), kind: 'server', note }];
}

/**
 * One turn's waterfall, in ms from the device's capture start, or null when the
 * turn lacks STT or a fully measured device timing (an offset of `skipped`).
 */
function buildTurn(events) {
  const stt = events['v2.turn_stage_stt_completed'];
  const device = events['v2.device_turn_timing'];
  if (!stt || !device || !DEVICE_OFFSETS.every((key) => isOffset(device[key]))) return null;
  const [captureEnd, turnEnd, playStart, playEnd] = DEVICE_OFFSETS.map((key) => Number(device[key]));
  const sttSpan = span(stt);
  // The clock alignment: device turn_end sits at the server's STT start.
  const origin = sttSpan.start - turnEnd;
  const at = (ms) => ms - origin;
  const stuck = device.end_reason === 'max';
  const rows = [
    { name: 'Recording', start: 0, end: captureEnd, kind: stuck ? 'device-bad' : 'device', note: `${(captureEnd / 1000).toFixed(1)}s, ended by ${device.end_reason ?? '?'}` },
    { name: 'End of turn sent', start: captureEnd, end: turnEnd, kind: 'net', note: `${turnEnd - captureEnd} ms` },
    { name: 'Speech-to-text', start: at(sttSpan.start), end: at(sttSpan.end), kind: 'server', note: `${(num(stt.duration_ms) / 1000).toFixed(2)}s for ${stt.seconds ?? '?'}s audio` },
    ...agentRows(events['v2.turn_stage_agent_completed'], at),
    ...ttsRows(events['v2.turn_stage_tts_completed'], events['v2.turn_completed'], at),
    { name: 'Bob speaking', start: playStart, end: playEnd, kind: 'device', note: `${((playEnd - playStart) / 1000).toFixed(1)}s` },
  ];
  return {
    at: new Date(epochMs(stt)).toISOString().slice(0, 19),
    board: stt.board ?? '',
    wait: playStart - turnEnd,
    total: Math.max(playEnd, ...rows.map((row) => row.end)),
    stuck,
    rows,
    markers: [{ at: turnEnd, label: 'you stop' }, { at: playStart, label: 'Bob speaks' }],
  };
}

/** Every renderable turn in a list of parsed events, oldest first. */
export function buildTurnsFromEvents(events) {
  return [...groupByTurn(events).values()]
    .map(buildTurn)
    .filter(Boolean)
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Every renderable turn in the log text, oldest first. */
export function buildTurns(text) {
  return buildTurnsFromEvents(text.split('\n').map(parseLine));
}

/** Count, median wait (upper median) and number of waits over SLOW_WAIT_MS. */
export function summarize(turns) {
  const waits = turns.map((turn) => turn.wait).sort((a, b) => a - b);
  return {
    turns: waits.length,
    medianWaitMs: waits.length ? waits[Math.floor(waits.length / 2)] : 0,
    overSlow: waits.filter((wait) => wait > SLOW_WAIT_MS).length,
  };
}

const COLORS = { device: '#378ADD', 'device-bad': '#E24B4A', net: '#888780', server: '#1D9E75' };
const escape = (text) => String(text).replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

/** Grid lines every second, or every five on a long turn. */
function gridSvg(total, x, height) {
  const step = total > 12000 ? 5 : 1;
  const out = [];
  for (let s = 0; s <= total / 1000; s += step) {
    out.push(`<line x1="${x(s * 1000)}" y1="0" x2="${x(s * 1000)}" y2="${height - 20}" class="grid"/><text x="${x(s * 1000)}" y="${height - 6}" class="tick">${s}s</text>`);
  }
  return out.join('');
}

/** One labelled bar; the note flips to the bar's left near the right edge. */
function rowSvg(row, index, x, scale) {
  const y = index * 28 + 4;
  const left = x(Math.max(row.start, 0));
  const width = Math.max((row.end - row.start) * scale, 2).toFixed(1);
  const right = left + Number(width) + 6;
  const [noteX, anchor] = right > 740 ? [left - 6, 'end'] : [right, 'start'];
  return `<text x="162" y="${y + 15}" class="lbl" text-anchor="end">${escape(row.name)}</text>`
    + `<rect x="${left.toFixed(1)}" y="${y}" width="${width}" height="22" rx="3" fill="${COLORS[row.kind]}"><title>${escape(`${row.name}: ${row.note}`)}</title></rect>`
    + `<text x="${noteX.toFixed(1)}" y="${y + 15}" class="note" text-anchor="${anchor}">${escape(row.note)}</text>`;
}

/** The inline SVG waterfall of one turn. */
function turnSvg(turn) {
  const [width, labelWidth] = [900, 170];
  const scale = (width - labelWidth - 20) / Math.max(turn.total, 1);
  const x = (ms) => labelWidth + ms * scale;
  const height = turn.rows.length * 28 + 40;
  const markers = turn.markers.map((m) => `<line x1="${x(m.at).toFixed(1)}" y1="0" x2="${x(m.at).toFixed(1)}" y2="${height - 20}" class="mark"><title>${escape(m.label)}</title></line>`);
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img">${gridSvg(turn.total, x, height)}`
    + `${turn.rows.map((row, index) => rowSvg(row, index, x, scale)).join('')}${markers.join('')}</svg>`;
}

function turnSection(turn) {
  const wait = `<span class="pill ${turn.wait > SLOW_WAIT_MS ? 'bad' : 'ok'}">you stop → Bob speaks ${(turn.wait / 1000).toFixed(1)}s</span>`;
  const stuck = turn.stuck ? ' <span class="pill bad">recording hit the max length</span>' : '';
  return `<section><h3>${escape(turn.at)}Z ${wait}${stuck}</h3><div class="sub">${escape(turn.board)}</div>${turnSvg(turn)}</section>`;
}

const STYLE = `:root{--bg:#fff;--fg:#1a1a19;--mut:#6b6a65;--grid:#ecebe6;--card:#fafaf8}
@media (prefers-color-scheme:dark){:root{--bg:#1a1a19;--fg:#f0efec;--mut:#a3a29b;--grid:#2c2c2a;--card:#222220}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,system-ui,sans-serif;padding:16px;max-width:980px;margin:auto}
section{background:var(--card);border-radius:12px;padding:12px 16px;margin:12px 0}
h1{font-size:20px;font-weight:500} h3{font-size:15px;font-weight:500;margin:0} .sub{color:var(--mut);font-size:12px;margin-bottom:6px}
.pill{font-size:12px;padding:2px 8px;border-radius:8px;margin-left:6px} .ok{background:#E1F5EE;color:#085041} .bad{background:#FCEBEB;color:#791F1F}
.lbl,.note,.tick{fill:var(--fg);font-size:12px} .note,.tick{fill:var(--mut)} .grid{stroke:var(--grid)} .mark{stroke:#E24B4A;stroke-dasharray:4 3}
.legend span{display:inline-flex;align-items:center;gap:4px;margin-right:14px;color:var(--mut);font-size:12px} .legend i{width:10px;height:10px;border-radius:2px;display:inline-block}`;

/** The self-contained HTML page for a list of turns. */
export function renderHtml(turns) {
  const { turns: count, medianWaitMs, overSlow } = summarize(turns);
  const legend = [['device', 'Device'], ['device-bad', 'Recording hit max'], ['server', 'Server'], ['net', 'Network']]
    .map(([kind, label]) => `<span><i style="background:${COLORS[kind]}"></i>${label}</span>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bob turn timelines</title><style>${STYLE}</style></head><body><h1>Bob turn timelines</h1>
<p>${count} turns · median wait after you stop ${(medianWaitMs / 1000).toFixed(1)}s · ${overSlow} over ${SLOW_WAIT_MS / 1000}s. Red dashed lines: you stop, Bob starts speaking.</p>
<div class="legend">${legend}</div>
${turns.map(turnSection).join('\n')}</body></html>`;
}

const JOURNALS = ['apps/api/data/v2-journal.log', 'data/v2-journal.log'].map((path) => join(ROOT, path));

/** The parsed events of a saved log: a JSON array of search hits, or journal lines. */
function readEvents(file) {
  const text = readFileSync(file, 'utf8');
  return file.endsWith('.json') ? JSON.parse(text).map(hitToFields) : text.split('\n').map(parseLine);
}

/** The conversation of the newest STT stage among the events. */
function latestConversation(events) {
  const newest = events.filter((f) => f?.event === 'v2.turn_stage_stt_completed' && f.conversation_id)
    .sort((a, b) => epochMs(a) - epochMs(b)).at(-1);
  if (!newest) throw new Error('no device turn found in the log');
  return newest.conversation_id;
}

function parseArgs(argv) {
  const options = { ids: [], file: null, out: DEFAULT_OUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--file') options.file = argv[++index];
    else if (arg === '--out') options.out = resolve(argv[++index]);
    else options.ids.push(arg);
  }
  return options;
}

/** Renders parsed events to <out>/<name>.html and prints the summary line. */
function writePage(events, out, name) {
  const turns = buildTurnsFromEvents(events);
  const path = join(out, `${name}.html`);
  writeFileSync(path, renderHtml(turns));
  const { turns: count, medianWaitMs, overSlow } = summarize(turns);
  console.log(`${path}: ${count} turns, median wait ${medianWaitMs} ms, ${overSlow} over ${SLOW_WAIT_MS / 1000}s`);
}

async function main(argv) {
  const { ids, file, out } = parseArgs(argv);
  mkdirSync(out, { recursive: true });
  const source = file ?? JOURNALS.find((path) => existsSync(path));
  if (!source) throw new Error(`no journal found; pass --file <log> (looked in ${JOURNALS.join(', ')})`);
  const events = readEvents(source);
  if (file && ids.length === 0) {
    writePage(events, out, basename(file).replace(/\.[^.]+$/u, ''));
    return;
  }
  const conversations = ids.length === 0 || ids[0] === 'latest' ? [latestConversation(events)] : ids;
  for (const id of conversations) writePage(events.filter((f) => f?.conversation_id === id), out, id);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`turn-timeline: ${error.message}`);
    process.exitCode = 1;
  });
}
