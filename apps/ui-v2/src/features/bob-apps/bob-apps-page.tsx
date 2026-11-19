import type { Space } from '@/features/spaces/use-spaces';
import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { ListItem } from '@astryxdesign/core/List';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { VStack } from '@astryxdesign/core/VStack';
import { GroupedList } from '@/app/grouped-list';
import { PAGE_WIDTH, PageTitle, usePagePadding, PageSubtitle } from '@/app/page-width';
import { appPath, navigateTo, routeFromPath, useLocationPath, useLocationSearch } from '@/app/routes';
import { getDraft, setDraft, NEW_CHAT_DRAFT_KEY } from '@/features/chat/drafts';
import { AppRenderer, type AppViewSelection } from './app-renderer';
import { AppViewImage } from './app-view-image';
import { starterApp, fieldLabel } from './app-starters';
import { actOnApp, changeApp, createApp, type AppDefinition, type AppRecords, type BobApp } from './bob-apps-api';
import { useBobApps } from './use-bob-apps';
import type { RefreshState } from './app-refresh-api';
import { AppRefresh } from './app-refresh';
import { useSession } from '@/lib/auth/use-session';
import { useMarketingCatalog } from './use-marketing-catalog';
import { MarketingInstall } from './marketing-install';
import { MarketingWorkspace } from './marketing-workspace';
import { AppWorkspace } from './app-workspace';
import { AppActions } from './app-actions';
function askBob(): void {
  const prompt = 'Help me create a saved app. I would like ';
  if (!getDraft(NEW_CHAT_DRAFT_KEY)) setDraft(NEW_CHAT_DRAFT_KEY, prompt);
  navigateTo('/');
}
function previewMetrics(definition: AppDefinition, state: AppRecords): Record<string, number> {
  return Object.fromEntries(definition.metrics.map((metric) => {
    const rows = state[metric.table] ?? [];
    return [metric.id, metric.operation === 'count' ? rows.length : rows.reduce((sum, row) => sum + (typeof row.values[metric.field] === 'number' ? row.values[metric.field] as number : 0), 0)];
  }));
}
function DefinitionSummary({ definition, shared = false }: { definition: AppDefinition; shared?: boolean }): ReactElement {
  return <VStack gap={3}><Text>{`Purpose: ${definition.title}`}</Text>
    <Text>{`Views: ${definition.views.map((view) => `${view.title} (${view.kind})`).join(', ')}`}</Text>
    <Text>{`Saved data: ${definition.tables.map((table) => `${fieldLabel(table.id)} — ${table.fields.map((field) => `${fieldLabel(field.id)} (${field.type})`).join(', ')}`).join('; ')}`}</Text>
    <Text>{`Allowed actions: ${definition.actions.map((action) => `${action.operation} ${fieldLabel(action.table)}`).join(', ') || 'Read only'}`}</Text>
    <Text type="supporting">{shared ? 'Members of this space can open and edit this app.' : 'Only you can open this app. Automatic updates need separate permission.'}</Text>
  </VStack>;
}
function appPurpose(definition: AppDefinition): string {
  const names = definition.views.filter((view) => 'table' in view).map((view) => view.title.toLocaleLowerCase());
  return names.length ? `Keep your ${names.join(' and ')} together.` : 'See your saved information at a glance.';
}
function AppDetails({ app, state, userId, space }: { app: BobApp; state: ReturnType<typeof useBobApps>; userId: string; space?: Space }): ReactElement {
  const [refresh, setRefresh] = useState<RefreshState | null>(null);
  const [details, setDetails] = useState(false);
  const [selection, setSelection] = useState<AppViewSelection>({ viewId: app.definition.views[0]?.id ?? '' });
  const [sharing, setSharing] = useState(false);
  const focus = useRef<(() => void) | null>(null);
  const mutate = (operation: Parameters<typeof changeApp>[1]): void => { void state.perform(async () => { const result = await changeApp(app, operation); if (operation === 'duplicate') navigateTo(appPath(result.id, app.spaceId)); }); };
  return <AppWorkspace app={app} userId={userId} space={space} focusRef={focus} onChanged={() => void state.load()}><VStack gap={6}>
    <Text>{appPurpose(app.definition)}</Text>
    {app.lifecycle === 'draft' && <VStack gap={4}><Banner status="info" title="Your app is ready to try" description="Have a look, then make it yours when you’re happy." />
      <HStack>{app.canManage && <Button label="Use this app" variant="primary" isDisabled={state.busy} onClick={() => mutate('activate')} />}</HStack></VStack>}
    {details && <DefinitionSummary definition={app.definition} shared={Boolean(app.spaceId)} />}
    {app.pendingDefinition && <VStack gap={4}><Heading level={2}>Review proposed changes</Heading><DefinitionSummary definition={app.pendingDefinition} shared={Boolean(app.spaceId)} />
      <Text>Your saved records stay intact. Incompatible changes cannot be applied. You can undo this definition change.</Text>
      <AppRenderer definition={app.pendingDefinition} state={app.state} metrics={previewMetrics(app.pendingDefinition, app.state)} />
      <HStack>{app.canManage && <Button label="Apply changes" variant="primary" isDisabled={state.busy} onClick={() => mutate('apply_revision')} />}</HStack></VStack>}
    <AppRenderer definition={app.definition} state={app.state} metrics={app.metrics} busy={state.busy} revision={app.revision} selection={selection} onSelectionChange={setSelection} lockedTable={refresh?.enabled ? refresh.config?.targetTable : undefined}
      onAction={app.lifecycle === 'active' && (Boolean(app.spaceId) || refresh !== null) ? (command, revision) => state.perform(() => actOnApp({ ...app, revision: revision ?? app.revision }, command), { quiet: true }) : undefined} />
    <HStack gap={2} wrap="wrap"><Button label="Change with Bob" onClick={() => focus.current?.()} /><AppActions app={app} state={state} onDetails={() => setDetails((shown) => !shown)} onShareImage={() => setSharing(true)} /></HStack>
    {sharing && <AppViewImage app={app} userId={userId} selection={selection} onClose={() => setSharing(false)} />}
    {!app.spaceId && <AppRefresh app={app} onState={setRefresh} onChanged={() => void state.load()} />}
  </VStack></AppWorkspace>;
}
function MarketingContent({ id, userId, state, marketing, readRevision, space }: { space?: Space; id: string | null | undefined; userId: string | null; state: ReturnType<typeof useBobApps>; marketing: ReturnType<typeof useMarketingCatalog>; readRevision: number }): ReactElement {
  if (marketing.error && !marketing.data) return <Banner status="error" title="Couldn't open the app catalog" endContent={<Button label="Retry app catalog" onClick={marketing.reload} />} />;
  if (!marketing.data) return <Text role="status">Opening app workspace…</Text>;
  if (!id) return <></>;
  if (!state.app) return <></>;
  if (state.app.spaceId && !space) return <Banner status="info" title="This app belongs to a space" endContent={<Button label="Open in space" href={appPath(state.app.id, state.app.spaceId)} />} />;
  const installation = marketing.data.installations.find((item) => item.appId === id);
  const pack = marketing.data.package;
  const app = state.app;
  if (installation && userId) return <VStack height="100%" minHeight={0} gap={3}>{marketing.error && <Banner status="error" title="Couldn't refresh the app catalog. Your saved workspace and edits are still here." endContent={<Button label="Retry app catalog" onClick={marketing.reload} />} />}<StackItem size="fill"><AppActions key={`${userId}:${installation.id}`} app={app} state={state} marketing onChanged={marketing.reload} render={(appActions, confirmation) => <MarketingWorkspace space={space} userId={userId} installation={installation} pack={pack} readRevision={readRevision} archived={app.lifecycle === 'archived'} onInstallationChanged={() => { marketing.reload(); void state.load(); }} appActions={appActions} lifecycleActions={<>{confirmation}</>} />} /></StackItem></VStack>;
  if (!userId) return <></>;
  return <AppDetails key={`${userId}:${state.app.id}`} app={state.app} userId={userId} state={state} space={space} />;
}
const TAGLINE = 'Small apps that keep up with you.';
const STARTERS = [
  { kind: 'checklist', label: 'Checklist starter', description: 'Tick things off as you go.' },
  { kind: 'budget', label: 'Budget starter', description: 'Note what you spend and see the running total.' },
  { kind: 'tasks', label: 'Tasks dashboard starter', description: 'Keep tasks in one place and see the count.' },
] as const;
function appDescription({ lifecycle, updatedAt }: { lifecycle: BobApp['lifecycle']; updatedAt: number }): ReactElement {
  return <>{lifecycle === 'draft' ? 'Ready to try · ' : ''}Updated <Timestamp value={new Date(updatedAt).toISOString()} format="relative" /></>;
}
function NoAppsShown({ archived }: { archived: boolean }): ReactElement {
  const create = <Button label="Create with Bob" variant="primary" onClick={() => askBob()} />;
  if (archived) return <EmptyState isCompact headingLevel={2} title="Nothing archived" description="Apps you archive wait here until you want them back." />;
  return <EmptyState isCompact headingLevel={2} title="Nothing current" description="All your apps are archived. Restore one, or start something new." actions={create} />;
}
function YourApps({ state, space }: { space?: Space; state: ReturnType<typeof useBobApps> }): ReactElement | null {
  const [shown, setShown] = useState('current');
  const archived = shown === 'archived';
  if (state.apps === null || state.apps.length === 0) return null;
  const rows = state.apps.filter((app) => (app.lifecycle === 'archived') === archived);
  return <VStack gap={3}>
    <HStack><SegmentedControl label="Which apps to show" size="sm" value={shown} onChange={setShown}><SegmentedControlItem value="current" label="Current" /><SegmentedControlItem value="archived" label="Archived" /></SegmentedControl></HStack>
    {rows.length > 0 ? <GroupedList label={archived ? 'Archived apps' : 'Your apps'}>{rows.map((app) => <ListItem key={app.id} label={app.title} description={<>{appDescription(app)}</>} onClick={() => navigateTo(appPath(app.id, space?.id))} />)}</GroupedList>
      : <NoAppsShown archived={archived} />}
    {state.nextCursor && <Button label="Load more apps" onClick={() => void state.more()} />}
  </VStack>;
}
function AppCatalog({ state, marketing, onStart, space }: { space?: Space; state: ReturnType<typeof useBobApps>; marketing: ReturnType<typeof useMarketingCatalog>; onStart: (kind: Parameters<typeof starterApp>[0]) => void }): ReactElement {
  const [installFailed, setInstallFailed] = useState(false);
  return <VStack gap={2} paddingBlockStart={state.apps?.length === 0 ? 4 : 0}>
    {installFailed && <Banner status="error" title="Couldn’t install Marketing. Try again in a moment." />}
    <GroupedList label={state.apps?.length === 0 ? 'No apps yet' : 'Add an app'} action={!space && state.apps?.length === 0 ? <Button label="Create with Bob" size="sm" onClick={() => askBob()} /> : undefined}>
      {marketing.data && <MarketingInstall spaceId={space?.id} canManage={!space || space.role === 'owner' || space.role === 'admin'} pack={marketing.data.package} installations={marketing.data.installations} onFailure={setInstallFailed} onChanged={() => { marketing.reload(); void state.load(); }} />}
      {STARTERS.map((starter) => <ListItem key={starter.kind} label={starter.label} description={starter.description} isDisabled={state.busy} onClick={() => onStart(starter.kind)} />)}
    </GroupedList><Text type="supporting">A starter opens as a draft, so you can look it over before it goes live.</Text></VStack>;
}
function spaceAppsHeader(id: string | null, app: BobApp | null, spaceId: string): ReactElement {
  return <LayoutHeader><HStack gap={2} vAlign="center">
    {id && <Button label="All apps" variant="ghost" onClick={() => navigateTo(appPath(null, spaceId))} />}
    <StackItem size="fill"><Heading level={2}>{app?.definition.title ?? 'Apps'}</Heading></StackItem>
  </HStack></LayoutHeader>;
}
function appSubtitle(app: BobApp | null): ReactNode {
  if (!app) return TAGLINE;
  const status = app.lifecycle === 'active' ? '' : `${app.lifecycle === 'draft' ? 'Ready to try' : fieldLabel(app.lifecycle)} · `;
  return <>{status}Updated <Timestamp value={new Date(app.updatedAt).toISOString()} format="relative" /></>;
}
function AppsHeader({ id, state, space }: { space?: Space; id: string | null; state: ReturnType<typeof useBobApps> }): ReactElement {
  const { isMobile } = useAppShellMobile();
  if (space) return spaceAppsHeader(id, state.app, space.id);
  const hasApps = !id && Boolean(state.apps?.length);
  const allApps = <HStack><Button label="All apps" variant="ghost" onClick={() => navigateTo(appPath(null))} /></HStack>;
  const subtitle = appSubtitle(state.app);
  return <LayoutHeader><VStack gap={3}>
    {isMobile
      ? <HStack gap={2} vAlign="center"><StackItem size="fill">{id ? allApps : <PageSubtitle>{TAGLINE}</PageSubtitle>}</StackItem>
        {hasApps && <MoreMenu presentation="adaptive" items={[{ label: 'Create with Bob', onClick: () => askBob() }]} />}</HStack>
      : id && allApps}
    <PageTitle isShownOnPhone={Boolean(id)}>{state.app?.definition.title ?? 'My Apps'}</PageTitle>
    {(id || !isMobile) && <PageSubtitle>{subtitle}</PageSubtitle>}
    {!isMobile && hasApps && <HStack><Button label="Create with Bob" variant="primary" onClick={() => askBob()} /></HStack>}
  </VStack></LayoutHeader>;
}
function AppPageContent({ fill, children }: { fill: boolean; children: ReactNode }): ReactElement {
  return <LayoutContent label="My Apps" isScrollable={!fill}><VStack height={fill ? '100%' : undefined} minHeight={0} gap={6}>{children}</VStack></LayoutContent>;
}
export function BobAppsPage({ space }: { space?: Space } = {}): ReactElement {
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const marketing = useMarketingCatalog(userId, space?.id);
  const route = routeFromPath(useLocationPath());
  const search = useLocationSearch();
  const id = space ? new URLSearchParams(search).get('app') : route.kind === 'apps' ? route.appId : null;
  const state = useBobApps(id, space?.id);
  const [readRevision, setReadRevision] = useState(0);
  const reload = (): void => { marketing.reload(); setReadRevision((value) => value + 1); void state.load(); };
  const padding = usePagePadding();
  const start = (kind: Parameters<typeof starterApp>[0]): void => { void state.perform(async () => { const app = await createApp(starterApp(kind), space?.id); navigateTo(appPath(app.id, space?.id)); }); };
  const installedMarketing = Boolean(id && marketing.data?.installations.some((item) => item.appId === id));
  return <Layout height="fill" padding={padding} contentWidth={PAGE_WIDTH}
    header={<AppsHeader space={space} id={id} state={state} />}
    content={<AppPageContent fill={installedMarketing || Boolean(id)}>
      {state.error && <Banner status="error" title={state.error} endContent={<Button label="Reload latest data" isDisabled={state.busy} onClick={reload} />} />}
      {state.apps === null && !state.error && <Text role="status">Opening your apps…</Text>}
      {!id && <YourApps space={space} state={state} />}
      <MarketingContent space={space} id={id} userId={userId} state={state} marketing={marketing} readRevision={readRevision} />
      {!id && <AppCatalog space={space} state={state} marketing={marketing} onStart={start} />}
    </AppPageContent>} />;
}
