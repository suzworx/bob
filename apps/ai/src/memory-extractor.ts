/**
 * Memory extraction (spec 010, R3/R10): turns a finished conversation turn
 * into memory operations ({add, update, supersede, noop}) via the AI SDK
 * structured-output path. Lives in apps/ai because apps/api must not call
 * providers (AGENTS.md layer rule). Pure: no DB imports and no journal. The
 * model is injectable.
 */
import { MEMORY_CONTENT_STYLE } from './memory-style.ts';
import { generateText, Output, type LanguageModel } from 'ai';
import { z } from 'zod';
import { chatModel, gateway } from './agents.ts';
import { isSecretLike } from './memory-safety.ts';
import { agentTelemetry, traceSpan } from './telemetry.ts';

/** Env override for the extraction model id, read in config.ts style. */
const BOB_MEMORY_EXTRACT_MODEL = process.env.BOB_MEMORY_EXTRACT_MODEL ?? '';

/** The four memory kinds (data-model.md §2). */
const memoryKindSchema = z.enum(['fact', 'preference', 'intent', 'action_item']);

/** The kinds automatic extraction may add: durable knowledge only, never intent or action_item.
 * memoryKindSchema keeps all four so stored rows still load. */
const durableMemoryKindSchema = z.enum(['fact', 'preference']);
type DurableMemoryKind = z.infer<typeof durableMemoryKindSchema>;

/** The shared op schema (research R10): `add` carries kind/confidence and an
 * action_item-only `due_at`; `update` and `supersede` carry id/content/
 * confidence; `noop` carries only an id. Content is 1-2000 chars after trim
 * and confidence is 0..1 (data-model.md §8). */
export const memoryOpSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('add'),
      kind: memoryKindSchema,
      content: z.string().trim().min(1).max(2000),
      confidence: z.number().min(0).max(1),
      due_at: z.string().datetime({ offset: true }).optional(),
    })
    .superRefine((value, ctx) => {
      if (value.due_at !== undefined && value.kind !== 'action_item') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'due_at is only allowed on action_item adds',
        });
      }
    }),
  z.object({
    op: z.literal('update'),
    id: z.string().min(1),
    content: z.string().trim().min(1).max(2000),
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    op: z.literal('supersede'),
    id: z.string().min(1),
    content: z.string().trim().min(1).max(2000),
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    op: z.literal('noop'),
    id: z.string().min(1),
  }),
]);

type MemoryKind = z.infer<typeof memoryKindSchema>;
export type MemoryOp = z.infer<typeof memoryOpSchema>;

/** The full extraction output contract, used by tests and as the model-facing
 * shape. The SDK call itself parses against a permissive envelope so one
 * malformed op is dropped rather than failing the whole extraction. */
export const memoryExtractionSchema = z.object({ ops: z.array(memoryOpSchema).default([]) });

/** An existing memory the model compares against (research R10). */
export interface ExistingMemory {
  id: string;
  kind: MemoryKind;
  content: string;
}

/** One earlier conversation turn, oldest first. */
interface PriorTurn {
  user: string;
  assistant: string;
}

export interface ExtractInput {
  userText: string;
  assistantText: string;
  existing: ExistingMemory[];
  now: Date;
  /** Earlier turns the memory may depend on. Absent or empty leaves the
   * prompt byte-identical to the single-turn prompt. */
  priorTurns?: PriorTurn[];
}

export interface ExtractResult {
  ops: MemoryOp[];
  dropped: { secret: number; sensitive: number };
  /** Adds dropped for not quoting the user, and adds that duplicated a live memory (now noops). Counts only. */
  rejected?: {
    ungrounded: number;
    duplicate: number;
    /** Updates/supersedes not quoting the user, and ones that only narrowed their memory; both became noops. */
    changesUngrounded?: number;
    narrowed?: number;
  };
  /** Token counts of the extraction call (all steps). Counts only. */
  usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined };
  /** The model that answered (`response.modelId`), for the journal. */
  modelId?: string;
}

type SensitiveCategory = 'health' | 'finance' | 'government_id' | 'account';

/** Sensitive categories automatic extraction must never store (FR-017):
 * health, finance, government IDs, and non-secret account details. */
