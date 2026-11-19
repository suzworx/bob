/**
 * The agent under test for the tool-selection suite (#410, epic #394 X1): the
 * same per-turn agent production builds with createBobAgent for a memory-on
 * device turn (apps/api/src/workflows/workflow-voice-turn.ts), with every capability tool bound to stub
 * callbacks that return minimal schema-valid results (empty lists, a fixed
 * fake id). Selection is scored on step 1, so the stubs only need to keep the
 * tool loop well-formed. Mirrors docs/perf/394/evidence/measure-prompt.mts.
 */
import type { Tool, ToolLoopAgent } from 'ai';
import { assistantTools, createBobAgent, type TurnMode } from '../src/agents.ts';
import { createDeviceTools, type DeviceCallbacks } from '../src/device-tools.ts';
import { createMemoryTools, type MemoryToolCallbacks } from '../src/memory-tools.ts';
import {
  createProductivityTools,
  createSpaceMemberTools,
  type AgendaItem,
  type ProductivityCallbacks,
  type TaskSummary,
} from '../src/productivity-tools.ts';
import { createTimerTools, type TimerCallbacks, type TimerView } from '../src/timer-tools.ts';
import { createVoiceTools, type ReminderLine, type VoiceCallbacks, type NoteContent } from '../src/voice-tools.ts';

/** The fixed fake id every stub returns. */
const FAKE_ID = 'eval-stub-1';

const memoryStubs: MemoryToolCallbacks = {
  listActions: async () => [],
  completeAction: async () => ({ completed: true, action_item_id: FAKE_ID }),
  remember: async () => ({ stored: true, memory_id: FAKE_ID, sensitive: false }),
  forget: async () => ({ deleted: 1, memory_id: FAKE_ID }),
};

/** Tasks/agenda a planning fixture seeds into list_tasks/list_agenda, shaped like the real tools'
 *  output (productivity-tools.ts). Omitted by every other suite, which gets today's empty result. */
export interface ToolEvalSeed {
  tasks?: TaskSummary[];
  agenda?: AgendaItem[];
}

const productivityStubsFor = (seed?: ToolEvalSeed): ProductivityCallbacks => ({
  listTasks: async () => seed?.tasks ?? [],
  createTask: async () => ({ taskId: FAKE_ID }),
  completeTask: async () => ({ taskId: FAKE_ID }),
  updateTask: async () => ({ taskId: FAKE_ID }),
  listAgenda: async () => seed?.agenda ?? [],
  createEvent: async () => ({ eventId: FAKE_ID }),
  notifyEmail: async () => ({ noteId: FAKE_ID, delivery: 'queued' }),
});

const TIMER: TimerView = {
  id: FAKE_ID,
  kind: 'timer',
  label: null,
  firesAtIso: '2026-01-01T00:05:00.000Z',
  remainingMs: 300_000,
  localTime: '00:05',
};

const timerStubs: TimerCallbacks = {
  setTimer: async () => TIMER,
  setAlarm: async () => ({ ...TIMER, kind: 'alarm' }),
  listTimers: async () => [],
  cancelTimers: async () => ({ cancelled: [TIMER], remaining: 0 }),
};

const REMINDER: ReminderLine = { id: FAKE_ID, title: 'reminder', when: 'tomorrow at 9 am', repeat: null };
const NOTE: NoteContent = { id: FAKE_ID, title: 'note', body: '' };

const voiceStubs: VoiceCallbacks = {
  createReminder: async () => REMINDER,
  listReminders: async () => [],
  cancelReminder: async () => REMINDER,
  createNote: async () => NOTE,
  appendNote: async () => NOTE,
  readNote: async () => NOTE,
  search: async () => [],
  readInbox: async () => ({ unread: 0, items: [] }),
};

const deviceStubs: DeviceCallbacks = {
  setVolume: async (input) => ({ volume: input.level ?? 5, muted: input.mute ?? false }),
  setMode: async (input) => ({ mode: input.mode }),
  express: async () => undefined,
};

/** Memory tools, as createMemoryTools builds them for a memory-on account. */
function evalMemoryTools(): Record<string, Tool> {
  return createMemoryTools(memoryStubs);
}

/** Capability tools in production order: timers lead, then productivity (with list_space_members, as a
 *  turn in an active Space has it). `seed`, when given, is what list_tasks/list_agenda return. */
function evalCapabilityTools(seed?: ToolEvalSeed): Record<string, Tool> {
  return {
    ...createTimerTools(timerStubs),
    ...createProductivityTools(productivityStubsFor(seed)),
    ...createSpaceMemberTools({ listSpaceMembers: async () => [] }),
  };
}

/** The conditional tools a device turn adds last, after memory: voice, then device. */
function evalLateTools(): Record<string, Tool> {
  return {
    ...createVoiceTools(voiceStubs),
    ...createDeviceTools(deviceStubs),
  };
}

/**
 * The per-turn agent with the full memory-on device-turn tool set, anchored to
 * UTC unless `timeZone` is given; `memoryContext` is the `[BOB MEMORY …]`
 * block production retrieval would add; `mode` is the TURN_PROFILES row (and
 * so the reply style) the turn uses, `unpaired` (no style) by default; `seed`
 * is what list_tasks/list_agenda return (PLAN-SEED), empty by default.
 */
export function buildToolEvalAgent(
  opts: { memoryContext?: string; timeZone?: string; mode?: TurnMode; seed?: ToolEvalSeed } = {},
): ToolLoopAgent {
  return createBobAgent({
    memoryTools: evalMemoryTools(),
    capabilityTools: evalCapabilityTools(opts.seed),
    lateTools: evalLateTools(),
    timeZone: opts.timeZone ?? 'UTC',
    ...(opts.memoryContext ? { memoryContext: opts.memoryContext } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
}

/** Tool names in production order: base, capability, memory, then the late tools. */
export function toolEvalRegistry(): string[] {
  return Object.keys(toolEvalTools());
}

/** The registry tools with their input schemas, for offline fixture checks. */
export function toolEvalTools(): Record<string, Tool> {
  return { ...assistantTools, ...evalCapabilityTools(), ...evalMemoryTools(), ...evalLateTools() };
}
