/**
 * The memory row model: types, row mapping and validation shared by store.ts
 * and matching.ts. Timestamps are timestamptz read back as epoch-ms; the keyset
 * cursor encodes created_at at microsecond precision plus the id, so
 * pagination stays exact when two rows share a millisecond.
 */
import { StoreError } from '../platform/db/db.ts';
import type { JournalFields } from '../platform/logger.ts';

export type MemoryKind = 'fact' | 'preference' | 'intent' | 'action_item';

export type MemorySurface = 'web_text' | 'web_voice' | 'device';

type MatchSource = 'both' | 'full_text' | 'semantic';

export type StoredMemory = {
  id: string;
  kind: MemoryKind;
  content: string;
  confidence: number;
  sensitive: boolean;
  conversationId: string | null;
  messageId: string | null;
  surface: MemorySurface;
  supersededBy: string | null;
  embeddingModel: string | null;
  embeddingDim: number | null;
  createdAt: number;
  updatedAt: number;
};

export type MemoryMatch = {
  id: string;
  kind: MemoryKind;
  content: string;
  confidence: number;
  sensitive: boolean;
  conversationId: string | null;
  messageId: string | null;
  surface: MemorySurface;
  createdAt: number;
  matchSource: MatchSource;
  score: number;
};

export type MemoryEmbedding = {
  values: number[];
  model: string;
  dim: number;
};

export type NewMemory = {
  id?: string;
  kind: MemoryKind;
  content: string;
  confidence: number;
  sensitive?: boolean;
  conversationId?: string | null;
  messageId?: string | null;
  surface?: MemorySurface;
  supersededBy?: string | null;
  embedding?: MemoryEmbedding | null;
  /** Omitted or null means the owner's private space. */
  spaceId?: string | null;
};

type ExtractionAddOp = {
  op: 'add';
  kind: MemoryKind;
  content: string;
  confidence: number;
  sensitive?: boolean;
  /** Epoch ms; action_item only. */
  dueAt?: number | null;
  embedding?: MemoryEmbedding | null;
};

type ExtractionUpdateOp = {
  op: 'update';
  id: string;
  content: string;
  confidence?: number;
  sensitive?: boolean;
  embedding?: MemoryEmbedding | null;
};

type ExtractionSupersedeOp = {
  op: 'supersede';
  id: string;
  kind?: MemoryKind;
  content: string;
  confidence: number;
  sensitive?: boolean;
  embedding?: MemoryEmbedding | null;
};

type ExtractionNoopOp = {
  op: 'noop';
  id: string;
  /** Set when the memory judge found the content already held by `id`, so
   *  the write is journaled as a deduplicated one (guard "judge"). */
  judged?: boolean;
};

export type ExtractionOp =
  | ExtractionAddOp
  | ExtractionUpdateOp
  | ExtractionSupersedeOp
  | ExtractionNoopOp;

export type ExtractionSource = {
  conversationId: string | null;
  messageId: string | null;
  surface: MemorySurface;
  /** Omitted means the owner's private space. */
  spaceId?: string | null;
};

type MemoryWritePath = 'remember' | 'extract' | 'manual';

/** What stopped a duplicate: nothing, the findDuplicate check, the unique
 *  index when a write raced past the check, or the memory judge (a paraphrase
 *  the lexical check cannot see). */
type MemoryWriteGuard = 'none' | 'find_duplicate' | 'unique_index' | 'judge';

/** Metadata-only journal sink (ids, enums and counts; never content). */
export type MemoryJournal = (event: string, fields: JournalFields) => void;

export type ApplyExtractionOptions = {
  source: ExtractionSource;
  /** When set, memory_extracted_at is written in the same transaction. */
  markMessageId?: string | null;
  /** Defaults to extract. */
  path?: MemoryWritePath;
  /** Defaults to the server journal. */
  journal?: MemoryJournal;
};

/** The store's decision for one op: the row it ended on, what it did, and the
 *  current row it found the content already in (`dupOf`), if any. */
export type AppliedOp = {
  op: 'add' | 'update' | 'supersede' | 'noop';
  memoryId: string | null;
  targetId: string | null;
  dupOf: string | null;
  guard: MemoryWriteGuard;
};

export type ListMemoriesOptions = {
  limit?: number;
  cursor?: string;
  kind?: MemoryKind;
  sensitive?: boolean;
  q?: string;
  currentOnly?: boolean;
};

