/**
 * Speech-asset coverage (#1003): which replies of the real device agent a pack
 * would speak from prerecorded clips. Synthetic prompts only; tools are stubs
 * that echo what was asked, so no account or database is touched. Each run
 * scores both TTS inputs the turn can produce from the same reply, built the
 * way apps/api/src/voice/turn/agent.ts builds them: batch (runAgent, what
 * production runs with BOB_STREAMING_REPLY=0) speaks the final step's text;
 * streamed (streamAgent) splits every step's text, a space between steps.
 *
 *   npx tsx apps/api/scripts/speech-coverage.ts --pack <dir> --build <id> [--reps 5]
 *
 * Writes data/speech-coverage/<build>-<time>.json (texts of synthetic replies
 * only) and prints hit rates. Coverage depends on the agent's wording, so it
 * says nothing about production traffic until real turns are measured.
 */
import { promises as fs } from 'node:fs';
import {
  createDeviceTools, createBobAgent, createTimerTools, createVoiceTools,
  BOB_TTS_MODEL, BOB_TTS_VOICE, refuseProductionKey, type DeviceCallbacks, type TimerView, type VoiceCallbacks,
} from '@bob/ai';
import { speakable } from '../src/voice/audio/speakable.ts';
import { createReplySplitter } from '../src/voice/audio/stt-tts.ts';
import { createSpeechAssetCatalogue } from '../src/voice/speech-assets.ts';

/** `design` prompts shaped the core-en-us spec; `heldOut` prompts did not. */
const PROMPTS: { id: string; prompt: string; set: 'design' | 'heldOut' }[] = [
  { id: 'timer3', prompt: 'Set a timer for three minutes.', set: 'design' },
  { id: 'timer5', prompt: 'Set a five minute timer.', set: 'design' },
  { id: 'timer10', prompt: 'Timer for 10 minutes please.', set: 'design' },
  { id: 'timerNoDuration', prompt: 'Set a timer.', set: 'design' },
  { id: 'time', prompt: 'What time is it?', set: 'design' },
  { id: 'listTimers', prompt: 'How long is left on my timer?', set: 'design' },
  { id: 'cancel', prompt: 'Cancel my timer.', set: 'design' },
  { id: 'alarm8', prompt: 'Wake me up at 8 am.', set: 'design' },
  { id: 'volumeUp', prompt: 'Turn the volume up.', set: 'design' },
  { id: 'explain', prompt: 'How do timers work on you?', set: 'design' },
  { id: 'timer20', prompt: 'Start a twenty minute timer.', set: 'heldOut' },
  { id: 'timer1', prompt: 'Give me a one minute timer.', set: 'heldOut' },
  { id: 'timer30s', prompt: 'Set a timer for 30 seconds.', set: 'heldOut' },
  { id: 'alarm6', prompt: 'Set an alarm for 6 in the morning.', set: 'heldOut' },
  { id: 'volumeDown', prompt: 'Make it quieter.', set: 'heldOut' },
  { id: 'stopTimer', prompt: 'Stop the timer.', set: 'heldOut' },
  { id: 'joke', prompt: 'Tell me a short joke.', set: 'heldOut' },
];

function view(ms: number, kind: 'timer' | 'alarm' = 'timer'): TimerView {
  return { id: 't1', kind, label: null, firesAtIso: new Date(Date.now() + ms).toISOString(), remainingMs: ms, localTime: '08:00' };
}

const reminder = { id: 'r1', title: 'stub', when: 'tomorrow at 8 am', repeat: null };
const note = { id: 'n1', title: 'stub', body: '' };
const voice: VoiceCallbacks = {
  createReminder: async () => reminder, listReminders: async () => [], cancelReminder: async () => reminder,
  createNote: async () => note, appendNote: async () => note, readNote: async () => note,
  search: async () => [], readInbox: async () => ({ unread: 0, items: [] }),
};
let volume = 6;
const device: DeviceCallbacks = {
  setVolume: async (input) => {
    volume = input.level ?? volume;
    return { volume, muted: input.mute ?? false };
  },
  setMode: async (input) => ({ mode: input.mode }),
  express: async () => undefined,
};

