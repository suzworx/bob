import { type ToolUIPart, type DynamicToolUIPart, type UIMessage, isToolUIPart, getToolName } from 'ai';
import type { ChatToolCallItem } from '@astryxdesign/core/Chat';
import type { ResourceKind } from '../../app/routes';
import { z } from 'zod';

export function isToolPart(
  part: UIMessage['parts'][number],
): part is ToolUIPart | DynamicToolUIPart {
  return isToolUIPart(part);
}

// What each of Bob's tools does, in plain words: the reader never sees a raw
// tool name (createTask) or a raw error. A tool with no entry gets a neutral
// line rather than its name.
const TOOL_LABELS: Record<string, { running: string; done: string }> = {
  create_task: { running: 'Adding a task', done: 'Added a task' },
  update_task: { running: 'Updating a task', done: 'Updated a task' },
  complete_task: { running: 'Ticking off a task', done: 'Ticked off a task' },
  list_tasks: { running: 'Checking your tasks', done: 'Checked your tasks' },
  create_note: { running: 'Writing a note', done: 'Wrote a note' },
  append_note: { running: 'Adding to a note', done: 'Added to a note' },
  read_note: { running: 'Reading a note', done: 'Read a note' },
  create_event: { running: 'Adding an event', done: 'Added an event' },
  list_agenda: { running: 'Checking your calendar', done: 'Checked your calendar' },
  create_reminder: { running: 'Setting a reminder', done: 'Set a reminder' },
  cancel_reminder: { running: 'Cancelling a reminder', done: 'Cancelled a reminder' },
  list_reminders: { running: 'Checking your reminders', done: 'Checked your reminders' },
  set_timer: { running: 'Starting a timer', done: 'Started a timer' },
  set_alarm: { running: 'Setting an alarm', done: 'Set an alarm' },
  cancel_timer: { running: 'Stopping a timer', done: 'Stopped a timer' },
  list_timers: { running: 'Checking your timers', done: 'Checked your timers' },
  remember: { running: 'Remembering that', done: 'Remembered that' },
  forget: { running: 'Forgetting that', done: 'Forgot that' },
  search: { running: 'Looking that up', done: 'Looked that up' },
  read_inbox: { running: 'Checking your email', done: 'Checked your email' },
  list_space_members: { running: 'Checking who is in the space', done: 'Checked who is in the space' },
  list_actions: { running: 'Checking your suggestions', done: 'Checked your suggestions' },
  complete_action: { running: 'Finishing a suggestion', done: 'Finished a suggestion' },
  set_volume: { running: 'Changing the volume', done: 'Changed the volume' },
  set_mode: { running: 'Changing how the device listens', done: 'Changed how the device listens' },
  currentDateTime: { running: 'Checking the time', done: 'Checked the time' },
};
const FALLBACK_LABEL = { running: 'Working on it', done: 'Done' };
const TOOL_FAILED = "Couldn't finish that";
const TOOL_DECLINED = 'Not allowed';

/** The plain words a tool call shows: what it is doing, or what it did. */
function toolCallLabel(toolName: string, finished: boolean): string {
  const labels = TOOL_LABELS[toolName] ?? FALLBACK_LABEL;
  return finished ? labels.done : labels.running;
}

export function toToolCall(part: ToolUIPart | DynamicToolUIPart): ChatToolCallItem {
  const toolName = getToolName(part);
  const key = part.toolCallId;

  let status: ChatToolCallItem['status'];
  let errorMessage: string | undefined;

  if (part.state === 'input-streaming') {
    status = 'pending';
  } else if (
    part.state === 'input-available' ||
    part.state === 'approval-requested' ||
    part.state === 'approval-responded'
  ) {
    status = 'running';
  } else if (part.state === 'output-available') {
    status = 'complete';
  } else if (part.state === 'output-error') {
    status = 'error';
    errorMessage = TOOL_FAILED;
  } else if (part.state === 'output-denied') {
    status = 'error';
    errorMessage = TOOL_DECLINED;
  } else {
    // unknown future state
    status = 'running';
  }

  return {
    name: toolCallLabel(toolName, status === 'complete'),
    status,
    key,
    ...(errorMessage !== undefined && { errorMessage }),
  };
}

