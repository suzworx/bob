import { ThreadReader } from '@/features/spaces/thread-reader';
import type { Space } from '@/features/spaces/use-spaces';
import { useAppConversation } from './use-app-conversation';
import { useEffect, useRef, useState, type ComponentProps, type Dispatch, type ReactElement, type RefObject, type SetStateAction } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Button } from '@astryxdesign/core/Button';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutFooter, LayoutHeader } from '@astryxdesign/core/Layout';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { ToggleButton, ToggleButtonGroup } from '@astryxdesign/core/ToggleButton';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { usePagePadding } from '@/app/page-width';
import { useRefreshOnFocus } from '@/lib/use-refresh-on-focus';
import { ChatSurface, type ChatAppBinding } from '@/features/chat/chat-surface';
import { useMarketingConversation } from './use-marketing-conversation';
import { MarketingDraft, weekLabel } from './marketing-draft';
import { useMarketingDraftEdits, type MarketingDraftEdits } from './marketing-draft-edits';
import { MarketingConfig } from './marketing-config';
import { MarketingReviewPanel, type ReviewController } from './marketing-review';
import { useMarketingReview } from './use-marketing-review';
import * as api from './marketing-api';
import type { AppMenuItems } from './app-actions';

type Channel = 'all' | 'instagram' | 'linkedin';
type Fill = RefObject<((text: string) => void) | null>;
const networkLabel = (channel: Channel): string => channel === 'all' ? 'All' : channel === 'instagram' ? 'Instagram' : 'LinkedIn';
const TRANSCRIPT_HEIGHT = '30dvh';
// A starter fills the composer. The owner edits and sends it.
const STARTERS = [
  { label: 'A week of posts', prompt: 'Write a week of posts about ' },
  { label: 'Polish my rough copy', prompt: 'Turn this rough copy into a post: ' },
  { label: 'Plan a launch', prompt: 'Plan a launch campaign for ' },
];

async function readWorkspace(installationId: string, conversationId: string | null, selectedId: string | null | undefined, improving: boolean, signal: AbortSignal) {
  const [campaigns, config, stored] = await Promise.all([api.campaigns(installationId, signal), api.configDetail(installationId, signal),
    conversationId ? api.selectedCampaign(installationId, conversationId, signal) : Promise.resolve(null)]);
  signal.throwIfAborted();
  // An explicit choice archived since it was made is no longer a target.
  const choiceGone = selectedId && !campaigns.some((item) => item.id === selectedId && item.status !== 'archived');
  const target = choiceGone ? null : selectedId === undefined ? stored?.id ?? null : selectedId;
  const content = !improving;
  // The target is already known here, so a failure below costs its content, not the picker or the chat.
  let failed = false;
  const [campaign, drafts] = target
    ? await Promise.all([api.campaign(installationId, target, signal), content ? api.drafts(installationId, target, signal) : Promise.resolve(null)]).catch(() => {
      signal.throwIfAborted();
      failed = true;
      return [null, null] as const;
    })
    : [null, content ? [] : null];
  return { campaigns, config, storedId: stored?.id ?? null, target, campaign, drafts, failed };
}

