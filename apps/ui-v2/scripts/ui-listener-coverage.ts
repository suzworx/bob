import { parse } from '@babel/parser';
import * as t from '@babel/types';

type Policy = { file: string; event: string; reason: string; semantic?: string };
const policies: Policy[] = [
  { file: 'features/bob-apps/app-view-image-capture.ts', event: 'abort', reason: 'AbortSignal capture lifecycle cancels preparation and discards late canvases; no user action or content is exported.' },
  { file: 'features/spaces/use-threads.ts', event: 'bob:space-access', reason: 'Server audience invalidation removes the scoped thread cache and closes the active thread before reauthorization.' },
  { file: 'features/bob-apps/use-marketing-catalog.ts', event: 'bob:space-access', reason: 'Server audience invalidation clears scoped installation metadata before reauthorization.' },
  { file: 'features/bob-apps/use-bob-apps.ts', event: 'bob:space-access', reason: 'Server audience invalidation clears cached app data before reauthorization; IDs never exported.' },
  { file: 'features/chat/use-group-chat-refresh.ts', event: 'bob:group-chat-updated', reason: 'Server group state invalidation; no payload is exported.' },
  { file: 'features/chat/use-group-chat-refresh.ts', event: 'bob:group-chats-changed', reason: 'Local group state invalidation; resulting refresh requests are observed.' },
  { file: 'features/chat/use-platform-mentions.ts', event: 'bob:tool-preferences-changed', reason: 'Preference invalidation after an observed settings request; carries no user data.' },
  { file: 'features/admin/use-admin-access.ts', event: 'focus', reason: 'Passive permission refresh; resulting access request is observed.' },
  { file: 'features/admin/use-admin-access.ts', event: 'bob:admin-access-denied', reason: 'Permission invalidation from a refused API request; no user input or payload.' },
  { file: 'lib/use-refresh-on-focus.ts', event: 'visibilitychange', reason: 'Passive page lifecycle; resulting API refreshes are request observations.' },
  { file: 'lib/use-refresh-on-focus.ts', event: 'focus', reason: 'Passive focus refresh; resulting API requests are observed.' },
  { file: 'lib/use-online.ts', event: 'online', reason: 'Browser connectivity lifecycle, not a user action.' },
  { file: 'lib/use-online.ts', event: 'offline', reason: 'Browser connectivity lifecycle, not a user action.' },
  { file: 'app/use-theme.ts', event: 'change', reason: 'Operating-system media-query update; explicit theme selection has its own callback.' },
  { file: 'app/theme-choice.ts', event: 'change', reason: 'Operating-system media-query update; explicit theme selection has its own callback.' },
  { file: 'app/stale-build.ts', event: 'vite:preloadError', reason: 'Build resource lifecycle; no user gesture.' },
  { file: 'app/routes.ts', event: 'popstate', reason: 'Navigation has a fixed route/view observation in the central collector.' },
  { file: 'app/routes.ts', event: 'bob:routechange', reason: 'Navigation has a fixed route/view observation in the central collector.' },
  { file: 'features/voice/use-chat-voice.ts', event: 'dataavailable', reason: 'Media capture chunks; never inspect or export audio payloads.' },
  { file: 'features/voice/use-chat-voice.ts', event: 'error', reason: 'Media capture lifecycle; capture callback and request outcomes are observed.' },
  { file: 'features/voice/use-chat-voice.ts', event: 'stop', reason: 'Media capture lifecycle; capture callback and transcription request are observed.' },
  { file: 'features/voice/use-chat-voice.ts', event: 'playing', reason: 'Voice playback timing already records first audio; not a user action.' },
  { file: 'features/voice/mode/metrics.ts', event: 'pagehide', reason: 'Telemetry flush lifecycle; never observe its own transport.' },
  { file: 'features/voice/mode/metrics.ts', event: 'visibilitychange', reason: 'Telemetry flush lifecycle; never observe its own transport.' },
  { file: 'features/voice/mode/use-conversation-mode.ts', event: 'visibilitychange', reason: 'Voice session lifecycle has mode_state/mode_off telemetry.' },
  { file: 'features/voice/mode/use-conversation-mode.ts', event: 'pagehide', reason: 'Voice session lifecycle has mode_state/mode_off telemetry.' },
  { file: 'features/devices/devices-page.tsx', event: 'bob:active-changed', reason: 'Server state notification; resulting refresh requests are observed.' },
  { file: 'features/devices/use-device-conversation.ts', event: 'bob:active-changed', reason: 'Server state notification; resulting refresh requests are observed.' },
  { file: 'features/spaces/use-threads.ts', event: 'bob:thread-message', reason: 'Server message notification; no payload is exported.' },
  { file: 'features/chat/command-palette.tsx', event: 'input', semantic: 'searchInput.onChange', reason: 'Only matching palette input edits invoke the bounded text-edit summary callback.' },
  { file: 'features/chat/command-palette.tsx', event: 'keydown', semantic: 'commands.onToggle', reason: 'Only matching Cmd/Ctrl+K invokes the named toggle action; keys are never exported.' },
  { file: 'features/chat/command-palette.tsx', event: 'bob:open-palette', semantic: 'commands.onOpen', reason: 'The named open action handles the app search command.' },
];

function descendants(node: t.Node): t.Node[] {
  const fields = node as unknown as Record<string, unknown>;
  const children = (t.VISITOR_KEYS[node.type] ?? []).flatMap((key) => {
    const value = fields[key];
    return (Array.isArray(value) ? value : [value]).filter((item): item is t.Node => typeof item === 'object' && item !== null && 'type' in item);
  });
  return [node, ...children.flatMap(descendants)];
}

function memberName(node: t.Node | undefined | null): string {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) return `${memberName(node.object)}.${memberName(node.property)}`;
  return '';
}

function semanticPresent(policy: Policy, handler: t.Node | null | undefined): boolean {
  if (!policy.semantic) return true;
  return !!handler && descendants(handler).some((node) => t.isCallExpression(node) && memberName(node.callee) === policy.semantic);
}

/** Every native listener needs a file-specific decision. New or dynamic registrations fail closed. */
export function collectUiListeners(source: string, file: string): Array<Policy & { handler: string; category: 'action' | 'passive' }> {
  const nodes = descendants(parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] }));
  const bindings = new Map(nodes.filter(t.isVariableDeclarator).filter((node) => t.isIdentifier(node.id)).map((node) => [memberName(node.id), node.init]));
  return nodes.filter((node): node is t.CallExpression | t.OptionalCallExpression =>
    (t.isCallExpression(node) || t.isOptionalCallExpression(node)) && memberName(node.callee).endsWith('.addEventListener'))
    .map((node) => {
      const argument = node.arguments[0];
      const eventNode = t.isIdentifier(argument) ? bindings.get(argument.name) : argument;
      const event = t.isStringLiteral(eventNode) ? eventNode.value : 'unresolved';
      const policy = policies.find((entry) => entry.file === file && entry.event === event);
      if (!policy) throw new Error(`Unclassified native UI listener ${file}:${event}; add a fixed action or documented passive policy.`);
      const callback = node.arguments[1];
      const handler = t.isIdentifier(callback) ? bindings.get(callback.name) : callback;
      if (!semanticPresent(policy, handler)) throw new Error(`Native UI listener ${file}:${event} lost semantic action ${policy.semantic}.`);
      return { ...policy, handler: memberName(callback) || 'inline', category: policy.semantic ? 'action' : 'passive' };
    });
}