const SENSITIVE_PATTERNS: Array<[SensitiveCategory, RegExp]> = [
  [
    'health',
    /\b(?:diagnosed with|allergic to|medical condition|prescription|medication|blood pressure|blood sugar|chemotherapy|therapy for|mental health|depression|anxiety|diabetes|asthma)\b/i,
  ],
  [
    'finance',
    /\b(?:salary|income|credit card|debit card|bank account|bank balance|mortgage|loan|debt|investment|portfolio|net worth|tax return|pension)\b/i,
  ],
  [
    'government_id',
    /\b(?:aadhaar|social security|ssn|passport number|driver[’']s license|pan card|government id|voter id)\b/i,
  ],
  [
    'account',
    /\b(?:username|user id|login id|account number|banking with|email address)\b/i,
  ],
];

/** Returns the sensitive category of `text`, or null when it is not a
 * sensitive category (FR-017). Pure and deterministic. */
export function sensitiveCategory(text: string): SensitiveCategory | null {
  for (const [category, pattern] of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      return category;
    }
  }
  return null;
}

/** The explicit envelope the SDK parses. Strict structured-output providers
 * require every property to be present and typed, so absent fields are
 * `.nullable()` (not `.optional()`) and there is no `.default([])`. Each item
 * is still re-validated per-item against `memoryOpSchema`; `null` is mapped to
 * `undefined` before that parse so the existing op schema is unchanged.
 * There is no `due_at`: a memory is timeless (memoryOpSchema still accepts it so
 * stored rows parse). `kind` offers only the durable kinds, with no `.catch`
 * fallback: that makes `kind` optional in the JSON Schema, which strict providers reject.
 * `evidence` quotes the user's words an add, update or supersede comes from; ungrounded ones
 * (groundedInUser) are dropped or noop. The op schema strips it, so stored ops are unchanged. */
const extractionOpEnvelopeSchema = z.object({
  op: z.enum(['add', 'update', 'supersede', 'noop']),
  id: z.string().nullable(),
  kind: durableMemoryKindSchema.nullable(),
  content: z.string().nullable(),
  confidence: z.number().nullable(),
  evidence: z.string().nullable(),
});

export const extractionEnvelopeSchema = z.object({ ops: z.array(extractionOpEnvelopeSchema) });

/** Short system prompt for the extraction call (R3: off the voice path). A timed request is a
 * reminder the voice turn schedules with create_reminder, so it yields no memory op. */
export const MEMORY_EXTRACT_SYSTEM_PROMPT =
  'You are the memory subsystem of a voice assistant. Extract durable knowledge ' +
  'about the USER only: facts (lasting truths about their life) and preferences ' +
  '(lasting likes, dislikes and habits) that will still hold in future conversations. ' +
  'What the user asks, wants or plans within this conversation is conversation, not ' +
  'knowledge about them: it adds no memory and changes no existing memory. Only what ' +
  'the user states about themselves does. A memory is timeless: it never carries a ' +
  'time at which the user should be told something. Anything tied to such a time is ' +
  'a reminder, and a to-do is a task; both are handled elsewhere and yield no op. ' +
  'Reconcile with the existing memories: noop when the turn only restates one, ' +
  'update when it adds detail to one that stays true, and supersede when it makes ' +
  'one no longer true (a contradiction or correction the user states). Never narrow ' +
  'or split an existing memory: dropping part of it is not a supersede. Never fabricate. ' +
  'A memory may only come from what the USER said. The assistant\'s words are ' +
  'context for interpreting the user (for example what a "yes" answers), never a ' +
  'source: a fact the assistant states or repeats yields no op. Every add, update ' +
  'and supersede carries evidence: the exact words of the user it comes from, quoted verbatim. ' +
  'Never output passwords, passcodes, PINs, API keys, or secrets. Do not extract ' +
  'health, financial, government-ID, or account-detail information. ' +
  MEMORY_CONTENT_STYLE;

/** Builds the extraction user prompt. Exported for the byte-identity test: without `priorTurns` the output must not change. */
export function buildPrompt({ userText, assistantText, existing, now, priorTurns }: ExtractInput): string {
  const lines = [
    'Extract memory operations from this turn. Compare against the existing memories and prefer update, supersede, or noop over adding a duplicate.',
    `Today is ${now.toISOString()}.`,
    existing.length === 0
      ? 'Existing memories: none.'
      : ['Existing memories (id, kind, content):', ...existing.map((m) => `- ${m.id} (${m.kind}): ${m.content}`)].join('\n'),
  ];
  if (priorTurns !== undefined && priorTurns.length > 0) {
    lines.push(
      [
        'Earlier turns, oldest first (context only):',
        ...priorTurns.map((t) => (t.assistant === '' ? `- User: ${t.user}` : `- User: ${t.user} | Assistant: ${t.assistant}`)),
      ].join('\n'),
    );
  }
  lines.push(`User said: ${userText}`);
  if (assistantText !== '') {
    lines.push(`Assistant said (context only, never a source of memory): ${assistantText}`);
  }
  lines.push(
    'Return JSON only: { "ops": [ { "op": "add", "kind": "fact|preference", "content": "...", "confidence": 0.0-1.0, "evidence": "<the user\'s exact words>" }, { "op": "update", "id": "...", "content": "...", "confidence": 0.0-1.0, "evidence": "<the user\'s exact words>" }, { "op": "supersede", "id": "...", "content": "...", "confidence": 0.0-1.0, "evidence": "<the user\'s exact words>" }, { "op": "noop", "id": "..." } ] }.',
  );
  return lines.join('\n');
}

/** Default extraction model: BOB_MEMORY_EXTRACT_MODEL overrides the chat model.
 *  The memory judge (memory-judge.ts) uses the same model. */
export function resolveExtractModel(): LanguageModel {
  return BOB_MEMORY_EXTRACT_MODEL !== '' ? gateway(BOB_MEMORY_EXTRACT_MODEL) : chatModel;
}

/** Maps top-level `null` fields to `undefined` so the existing `memoryOpSchema`
 * (which uses `.optional()`) parses envelope items unchanged. */
function nullToUndefined(item: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(item)) {
    if (item[key] === null) {
      item[key] = undefined;
    }
  }
  return item;
}