function groupLabel(draft: api.Draft, grouping: api.Installation['config']['contentGrouping']): string {
  if (grouping === 'channel') return networkLabel(draft.channel);
  const week = weekLabel(draft.pillar);
  if (grouping === 'pillar') return week.pillar ?? 'No pillar yet';
  return week.day ? `Day ${week.day}` : new Date(draft.createdAt).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
const dayOrder = (draft: api.Draft): number => weekLabel(draft.pillar).day ?? 0;

function Story({ campaign, review, onNote }: { campaign: api.Campaign; review?: ReviewController; onNote: () => void }): ReactElement {
  const { isMobile } = useAppShellMobile();
  const [story, ...rest] = campaign.sections.filter((section) => section.content);
  const details = isMobile ? campaign.sections.filter((section) => section.content) : rest;
  return <VStack gap={2}>
    {!isMobile && story && <Text>{story.content}</Text>}
    {(details.length > 0 || review) && <Collapsible trigger="See the full plan" defaultIsOpen={false} isOpen={review?.open} onOpenChange={review?.setOpen}><VStack gap={3}>{details.map((section) => <VStack key={section.section} gap={1}><Heading level={3}>{section.section.charAt(0).toUpperCase() + section.section.slice(1)}</Heading>{section.content.split(String.fromCharCode(10)).map((line, index) => <Text key={`${index}:${line}`}>{line}</Text>)}</VStack>)}{review && <MarketingReviewPanel review={review} onNote={onNote} />}</VStack></Collapsible>}
  </VStack>;
}

function WeekHeading({ channel, onChannel, reviewing }: { channel: Channel; onChannel: (channel: Channel) => void; reviewing?: boolean }): ReactElement {
  const { isMobile } = useAppShellMobile();
  const notice = <Text type="supporting">Drafts only. Nothing posts until you copy it.</Text>;
  if (reviewing) return <VStack gap={1}><Heading level={2}>This week</Heading><Text type="supporting">All saved posts · all channels · review snapshot</Text></VStack>;
  if (isMobile) return <VStack gap={1}><HStack gap={3} vAlign="center" hAlign="between"><Heading level={2}>This week</Heading>
    <Selector label="Show posts for" isLabelHidden size="sm" variant="ghost" value={channel} onChange={(value) => onChannel(value as Channel)} options={(['all', 'instagram', 'linkedin'] as const).map((value) => ({ value, label: networkLabel(value) }))} />
  </HStack>{notice}</VStack>;
  return <HStack gap={3} wrap="wrap" vAlign="center" hAlign="between"><VStack gap={1}><Heading level={2}>This week</Heading>{notice}</VStack>
    <ToggleButtonGroup label="Show posts for" size="sm" value={channel} onChange={(value) => { if (typeof value === 'string') onChannel(value as Channel); }}>
      {(['all', 'instagram', 'linkedin'] as const).map((item) => <ToggleButton key={item} value={item} label={networkLabel(item)} />)}
    </ToggleButtonGroup></HStack>;
}

function WeekBoard({ installation, rows, pack, channel, edits, onChannel, onAsk, reviewing }: { installation: api.Installation; rows: api.Draft[]; pack: api.MarketingPackage; channel: Channel; edits: MarketingDraftEdits; onChannel: (channel: Channel) => void; onAsk: (draft: api.Draft) => void; reviewing?: boolean }): ReactElement {
  const { isMobile } = useAppShellMobile();
  const scoped = rows.filter((draft) => channel === 'all' || draft.channel === channel).sort((a, b) => dayOrder(a) - dayOrder(b) || a.createdAt - b.createdAt);
  const groups = new Map<string, api.Draft[]>();
  for (const draft of scoped) {
    const label = groupLabel(draft, installation.config.contentGrouping);
    groups.set(label, [...(groups.get(label) ?? []), draft]);
  }
  return <VStack gap={isMobile ? 2 : 4}>
    <WeekHeading channel={channel} onChannel={onChannel} reviewing={reviewing} />
    {scoped.length === 0 && <Text>{channel === 'all' ? 'No posts yet. Ask Bob for a few.' : `No ${networkLabel(channel)} posts yet. Ask Bob for one.`}</Text>}
    {Array.from(groups, ([label, items]) => <VStack gap={isMobile ? 1 : 3} key={label}><Heading level={3}>{label}</Heading>{items.map((draft) => <MarketingDraft key={draft.id} draft={draft} assets={pack.assets} writable={installation.state === 'active'} edits={edits} onAsk={onAsk} reviewing={reviewing} />)}</VStack>)}
  </VStack>;
}

function FirstPost({ fill }: { fill: Fill }): ReactElement {
  return <VStack gap={4} hAlign="center"><img src="/brand/bob/bob-playful.webp" width={144} height={144} alt="Bob waving hello" />
    <VStack gap={1} hAlign="center"><Heading level={2}>What should we post?</Heading><Text type="supporting">Bob already knows the product. Start with an idea, rough copy or a goal.</Text></VStack>
    <HStack gap={2} wrap="wrap" hAlign="center">{STARTERS.map((starter) => <Token key={starter.label} label={starter.label} onClick={() => fill.current?.(starter.prompt)} />)}</HStack>
  </VStack>;
}

function useWorkspaceData(installationId: string, conversationId: string | null, selectedId: string | null | undefined, refresh: string, improving: boolean, manualReadRevision: number) {
  type Data = Awaited<ReturnType<typeof readWorkspace>>;
  type Read = { key: string; selectedId: string | null | undefined; conversationId: string | null; known: Data | null; error: boolean; loading: boolean };
  const key = JSON.stringify([installationId, conversationId, selectedId === undefined ? 'selection' : selectedId, refresh, improving]);
  // A first conversation keeps its target; any other change of target or conversation drops what was shown for the old one.
  const sameTarget = (read: Read): boolean => read.selectedId === selectedId && (read.conversationId === conversationId || read.conversationId === null);
  const [state, setState] = useState<Read>({ key, selectedId, conversationId, known: null, error: false, loading: true });
  // Background reads keep the visible target. An explicit page refresh may resolve its stored pointer again.
  const resolvedTarget = useRef<{ revision: number; target: string | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setState((read) => ({ ...read, key, error: false, loading: true }));
    const cached = resolvedTarget.current;
    const target = selectedId === undefined ? cached?.revision === manualReadRevision ? cached.target : undefined : selectedId;
    void readWorkspace(installationId, conversationId, target, improving, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      if (resolvedTarget.current?.revision !== manualReadRevision) resolvedTarget.current = { revision: manualReadRevision, target: data.target };
      setState((read) => {
        // Shown content survives a refresh only for the campaign this read resolved, which a following selection can change.
        const kept = sameTarget(read) && read.known?.target === data.target ? read.known : null;
        return { key, selectedId, conversationId, known: { ...data, campaign: data.campaign ?? kept?.campaign ?? null, drafts: data.drafts ?? kept?.drafts ?? null }, error: data.failed, loading: false };
      });
    }).catch(() => { if (!controller.signal.aborted) setState((read) => ({ ...read, key, error: true, loading: false })); });
    return () => controller.abort();
  }, [installationId, conversationId, selectedId, refresh, improving, manualReadRevision, key]);
  const settled = state.key === key;
  return { known: state.known, data: sameTarget(state) ? state.known : null, error: settled && state.error, loading: !settled || state.loading };
}

