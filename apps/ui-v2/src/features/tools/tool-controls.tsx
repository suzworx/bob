import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Heading } from '@astryxdesign/core/Heading';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { useSession } from '@/lib/auth/use-session';
import { getTools, setTool, type ToolCatalog, type ToolContext, type ToolEntry } from './tools-api';

const SCOPE_LABELS = { account: 'your account', integration: 'this integration', space: 'this space', conversation: 'this conversation' };
function inheritedBlock(tool: ToolEntry, scope: ToolCatalog['scope']): string | undefined {
  const blocked = tool.blockedBy.find((item) => item.scope !== scope.scope || item.scopeId !== scope.scopeId);
  return blocked ? `Turned off for ${SCOPE_LABELS[blocked.scope]}. Change that setting first.` : undefined;
}
function ToolRow({ tool, catalog, busy, save }: { tool: ToolEntry; catalog: ToolCatalog; busy: string | null; save(id: string, value: boolean | null): Promise<void> }): ReactElement {
  const blocked = inheritedBlock(tool, catalog.scope);
  const unavailable = tool.availability === 'unavailable';
  const reason = blocked ?? (unavailable ? 'Private integration tools are only available in private conversations.' : undefined);
  const readOnly = !catalog.canEdit ? 'Only the owner or a space admin can change these settings.' : undefined;
  return <VStack gap={1}>
    <Switch label={tool.name} description={reason ?? tool.description} value={tool.enabled}
      isDisabled={busy !== null || Boolean(reason) || !catalog.canEdit} disabledMessage={reason ?? readOnly}
      isLoading={busy === tool.id} labelPosition="start" labelSpacing="spread" onChange={(enabled) => void save(tool.id, enabled)} />
    {tool.preference !== null && <Button label={`Use inherited setting for ${tool.name}`} size="sm" variant="ghost"
      isDisabled={busy !== null || !catalog.canEdit} onClick={() => void save(tool.id, null)} />}
  </VStack>;
}
function ToolControlsContent({ context }: { context: ToolContext }): ReactElement {
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [retry, setRetry] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    setFailed(false);
    void getTools(context, controller.signal).then((value) => { if (!controller.signal.aborted) setCatalog(value); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [context, retry]);
  async function save(id: string, enabled: boolean | null): Promise<void> {
    const controller = lifetime.current;
    if (!catalog || busy || !controller || controller.signal.aborted) return;
    setBusy(id); setSaveFailed(false);
    try {
      await setTool(catalog.scope, id, enabled, controller.signal);
      const updated = await getTools(context, controller.signal);
      if (!controller.signal.aborted) setCatalog(updated);
    } catch { if (!controller.signal.aborted) setSaveFailed(true); }
    finally { if (!controller.signal.aborted) setBusy(null); }
  }
  if (failed) return <Banner status="error" title="Couldn't load these tool settings." description="Your settings haven't changed. Try again when you're ready."
    endContent={<Button label="Try again" onClick={() => setRetry((value) => value + 1)} />} />;
  if (!catalog) return <VStack gap={3} role="status" aria-label="Loading tools"><Skeleton height={48} /><Skeleton height={48} /></VStack>;
  const needle = query.trim().toLowerCase();
  const tools = catalog.tools.filter((tool) => `${tool.name} ${tool.group} ${tool.toolName}`.toLowerCase().includes(needle));
  const groups = [...new Set(tools.map((tool) => tool.group))];
  return <VStack gap={6}>
    <VStack gap={3}>
      <Text>Changes apply to {SCOPE_LABELS[catalog.scope.scope]}. Turning a tool on still requires access to its data.</Text>
      {!catalog.canEdit && <Text type="supporting">Only the owner or a space admin can change these settings.</Text>}
      <TextInput label="Find a tool" value={query} onChange={setQuery} hasClear />
      {saveFailed && <Banner status="error" title="Couldn't confirm that change." description="Your last confirmed settings are shown. Try again to save." />}
    </VStack>
    {groups.map((group) => <VStack key={group} gap={4}>
      <Heading level={2}>{group}</Heading>
      {tools.filter((tool) => tool.group === group).map((tool) => <ToolRow key={tool.id} tool={tool} catalog={catalog} busy={busy} save={save} />)}
    </VStack>)}
    {tools.length === 0 && <Text>No tools match that search.</Text>}
  </VStack>;
}
export function ToolControls({ context = {} }: { context?: ToolContext }): ReactElement {
  const { session } = useSession();
  const key = `${session?.user.id ?? 'signed-out'}:${context.integrationId ?? ''}:${context.spaceId ?? ''}:${context.conversationId ?? ''}`;
  // Key isolates owner and scope changes; the content keeps a stable context for its lifetime.
  const stable = useRef({ key, context });
  if (stable.current.key !== key) stable.current = { key, context };
  if (!session) return <Text>Sign in to choose your tools.</Text>;
  return <ToolControlsContent key={key} context={stable.current.context} />;
}
export function ToolControlsDialog({ context, title = 'Tools', onClose }: { context: ToolContext; title?: string; onClose(): void }): ReactElement {
  const close = (open: boolean): void => { if (!open) onClose(); };
  return <Dialog isOpen purpose="form" onOpenChange={close}>
    <Layout header={<DialogHeader title={title} onOpenChange={close} />} content={<LayoutContent><ToolControls context={context} /></LayoutContent>} />
  </Dialog>;
}