/** Applies the FR-018 secret and FR-017 sensitive filters to every op with
 * content. Matches are dropped and counted; the text is never logged. */
function filterOps(ops: MemoryOp[]): { ops: MemoryOp[]; dropped: { secret: number; sensitive: number } } {
  let secret = 0;
  let sensitive = 0;
  const kept: MemoryOp[] = [];
  for (const op of ops) {
    const content = 'content' in op ? op.content : null;
    if (content !== null && isSecretLike(content)) {
      secret += 1;
    } else if (content !== null && sensitiveCategory(content) !== null) {
      sensitive += 1;
    } else {
      kept.push(op);
    }
  }
  return { ops: kept, dropped: { secret, sensitive } };
}

/** Share of the evidence's words that must appear in the user's words. Below 1 so an expanded
 * contraction or a dropped filler word still counts; a quote of the assistant shares almost none. */
export const EVIDENCE_MIN_COVERAGE = 0.8;

/** Share of an add's knowledge words that must already be in one live memory for it to be a
 * duplicate. 1: a single new word (brother vs sister, Munich vs Berlin) keeps it an add. */
export const DUPLICATE_MIN_CONTAINMENT = 1;

/** Words that carry no knowledge about the user. Negations are not here: they
 * are compared separately so "is vegetarian" never duplicates "is not". */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'user', 'users', 's', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'and', 'or', 'of',
  'to', 'in', 'on', 'at', 'for', 'with', 'by', 'as', 'that', 'this', 'who', 'which', 'has', 'have', 'had',
  'does', 'do', 'did', 'i', 'my', 'me', 'their', 'they', 'them', 'it', 'its', 'he', 'she', 'his', 'her',
]);
const NEGATIONS = new Set(['not', 'no', 'never', 'nor', 'without']);

/** Lowercase word tokens; "n't" reads as "not" so a negation is never lost. */
function wordTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/n't\b/g, ' not')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether `evidence` quotes what the user said: at least
 * EVIDENCE_MIN_COVERAGE of its words appear in `userTexts`. Missing or empty
 * evidence is not grounded. */
export function groundedInUser(evidence: string | null | undefined, userTexts: readonly string[]): boolean {
  const quoted = wordTokens(evidence ?? '');
  if (quoted.length === 0) return false;
  const said = new Set(userTexts.flatMap(wordTokens));
  return quoted.filter((word) => said.has(word)).length / quoted.length >= EVIDENCE_MIN_COVERAGE;
}

/** How many knowledge words after a negation it applies to ("does not eat
 * meat" negates eat and meat); "but" ends it early. */
const NEGATION_SCOPE = 3;

/** The knowledge words of a memory: no function words, a plural or verb `s`
 * folded ("lives" = "live"), and a word inside a negation's scope marked `!`
 * so "not vegetarian" and "vegetarian" are different words. */