function LifecycleNotice({ installation, archived, busy, onLifecycle }: { installation: api.Installation; archived: boolean; busy: boolean; onLifecycle: () => void }): ReactElement | null {
  if (archived) return <Text>Restore this app below before resuming Marketing.</Text>;
  if (installation.state === 'active') return null;
  if (!installation.canManage) return <Text>Marketing is paused. An owner or admin can resume it.</Text>;
  const paused = installation.state === 'paused';
  return <Banner status="info" title={paused ? 'Marketing is paused. Your saved work is still here.' : 'Activate to create and save campaigns.'} endContent={<Button label={paused ? 'Resume app' : 'Activate app'} isDisabled={busy} onClick={onLifecycle} />} />;
}

function BrandAndSkills({ pack }: { pack: api.MarketingPackage }): ReactElement {
  return <VStack gap={3}><Heading level={2}>Brand & skills</Heading><Text>{pack.mission}</Text><Text>{pack.voice}</Text>{pack.roles.map((role) => <Text key={role.id}>{`${role.label}: ${role.summary}`}</Text>)}{pack.capabilities.filter((item) => item.status === 'unavailable').map((item) => <Text key={item.id}>{item.reason}</Text>)}</VStack>;
}

function MarketingChat({ conversation, binding, improving, fill, onChanged, onBusyChange }: { conversation: ReturnType<typeof useMarketingConversation>; binding: ComponentProps<typeof ChatSurface>['appBinding']; improving: boolean; fill: ComponentProps<typeof ChatSurface>['composerFillRef']; onChanged: ComponentProps<typeof ChatSurface>['onConversationTouched']; onBusyChange: (busy: boolean) => void }): ReactElement {
  if (conversation.loading) return <Text role="status">Opening your conversation…</Text>;
  if (conversation.error) return <Banner status="error" title="Couldn't open your conversation" endContent={<Button label="Retry conversation" onClick={conversation.retry} />} />;
  return <VStack gap={3}>{conversation.missing && <Banner status="info" title="That conversation is no longer here. You can start a fresh one." />}
    <ChatSurface embedded embeddedHeight={TRANSCRIPT_HEIGHT} composerFillRef={fill} conversationId={conversation.id} conversationTitle={conversation.title} initialMessages={conversation.recent} earlierMessages={conversation.earlier} userName={null}
      draftKey={conversation.draftKey} placeholder={improving ? 'Tell Bob how to change this app…' : 'Ask Bob for a post, or to change one…'} appBinding={binding}
      onConversationCreated={conversation.created} onConversationTouched={onChanged} onBusyChange={onBusyChange} />
  </VStack>;
}