/** An item a tool created or changed, and the space it lives in. */
export type ResourceRef = {
  key: string;
  kind: ResourceKind;
  id: string;
  spaceId: string;
  title: string | null;
};

const RESOURCE_ID_KEYS = [
  ['taskId', 'task'],
  ['eventId', 'event'],
  ['noteId', 'note'],
  ['reminderId', 'reminder'],
] as const satisfies ReadonlyArray<readonly [string, ResourceKind]>;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

// Tool output is untrusted: only a finished call whose output names exactly one
// item and its space links anywhere. A failed, denied or still-running call,
// or an output with no space to open it in, yields nothing.
export function toResourceRef(part: ToolUIPart | DynamicToolUIPart): ResourceRef | null {
  if (part.state !== 'output-available') return null;
  const output: unknown = part.output;
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return null;
  const fields = output as Record<string, unknown>;
  // The tools report a handled failure as { ok: false, reason } inside a finished call.
  if (fields.ok === false) return null;
  const spaceId = nonEmptyString(fields.spaceId);
  if (spaceId === null) return null;
  const found = RESOURCE_ID_KEYS.flatMap(([field, kind]) => {
    const id = nonEmptyString(fields[field]);
    return id === null ? [] : [{ kind, id }];
  });
  if (found.length !== 1 || found[0] === undefined) return null;
  return { key: part.toolCallId, ...found[0], spaceId, title: nonEmptyString(fields.title) };
}

const appProposalReceipt = z.object({
  ok: z.literal(true), untrusted: z.literal(true),
  data: z.object({ id: z.uuid(), title: z.string().min(1).max(120), status: z.literal('draft'),
    revision: z.number().int().positive(), url: z.string(), requiresApply: z.literal(false) }),
});
const specialistReceipts = z.object({ ok: z.boolean(), receipts: z.array(z.object({ tool: z.string(), output: z.unknown() })).max(100) });
export type AppProposalRef = { id: string; title: string; revision: number };

function writeOutputs(part: ToolUIPart | DynamicToolUIPart, specialist: string, tool: string): unknown[] {
  if (part.state !== 'output-available') return [];
  const name = getToolName(part);
  if (name === tool) return [part.output];
  if (name !== specialist) return [];
  const nested = specialistReceipts.safeParse(part.output);
  return nested.success ? nested.data.receipts.filter((receipt) => receipt.tool === tool).map((receipt) => receipt.output) : [];
}
/** Saved write receipts identify proposals; prose and arbitrary tool data never grant actions. */
export function toAppProposals(part: ToolUIPart | DynamicToolUIPart): AppProposalRef[] {
  return writeOutputs(part, 'apps_agent', 'propose_bob_app').flatMap((output) => {
    const parsed = appProposalReceipt.safeParse(output);
    if (!parsed.success || parsed.data.data.url !== `/apps/${parsed.data.data.id}`) return [];
    const { id, title, revision } = parsed.data.data;
    return [{ id, title, revision }];
  });
}

const savedWeekReceipt = z.object({ ok: z.literal(true), untrusted: z.literal(true), data: z.object({
  receipt: z.object({ kind: z.literal('campaign.week_plan'), campaignId: z.uuid(), draftId: z.null(), revision: z.number().int().positive() }),
  postCount: z.number().int().min(1).max(7),
}) });
/** A completed compound save is evidence of a week; a row count or failed write is not. */
export function hasSavedWeek(part: ToolUIPart | DynamicToolUIPart): boolean {
  return writeOutputs(part, 'marketing_agent', 'save_week_plan').some((output) => savedWeekReceipt.safeParse(output).success);
}