function agent(): ReturnType<typeof createBobAgent> {
  return createBobAgent({
    timeZone: 'America/Los_Angeles',
    mode: 'device',
    capabilityTools: createTimerTools({
      setTimer: async ({ durationMs }) => view(durationMs),
      setAlarm: async () => view(8 * 3_600_000, 'alarm'),
      listTimers: async () => [view(180_000)],
      cancelTimers: async () => ({ cancelled: [view(180_000)], remaining: 0 }),
    }),
    lateTools: { ...createVoiceTools(voice), ...createDeviceTools(device) },
  });
}

function arg(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at === -1 ? fallback : process.argv[at + 1];
  if (value === undefined) throw new Error(`usage: speech-coverage.ts --pack <dir> --build <id> [--reps n]; missing --${name}`);
  return value;
}

interface Run { id: string; set: string; rep: number; reply: string; batchHit: boolean; pieces: { text: string; hit: boolean }[]; tools: string[] }

/** One agent turn, scored as both the batch and the streamed TTS inputs. */
async function runPrompt(entry: (typeof PROMPTS)[number], rep: number, hit: (text: string) => Promise<boolean>): Promise<Run> {
  const splitter = createReplySplitter();
  const raw: string[] = [];
  let streamedText = '';
  const result = await agent().stream({ messages: [{ role: 'user', content: entry.prompt }] });
  for await (const part of result.fullStream) {
    let delta = '';
    if (part.type === 'start-step' && streamedText !== '' && !/\s$/.test(streamedText)) delta = ' ';
    if (part.type === 'text-delta') delta = part.text;
    streamedText += delta;
    if (delta !== '') raw.push(...splitter.push(delta));
  }
  raw.push(...splitter.flush());
  const steps = await result.steps;
  const reply = steps.at(-1)?.text ?? '';
  const pieces = await Promise.all(raw.map(speakable).filter((text) => text !== '').map(async (text) => ({ text, hit: await hit(text) })));
  const batch = speakable(reply) || reply;
  return { id: entry.id, set: entry.set, rep, reply, batchHit: await hit(batch), pieces, tools: steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)) };
}

async function main(): Promise<void> {
  if ((process.env.AI_GATEWAY_API_KEY ?? '') === '' || process.env.BOB_SYSTEM_TEST === '1') throw new Error('The real agent is required');
  refuseProductionKey();
  const build = arg('build');
  const reps = Number(arg('reps', '5'));
  const catalogue = await createSpeechAssetCatalogue({
    directory: arg('pack'), identity: { buildVersion: build, model: BOB_TTS_MODEL, voice: BOB_TTS_VOICE, locale: 'en-US' },
  });
  if (!catalogue.ready) throw new Error('Pack did not load for the effective identity');
  const hit = async (text: string): Promise<boolean> => (await catalogue.resolve(text)) !== undefined;
  const runs: Run[] = [];
  for (let rep = 0; rep < reps; rep++) {
    for (const entry of PROMPTS) {
      const run = await runPrompt(entry, rep, hit);
      runs.push(run);
      console.log(`${run.id} ${rep} batch=${run.batchHit ? 'hit' : 'miss'} pieces=${run.pieces.map((piece) => (piece.hit ? 'H' : '.')).join('')}`);
    }
  }
  const rate = (rows: Run[]): Record<string, string> => {
    const pieces = rows.flatMap((run) => run.pieces);
    const turnsAllPieces = rows.filter((run) => run.pieces.length > 0 && run.pieces.every((piece) => piece.hit)).length;
    return {
      turns: String(rows.length),
      batchHits: `${rows.filter((run) => run.batchHit).length}/${rows.length}`,
      pieceHits: `${pieces.filter((piece) => piece.hit).length}/${pieces.length}`,
      streamedTurnsFullyFromClips: `${turnsAllPieces}/${rows.length}`,
    };
  };
  const summary = { build, model: process.env.BOB_CHAT_MODEL ?? 'default', reps, design: rate(runs.filter((run) => run.set === 'design')), heldOut: rate(runs.filter((run) => run.set === 'heldOut')), all: rate(runs) };
  await fs.mkdir('data/speech-coverage', { recursive: true });
  const file = `data/speech-coverage/${build}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await fs.writeFile(file, `${JSON.stringify({ summary, runs }, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`wrote ${file}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