/** A run turn always names the target on screen: a campaign, or null for New. The chat is hidden while the target is unknown. Bob infers the intent. */
function turnBinding(installationId: string, improving: boolean, channel: Channel, target: string | null | undefined): ChatAppBinding {
  return { installationId, mode: improving ? 'refine' : 'run', ...(channel === 'all' ? {} : { channel }), ...(improving || target === undefined ? {} : { campaignId: target }) };
}

type WorkspaceRead = ReturnType<typeof useWorkspaceData>;
/** Whether the board can say something true yet. Without this a loading view reads as an empty one. */
function boardReady(improving: boolean, { known, data }: WorkspaceRead): boolean {
  if (improving) return known !== null;
  return data !== null && (data.target === null || (data.campaign !== null && data.drafts !== null));
}

function lifecycleOperation(state: api.Installation['state']): 'pause' | 'resume' | 'activate' {
  if (state === 'active') return 'pause';
  return state === 'paused' ? 'resume' : 'activate';
}
/** The picker names the target or, while it is unknown, says so. It never falls back to New. */
function campaignPicker(target: string | null | undefined, { known, error }: WorkspaceRead) {
  const campaigns = known?.campaigns ?? [];
  return {
    ...(target === undefined ? {} : { value: target ?? 'new' }),
    placeholder: error ? 'Campaign unavailable' : 'Opening campaign…',
    options: [{ value: 'new', label: 'New campaign' }, ...campaigns.filter((item) => item.status !== 'archived').map((item) => ({ value: item.id, label: item.name }))],
  };
}

/** Stores a choice for this conversation where the server keeps one: a live or paused app that has a conversation. */
async function storeChoice(installation: api.Installation, archived: boolean, conversationId: string | null, campaignId: string | null): Promise<void> {
  if (archived || !conversationId || (installation.state !== 'active' && installation.state !== 'paused')) return;
  await api.selectCampaign(installation.id, conversationId, campaignId, crypto.randomUUID());
}

/**
 * A run turn stores its target first, so after one that succeeded a different stored campaign is that turn's own create_campaign or select_campaign.
 * A failed, stopped or Refine turn proves nothing about the selection, and an explicit choice stands.
 */
function useTurnSelection(state: WorkspaceRead, improving: boolean, setTurnBusy: (busy: boolean) => void, changed: () => void, setSelectedId: Dispatch<SetStateAction<string | null | undefined>>) {
  const turn = useRef<{ improving: boolean; succeeded: boolean } | null>(null);
  const setBusy = (next: boolean): void => { setTurnBusy(next); if (next) turn.current = { improving, succeeded: false }; };
  const chatChanged = (finished?: { succeeded: boolean }): void => { if (turn.current && finished?.succeeded) turn.current.succeeded = true; changed(); };
  useEffect(() => {
    if (!turn.current?.succeeded || state.loading) return;
    const { improving: refineTurn } = turn.current;
    turn.current = null;
    const moved = state.known?.storedId;
    if (!refineTurn && moved) setSelectedId(moved);
  }, [state.loading, state.known, setSelectedId]);
  return { setBusy, chatChanged };
}

type WorkspaceProps = { space?: Space; userId: string; installation: api.Installation; pack: api.MarketingPackage; archived?: boolean; readRevision?: number; appActions?: AppMenuItems; lifecycleActions?: ReactElement; onInstallationChanged: () => void };

export function MarketingWorkspace(props: WorkspaceProps): ReactElement {
  const key = `${props.userId}:${props.installation.id}`;
  if (props.installation.spaceId) {
    if (!props.space || props.space.id !== props.installation.spaceId) return <Text role="status">This app is no longer available to you.</Text>;
    return <SharedWorkspaceSession key={key} {...props} space={props.space} />;
  }
  return <PersonalWorkspaceSession key={key} {...props} />;
}