export type MemoryRow = {
  id: unknown;
  kind: unknown;
  content: unknown;
  confidence: unknown;
  sensitive: unknown;
  conversationId: unknown;
  messageId: unknown;
  surface: unknown;
  supersededBy: unknown;
  embeddingModel: unknown;
  embeddingDim: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  createdUs: unknown;
};

export type MatchRow = {
  id: unknown;
  kind: unknown;
  content: unknown;
  confidence: unknown;
  sensitive: unknown;
  conversationId: unknown;
  messageId: unknown;
  surface: unknown;
  createdAt: unknown;
  matchSource: unknown;
  score: unknown;
};

export type MemoryCorrection = {
  content: string;
  confidence?: number;
  sensitive?: boolean;
};

export type MatchOptions = {
  queryText: string;
  queryEmbedding: number[];
  matchCount: number;
  /** Cosine-distance floor. Omitted or null: no floor and additive recency.
   *  Only the retrieval path passes one; the extraction dedup lookup must keep
   *  every candidate. */
  maxDistance?: number | null;
};

export type MatchFullTextOptions = {
  queryText: string;
  matchCount: number;
  /** Recency as a tie-break only; the retrieval path sets it when its floor is on. */
  recencyTieBreak?: boolean;
};

/** 'target' (forget query targeting): text rank only, strictly above the
 *  floor, with a margin. 'remember': the recency-inclusive score, top row at or
 *  above the floor, no margin. */
export type MatchPath = 'target' | 'remember';

const MEMORY_KINDS: readonly MemoryKind[] = ['fact', 'preference', 'intent', 'action_item'];

const MEMORY_SURFACES: readonly MemorySurface[] = ['web_text', 'web_voice', 'device'];

const MATCH_SOURCES: readonly MatchSource[] = ['both', 'full_text', 'semantic'];

const DEFAULT_LIST_LIMIT = 50;

export const MAX_LIST_LIMIT = 100;

/** The degraded-path recency term. */
export const RECENCY_WEIGHT = 0.15;

export const RECENCY_HALF_LIFE_DAYS = 30;

/** The memory columns with timestamptz → epoch-ms read-back plus the
 *  microsecond boundary used by the keyset cursor (createdUs). */
export const MEMORY_COLUMNS = `id, kind, content, confidence, sensitive,
  conversation_id AS "conversationId", message_id AS "messageId", surface,
  superseded_by AS "supersededBy", embedding_model AS "embeddingModel",
  embedding_dim AS "embeddingDim",
  floor(extract(epoch from created_at) * 1000)::bigint AS "createdAt",
  floor(extract(epoch from updated_at) * 1000)::bigint AS "updatedAt",
  floor(extract(epoch from created_at) * 1000000)::bigint AS "createdUs"`;

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

function isMemorySurface(value: unknown): value is MemorySurface {
  return typeof value === 'string' && (MEMORY_SURFACES as readonly string[]).includes(value);
}

function isMatchSource(value: unknown): value is MatchSource {
  return typeof value === 'string' && (MATCH_SOURCES as readonly string[]).includes(value);
}

export function toKind(value: unknown): MemoryKind {
  return isMemoryKind(value) ? value : 'fact';
}

function toSurface(value: unknown): MemorySurface {
  return isMemorySurface(value) ? value : 'web_text';
}

function toMatchSource(value: unknown): MatchSource {
  return isMatchSource(value) ? value : 'full_text';
}

/** 1-2000 chars after trim, so a runaway extraction cannot store an essay. */
export function isMemoryContent(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 2000;
}

export function isConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isEmbedding(value: unknown): value is MemoryEmbedding | null | undefined {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object') return false;
  const embedding = value as { values?: unknown; model?: unknown; dim?: unknown };
  return (
    Array.isArray(embedding.values) &&
    embedding.values.every((entry) => typeof entry === 'number' && Number.isFinite(entry)) &&
    typeof embedding.model === 'string' &&
    embedding.model.length > 0 &&
    typeof embedding.dim === 'number' &&
    Number.isInteger(embedding.dim) &&
    embedding.dim > 0
  );
}

/** Full precision: no rounding. */
export function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

