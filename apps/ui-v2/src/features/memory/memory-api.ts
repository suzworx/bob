// Typed client for the memory endpoints (/api/memories, /api/action-items).
// v1 keeps this inline in its memory page; the shapes and status handling here
// are copied from it. Every call goes through fetchWithAuth, so a 401 refreshes
// the session once, as elsewhere.

import { fetchWithAuth } from '@/lib/auth/use-session';

export type MemoryKind = 'fact' | 'preference' | 'intent' | 'action_item';
type MemorySurface = 'web_text' | 'web_voice' | 'device';
export type ActionItemStatus = 'open' | 'done' | 'dropped';

export type Memory = {
  id: string;
  kind: MemoryKind;
  content: string;
  confidence: number;
  sensitive: boolean;
  source: {
    conversation_id: string | null;
    message_id: string | null;
    surface: MemorySurface;
  };
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
};

export type ActionItem = {
  id: string;
  memory_id: string;
  content: string;
  confidence: number;
  status: ActionItemStatus;
  due_at: number | null;
  created_at: number;
  updated_at: number;
};

type MemoryPageResult = { memories: Memory[]; nextCursor: string | null };

// The server answers 503 when the memory feature is switched off; the page
// shows "not enabled" for that instead of a generic load failure.
export class MemoryUnavailableError extends Error {
  constructor() {
    super('memory_unavailable');
    this.name = 'MemoryUnavailableError';
  }
}

// The server refuses to store secret-like text (password, PIN, ...) with a
// 422; the page shows a dedicated message for that instead of a generic
// create/correct failure.
export class SecretRefusedError extends Error {
  constructor() {
    super('secret_refused');
    this.name = 'SecretRefusedError';
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function memoryPath(id: string): string {
  return `/api/memories/${encodeURIComponent(id)}`;
}

async function readMemoryPage(response: Response): Promise<MemoryPageResult> {
  const body = (await response.json()) as { memories: Memory[]; next_cursor: string | null };
  return { memories: body.memories, nextCursor: body.next_cursor };
}

async function isSecretRefusal(response: Response): Promise<boolean> {
  if (response.status !== 422) return false;
  const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
  return body?.error?.code === 'secret_refused';
}

function memoriesUrl(options: { q?: string; cursor?: string }): string {
  const params = new URLSearchParams();
  if (options.cursor) params.set('cursor', options.cursor);
  const q = options.q?.trim();
  if (q) params.set('q', q);
  const query = params.toString();
  return query === '' ? '/api/memories' : `/api/memories?${query}`;
}

// First page of memories, searched on the server when `q` is given. Action
// items are not part of it: they live on Today (useActionItems), and a failure
// there no longer blanks this list.
export async function listMemories(q?: string): Promise<MemoryPageResult> {
  const response = await fetchWithAuth(memoriesUrl({ q }));
  if (response.status === 503) throw new MemoryUnavailableError();
  if (!response.ok) throw new Error('list_failed');
  return readMemoryPage(response);
}

export async function listMoreMemories(cursor: string, q?: string): Promise<MemoryPageResult> {
  const response = await fetchWithAuth(memoriesUrl({ cursor, q }));
  if (!response.ok) throw new Error('load_more_failed');
  return readMemoryPage(response);
}

export async function createMemory(content: string, kind: MemoryKind): Promise<Memory> {
  const response = await fetchWithAuth('/api/memories', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ content, kind }),
  });
  if (await isSecretRefusal(response)) throw new SecretRefusedError();
  if (!response.ok) throw new Error('create_failed');
  return (await response.json()) as Memory;
}

export async function correctMemory(id: string, content: string): Promise<Memory> {
  const response = await fetchWithAuth(memoryPath(id), {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ content }),
  });
  if (await isSecretRefusal(response)) throw new SecretRefusedError();
  if (!response.ok) throw new Error('correct_failed');
  return (await response.json()) as Memory;
}

export async function deleteMemory(id: string): Promise<void> {
  const response = await fetchWithAuth(memoryPath(id), { method: 'DELETE' });
  if (response.status !== 204) throw new Error('delete_failed');
}

export async function deleteAllMemories(): Promise<void> {
  const response = await fetchWithAuth('/api/memories', { method: 'DELETE' });
  if (response.status !== 204) throw new Error('delete_all_failed');
}

// Every action item on its own, for a page that shows them without the
// memories (the Today page, #870). 503 means the memory feature is off.
export async function listActionItems(): Promise<ActionItem[]> {
  const response = await fetchWithAuth('/api/action-items');
  if (response.status === 503) throw new MemoryUnavailableError();
  if (!response.ok) throw new Error('list_failed');
  return ((await response.json()) as { action_items: ActionItem[] }).action_items;
}

// An open action item whose due date has already gone by. One rule for every
// page that marks one (Memory and Today).
export function isActionItemOverdue(item: ActionItem, now: number = Date.now()): boolean {
  return item.status === 'open' && item.due_at !== null && item.due_at < now;
}

export async function setActionItemStatus(id: string, status: ActionItemStatus): Promise<ActionItem> {
  const response = await fetchWithAuth(`/api/action-items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status }),
  });
  if (!response.ok) throw new Error('action_update_failed');
  return (await response.json()) as ActionItem;
}

type PromotedTask = { id: string };

// "Add as task": a copy of the action item's memory as an ordinary task in a
// space. The due date travels with it.
export async function promoteToTask(
  memoryId: string,
  input: { spaceId: string; title: string; dueAt: number | null },
): Promise<PromotedTask> {
  const response = await fetchWithAuth(`/api/memories/${encodeURIComponent(memoryId)}/promote`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      space_id: input.spaceId,
      title: input.title,
      ...(input.dueAt !== null ? { due_at: input.dueAt } : {}),
    }),
  });
  if (!response.ok) throw new Error('promote_failed');
  return (await response.json()) as PromotedTask;
}

type SpaceChoice = { id: string; kind: string; name: string };

// The person's own space, where a personal to-do belongs by default.
export async function findPrivateSpace(): Promise<SpaceChoice | null> {
  const response = await fetchWithAuth('/api/spaces');
  if (!response.ok) throw new Error('spaces_failed');
  const body = (await response.json()) as { spaces: SpaceChoice[] };
  return body.spaces.find((space) => space.kind === 'private') ?? null;
}