type ChatConfig = Omit<ComponentProps<typeof MarketingChat>, 'conversation'>;
function PersonalWorkspaceSession(props: WorkspaceProps): ReactElement {
  const conversation = useMarketingConversation(props.userId, props.installation.id);
  return <WorkspaceSession {...props} conversationId={conversation.id} renderChat={(config) => <MarketingChat {...config} conversation={conversation} />} />;
}
function SharedWorkspaceSession(props: WorkspaceProps & { space: Space }): ReactElement {
  const conversation = useAppConversation(props.installation.appId, props.space.id);
  if (conversation.error) return <Banner status="error" title="This app conversation is no longer available. Reload the space to check your access." />;
  if (!conversation.thread || !conversation.id) return <Text role="status">Opening the shared app conversation…</Text>;
  const thread = conversation.thread;
  return <WorkspaceSession {...props} conversationId={conversation.id} renderChat={({ binding, fill, improving, onChanged, onBusyChange }) =>
    <ThreadReader space={props.space} thread={thread} threads={conversation.threads} appBinding={binding} fillRef={fill} placeholder={improving ? 'Tell Bob how to change this app…' : 'Ask Bob for a post, or to change one…'} embeddedHeight={TRANSCRIPT_HEIGHT} onInvocationComplete={onChanged} onBusyChange={onBusyChange} />} />;
}

function ReadNotice({ failed, loading, known, onRetry }: { failed: boolean; loading: boolean; known: boolean; onRetry: () => void }): ReactElement {
  return <>{failed && <Banner status="error" title="Couldn't open the latest saved workspace. Your edits are still here." {...(known ? {} : { description: 'Chat will come back once Bob can show which campaign it saves to.' })} endContent={<Button label="Retry workspace" onClick={onRetry} />} />}
    {loading && <Text role="status">Opening saved workspace…</Text>}</>;
}

function CampaignBoard({ campaign, review, onNote, ...board }: { campaign: api.Campaign | null; review?: ReviewController; onNote: () => void } & ComponentProps<typeof WeekBoard>): ReactElement {
  const { isMobile } = useAppShellMobile();
  const snapshot = review?.open ? review.data?.snapshot : undefined;
  const displayed = snapshot?.campaign ?? campaign;
  const loadingReview = review?.open && !snapshot;
  return <VStack gap={isMobile ? 2 : 4}>{displayed && <Story campaign={displayed} review={review} onNote={onNote} />}
    {!loadingReview && <WeekBoard {...board} rows={snapshot?.drafts ?? board.rows} channel={review?.open ? 'all' : board.channel} reviewing={review?.open} />}</VStack>;
}

function BoardSlot({ ready, improving, target, first, config, board }: { ready: boolean; improving: boolean; target: string | null | undefined; first: ReactElement; config: ReactElement | null; board: ReactElement }): ReactElement | null {
  if (!ready) return null;
  if (improving) return config;
  return target ? board : first;
}
function sharedReview(installation: api.Installation, review: ReviewController): ReviewController | undefined {
  return installation.spaceId ? review : undefined;
}

function WorkspaceBar({ picker, locked, known, improving, canPause, onChoose, onImproving, onPause, onBrand, appActions = [] }: { picker: ReturnType<typeof campaignPicker>; locked: boolean; known: boolean; improving: boolean; canPause: boolean; onChoose: (id: string) => void; onImproving: (improving: boolean) => void; onPause: () => void; onBrand: () => void; appActions?: AppMenuItems }): ReactElement {
  const menu: AppMenuItems = [
    { label: 'Improve this app', onClick: () => onImproving(true) },
    ...(canPause ? [{ label: 'Pause app', isDisabled: locked, onClick: onPause }] : []),
    { label: 'Brand & skills', onClick: onBrand },
    { label: 'App history', onClick: () => onImproving(true) },
    ...appActions,
  ];
  return <HStack gap={2} wrap="wrap" vAlign="center" hAlign="between">
    {picker.options.length > 1 || !known ? <Selector label="Campaign" isLabelHidden variant="ghost" size="sm" {...picker} isDisabled={locked || !known} onChange={onChoose} /> : <Text type="supporting">Your first campaign</Text>}
    <HStack gap={2} vAlign="center">{improving && <Button label="Back to posts" variant="ghost" onClick={() => onImproving(false)} />}<MoreMenu label="More app actions" presentation="adaptive" alignment="end" items={menu} /></HStack>
  </HStack>;
}