export function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/** `${createdUs hex}-${id}`, so it stays within the OpaqueId bound `^[A-Za-z0-9_-]{8,64}$`. */
export function encodeCursor(createdUs: number, id: string): string {
  return `${createdUs.toString(16)}-${id}`;
}

/** Null for anything malformed (never throws). */
export function decodeCursor(cursor: string): { createdUs: number; id: string } | null {
  const separator = cursor.indexOf('-');
  if (separator <= 0) return null;
  const createdUs = Number.parseInt(cursor.slice(0, separator), 16);
  const id = cursor.slice(separator + 1);
  if (!Number.isSafeInteger(createdUs) || createdUs <= 0 || id.length === 0) return null;
  return { createdUs, id };
}

export function rowToMemory(row: MemoryRow): StoredMemory {
  return {
    id: String(row.id),
    kind: toKind(row.kind),
    content: String(row.content),
    confidence: Number(row.confidence),
    sensitive: Boolean(row.sensitive),
    conversationId: row.conversationId === null ? null : String(row.conversationId),
    messageId: row.messageId === null ? null : String(row.messageId),
    surface: toSurface(row.surface),
    supersededBy: row.supersededBy === null ? null : String(row.supersededBy),
    embeddingModel: row.embeddingModel === null ? null : String(row.embeddingModel),
    embeddingDim: row.embeddingDim === null ? null : Number(row.embeddingDim),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export function rowToMatch(row: MatchRow): MemoryMatch {
  return {
    id: String(row.id),
    kind: toKind(row.kind),
    content: String(row.content),
    confidence: Number(row.confidence),
    sensitive: Boolean(row.sensitive),
    conversationId: row.conversationId === null ? null : String(row.conversationId),
    messageId: row.messageId === null ? null : String(row.messageId),
    surface: toSurface(row.surface),
    createdAt: Number(row.createdAt),
    matchSource: toMatchSource(row.matchSource),
    score: Number(row.score),
  };
}

/** Validates an ops array before it touches SQL; a malformed op fails fast
 *  with a StoreError instead of a check-constraint error mid-transaction. */
export function validateExtractionOps(ops: readonly ExtractionOp[]): void {
  for (const op of ops) {
    if (typeof op !== 'object' || op === null) {
      throw new StoreError('invalid memory op: expected an object');
    }
    switch (op.op) {
      case 'add':
        if (!isMemoryKind(op.kind)) throw new StoreError('invalid memory op: add kind');
        if (!isMemoryContent(op.content)) throw new StoreError('invalid memory op: add content');
        if (!isConfidence(op.confidence)) throw new StoreError('invalid memory op: add confidence');
        if (op.kind !== 'action_item' && op.dueAt !== undefined) {
          throw new StoreError('invalid memory op: due_at is only allowed on action_item adds');
        }
        if (!isEmbedding(op.embedding)) throw new StoreError('invalid memory op: add embedding');
        break;
      case 'update':
        if (typeof op.id !== 'string' || op.id.length === 0) throw new StoreError('invalid memory op: update id');
        if (!isMemoryContent(op.content)) throw new StoreError('invalid memory op: update content');
        if (op.confidence !== undefined && !isConfidence(op.confidence)) {
          throw new StoreError('invalid memory op: update confidence');
        }
        if (!isEmbedding(op.embedding)) throw new StoreError('invalid memory op: update embedding');
        break;
      case 'supersede':
        if (typeof op.id !== 'string' || op.id.length === 0) throw new StoreError('invalid memory op: supersede id');
        if (op.kind !== undefined && !isMemoryKind(op.kind)) throw new StoreError('invalid memory op: supersede kind');
        if (!isMemoryContent(op.content)) throw new StoreError('invalid memory op: supersede content');
        if (!isConfidence(op.confidence)) throw new StoreError('invalid memory op: supersede confidence');
        if (!isEmbedding(op.embedding)) throw new StoreError('invalid memory op: supersede embedding');
        break;
      case 'noop':
        if (typeof op.id !== 'string' || op.id.length === 0) throw new StoreError('invalid memory op: noop id');
        break;
      default:
        throw new StoreError(`invalid memory op: unknown op '${String((op as { op?: unknown }).op)}'`);
    }
  }
}

export function validateSource(source: ExtractionSource): void {
  if (!isMemorySurface(source.surface)) {
    throw new StoreError('invalid extraction source: bad surface');
  }
}

export function clampListLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
}