function knowledgeWords(text: string): Set<string> {
  const words = new Set<string>();
  let negatedLeft = 0;
  for (const token of wordTokens(text)) {
    if (NEGATIONS.has(token)) {
      negatedLeft = NEGATION_SCOPE;
    } else if (token === 'but') {
      negatedLeft = 0;
    } else if (!FUNCTION_WORDS.has(token)) {
      const word = token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;
      words.add(negatedLeft > 0 ? `!${word}` : word);
      negatedLeft = Math.max(0, negatedLeft - 1);
    }
  }
  return words;
}

/** The id of the first live memory `content` duplicates, or null: the memory
 * holds at least DUPLICATE_MIN_CONTAINMENT of the content's knowledge words,
 * negation included. */
export function findDuplicate(content: string, existing: ReadonlyArray<{ id: string; content: string }>): string | null {
  const words = knowledgeWords(content);
  if (words.size === 0) return null;
  for (const memory of existing) {
    const other = knowledgeWords(memory.content);
    const shared = [...words].filter((word) => other.has(word)).length;
    if (shared / words.size >= DUPLICATE_MIN_CONTAINMENT) return memory.id;
  }
  return null;
}

/** Whether `content`, replacing memory `id`, says nothing that memory does not ("Indian" for
 * "Indian and vegetarian"): findDuplicate against that one memory. An unknown id is not. */
export function narrowsMemory(content: string, id: string, existing: ReadonlyArray<{ id: string; content: string }>): boolean {
  return findDuplicate(content, existing.filter((memory) => memory.id === id)) !== null;
}

/** Turns every add that duplicates a live memory into a noop on it. */
function dedupeAdds(
  ops: readonly MemoryOp[],
  existing: ReadonlyArray<{ id: string; content: string }>,
): { ops: MemoryOp[]; duplicate: number } {
  let duplicate = 0;
  const out = ops.map((op): MemoryOp => {
    if (op.op !== 'add') return op;
    const id = findDuplicate(op.content, existing);
    if (id === null) return op;
    duplicate += 1;
    return { op: 'noop', id };
  });
  return { ops: out, duplicate };
}

/**
 * Creates the extraction function for a model (the chat model by default,
 * overridable via BOB_MEMORY_EXTRACT_MODEL). Pure: it neither imports the
 * DB nor journals; the caller owns scheduling and persistence.
 */
export function createMemoryExtractor(model: LanguageModel = resolveExtractModel()) {
  return async function extract(input: ExtractInput): Promise<ExtractResult> {
    const result = await traceSpan('bob-memory-extractor', { observationType: 'chain' }, () => generateText({
      model,
      telemetry: { ...agentTelemetry, functionId: 'bob-memory-extractor' },
      output: Output.object({ schema: extractionEnvelopeSchema }),
      system: MEMORY_EXTRACT_SYSTEM_PROMPT,
      prompt: buildPrompt(input),
    }));
    // Earlier user turns count as the user's words: a fact can span turns.
    const userTexts = [input.userText, ...(input.priorTurns ?? []).map((turn) => turn.user)];
    const ops: MemoryOp[] = [];
    let ungrounded = 0;
    let changesUngrounded = 0;
    let narrowed = 0;
    for (const item of result.output.ops) {
      const evidence = item.evidence;
      const parsed = memoryOpSchema.safeParse(nullToUndefined(item as Record<string, unknown>));
      if (!parsed.success) continue;
      const op = parsed.data;
      if (op.op === 'add' && !groundedInUser(evidence, userTexts)) {
        ungrounded += 1;
        continue;
      }
      if (op.op === 'update' || op.op === 'supersede') {
        // A change needs the user's words too and must add something: one that only narrows or splits the memory is a noop.
        if (!groundedInUser(evidence, userTexts)) {
          changesUngrounded += 1;
          ops.push({ op: 'noop', id: op.id });
          continue;
        }
        if (narrowsMemory(op.content, op.id, input.existing)) {
          narrowed += 1;
          ops.push({ op: 'noop', id: op.id });
          continue;
        }
      }
      ops.push(op);
    }
    const filtered = filterOps(ops);
    const deduped = dedupeAdds(filtered.ops, input.existing);
    const usage = result.totalUsage ?? result.usage;
    return {
      ops: deduped.ops,
      dropped: filtered.dropped,
      rejected: { ungrounded, duplicate: deduped.duplicate, changesUngrounded, narrowed },
      usage: { inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens },
      modelId: result.response?.modelId,
    };
  };
}