function WorkspaceSession({ userId, installation, pack, archived = false, readRevision = 0, appActions, lifecycleActions, onInstallationChanged, conversationId, renderChat }: WorkspaceProps & { conversationId: string | null; renderChat: (config: ChatConfig) => ReactElement }): ReactElement {
  const [channel, setChannel] = useState<Channel>('all');
  const [improving, setImproving] = useState(false);
  const [brand, setBrand] = useState(false);
  const [busy, setTurnBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null | undefined>(undefined);
  const focus = useRefreshOnFocus();
  const readKey = `${readRevision}:${refresh}:${focus}`;
  const fill = useRef<((text: string) => void) | null>(null);
  // A nested Layout escapes its parent's gutter and re-applies only its own, so it needs the page's.
  const padding = usePagePadding();
  const state = useWorkspaceData(installation.id, conversationId, selectedId, readKey, improving, readRevision);
  const changed = (): void => { setRefresh((value) => value + 1); };
  const { setBusy, chatChanged } = useTurnSelection(state, improving, setTurnBusy, changed, setSelectedId);
  const edits = useMarketingDraftEdits(userId, installation.id, changed);
  // The one campaign this screen claims and every turn targets. Undefined only while nothing has been read and nothing chosen.
  const target = state.data ? state.data.target : selectedId;
  const review = useMarketingReview(userId, installation.id, target, installation.spaceId !== null, readKey, changed);
  const known = target !== undefined;
  const ready = boardReady(improving, state);
  const picker = campaignPicker(target, state);
  const changeLifecycle = async (): Promise<void> => {
    setActionBusy(true); setError(null);
    try {
      await api.marketingLifecycle(installation, lifecycleOperation(installation.state), crypto.randomUUID());
      setRefresh((value) => value + 1); onInstallationChanged();
    }
    catch { setError("Couldn't change the app state. Reload the latest app and try again."); }
    finally { setActionBusy(false); }
  };
  const chooseCampaign = async (id: string): Promise<void> => {
    if (busy || actionBusy) return;
    setActionBusy(true); setError(null);
    try {
      const campaignId = id === 'new' ? null : id;
      await storeChoice(installation, archived, conversationId, campaignId);
      setSelectedId(campaignId); setRefresh((value) => value + 1);
    } catch { setError("Couldn't select that campaign. Your conversation is still here."); }
    finally { setActionBusy(false); }
  };
  const askAbout = (draft: api.Draft): void => { fill.current?.(`Change ${networkLabel(draft.channel)} post ${draft.id}, "${draft.body.slice(0, 60)}": `); };
  // The filter belongs to the board, so a turn never carries a filter the owner cannot see.
  const boardChannel: Channel = !improving && target && !review.open ? channel : 'all';
  return <Layout height="fill" padding={padding}
    header={<LayoutHeader><VStack gap={3}>
    <WorkspaceBar picker={picker} locked={busy || actionBusy} known={known} improving={improving} canPause={installation.canManage && installation.state === 'active' && !archived} onChoose={(id) => void chooseCampaign(id)} onImproving={setImproving} onPause={() => void changeLifecycle()} onBrand={() => setBrand(!brand)} appActions={appActions} />
    <LifecycleNotice installation={installation} archived={archived} busy={actionBusy || busy} onLifecycle={() => void changeLifecycle()} />
    {error && <Banner status="error" title={error} />}
    <ReadNotice failed={state.error} loading={state.loading && (!known || !ready)} known={known} onRetry={changed} />
    </VStack></LayoutHeader>}
      content={<LayoutContent key={String(improving)} label="Marketing posts"><VStack gap={4}>
        {brand && <BrandAndSkills pack={pack} />}
        <BoardSlot ready={ready} improving={improving} target={target} first={<FirstPost fill={fill} />} config={state.known && <MarketingConfig detail={state.known.config} writable={installation.state === 'active'} canManage={installation.canManage} onChanged={changed} />} board={<CampaignBoard campaign={state.data?.campaign ?? null} review={sharedReview(installation, review)} onNote={() => fill.current?.('Add a review note on this plan: ')} installation={{ ...installation, config: state.known?.config.installation.config ?? installation.config }} rows={state.data?.drafts ?? []} pack={pack} channel={channel} edits={edits} onChannel={setChannel} onAsk={askAbout} />} />
        {lifecycleActions}
      </VStack></LayoutContent>}
      footer={known ? <LayoutFooter>{renderChat({ binding: turnBinding(installation.id, improving, boardChannel, target), improving, fill, onChanged: chatChanged, onBusyChange: setBusy })}</LayoutFooter> : undefined} />;
}
