import { z } from 'zod';
import { withUser, type Db } from '../platform/db/db.ts';
import { listGoogleAccounts } from './google-store.ts';
import type { GoogleCapability } from './google-credentials.ts';

interface AccountContext { db: Db; userId: string; conversationId: string; messageId: string }
const textPart = z.object({ type: z.literal('text'), text: z.string() });
const actionTools = new Map([
  ['gmail.search', 'google_gmail_search'], ['gmail.read_thread', 'google_gmail_read_thread'],
  ['gmail.read_draft', 'google_gmail_read_draft'], ['gmail.compose_draft', 'google_gmail_compose_draft'],
  ['gmail.update_draft', 'google_gmail_update_draft'], ['gmail.send_draft', 'google_gmail_send_draft'],
  ['gmail.trash_message', 'google_gmail_trash_message'], ['gmail.restore_message', 'google_gmail_restore_message'],
  ['gmail.draft_reply', 'google_gmail_draft_reply'], ['google calendar.list_calendars', 'google_calendar_list_calendars'],
  ['google calendar.list_events', 'google_calendar_list_events'], ['google calendar.create_event', 'google_calendar_create_event'],
  ['google calendar.update_event', 'google_calendar_update_event'],
]);
interface IntegrationMention { provider: string; action: string | undefined; email: string }

async function privateMessageText(context: AccountContext): Promise<string> {
  const rows = await withUser(context.db, context.userId, tx => tx.query<{ parts: unknown }>(`select v.parts
    from bob.messages m join bob.conversations c on c.id=m.conversation_id
    join bob.spaces s on s.id=c.space_id
    left join lateral (select case jsonb_typeof(parts) when 'string' then (parts #>> '{}')::jsonb else parts end as parts
      from bob.message_versions where message_id=m.id order by is_selected desc, version_index asc limit 1) v on true
    where m.id=$1 and c.id=$2 and m.user_id=$3 and c.user_id=$3 and m.role='user'
    and c.archived_at is null and s.kind='private' and s.archived_at is null`,
  [context.messageId, context.conversationId, context.userId]));
  const row = rows[0];
  if (!row) throw new Error('google_tool_scope_unavailable');
  const parts: unknown = typeof row.parts === 'string' ? JSON.parse(row.parts) : row.parts;
  if (!Array.isArray(parts)) return '';
  return parts.flatMap((part: unknown) => {
    const parsed = textPart.safeParse(part);
    return parsed.success ? [parsed.data.text] : [];
  }).join('\n');
}

function integrationMentions(text: string): IntegrationMention[] {
  // Code examples and escaped tokens are references, not account selections.
  const prose = text.replace(/(`+|~{3,})[\s\S]*?(?:\1|$)/g, ' ');
  return [...prose.matchAll(/(?<![\w\\])@\{integration:(Gmail|Google Calendar)(?:\.([^\s{}:]+))?:([^\s{}:]+@[^\s{}:]+)\}/gi)]
    .flatMap(match => match[1] && match[3] ? [{ provider: match[1].toLowerCase(), action: match[2]?.toLowerCase(), email: match[3].toLowerCase() }] : []);
}

function requiresDraftRead(toolName: string | undefined): boolean {
  return toolName === 'google_gmail_send_draft' || toolName === 'google_gmail_update_draft';
}
function mentionSelectsTool(mention: IntegrationMention, toolName: string | undefined): boolean {
  const selected = actionTools.get(`${mention.provider}.${mention.action}`);
  return selected === toolName || (toolName === 'google_gmail_read_draft' && requiresDraftRead(selected));
}

function namedTools(mentions: IntegrationMention[]): ReadonlySet<string> | undefined {
  const named = mentions.filter(mention => mention.action !== undefined);
  if (named.length === 0) return undefined;
  const tools = named.map(mention => actionTools.get(`${mention.provider}.${mention.action}`));
  // An unknown action must not quietly broaden or partially execute the request.
  if (tools.some(name => name === undefined)) return new Set();
  const selected = new Set(tools.filter((name): name is string => name !== undefined));
  if (tools.some(requiresDraftRead)) selected.add('google_gmail_read_draft');
  return selected;
}

export async function getGoogleMentionedTools(context: AccountContext): Promise<ReadonlySet<string> | undefined> {
  return namedTools(integrationMentions(await privateMessageText(context)));
}

function mentionedEmails(text: string, capability: GoogleCapability, toolName: string | undefined): string[] {
  const mentions = integrationMentions(text);
  const tools = namedTools(mentions);
  if (tools !== undefined && (toolName === undefined || !tools.has(toolName))) throw new Error('google_tool_selection_mismatch');
  const provider = capability.startsWith('gmail.') ? 'gmail' : 'google calendar';
  const matching = mentions.filter(mention => tools === undefined ? mention.provider === provider
    : mentionSelectsTool(mention, toolName));
  return [...new Set(matching.map(mention => mention.email))];
}

/** A mention is only a selector. Ownership, current grants, and private provider
 * exclusion still authorize every execution in google-tools. Never use model
 * message history or browser account metadata as evidence of selection. */
export async function resolveGoogleToolAccount(context: AccountContext, selector: string | undefined, capability: GoogleCapability, toolName: string): Promise<string> {
  const selected = await resolveGoogleToolAccountSelection(context, selector, capability, toolName);
  if (selected === undefined) throw new Error('google_tool_account_required');
  return selected;
}

/** Undefined means no explicit selector AND no matching mention. Only callers
 * with a documented default-account policy may fall back in that exact case. */
export async function resolveGoogleToolAccountSelection(context: AccountContext, selector: string | undefined, capability: GoogleCapability, toolName?: string): Promise<string | undefined> {
  const mentions = mentionedEmails(await privateMessageText(context), capability, toolName);
  if (selector === undefined && mentions.length === 0) return undefined;
  const owned = await listGoogleAccounts(context.db, context.userId);
  const normalized = selector?.toLowerCase();
  const explicit = normalized === undefined ? [] : owned.filter(account => account.id.toLowerCase() === normalized || account.email.toLowerCase() === normalized);
  if (explicit.length > 1) throw new Error('google_tool_account_required');
  if (normalized !== undefined && explicit.length !== 1) throw new Error('google_account_not_found');
  if (explicit[0]) {
    if (mentions.length && !mentions.includes(explicit[0].email.toLowerCase())) throw new Error('google_tool_account_mismatch');
    return explicit[0].id;
  }
  if (mentions.length !== 1) throw new Error('google_tool_account_required');
  const matches = owned.filter(account => account.email.toLowerCase() === mentions[0]);
  if (matches.length > 1) throw new Error('google_tool_account_required');
  if (matches.length !== 1 || !matches[0]) throw new Error('google_account_not_found');
  return matches[0].id;
}
