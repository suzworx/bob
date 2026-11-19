import { useEffect, useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { SavedSummary } from '@/features/routines/saved-summary';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { PAGE_WIDTH, PageTitle, usePagePadding, PageSubtitle } from '@/app/page-width';
import { navigateTo, routeFromPath, useLocationHash, useLocationPath } from '@/app/routes';
import { useSession } from '@/lib/auth/use-session';
import { useRefreshOnFocus } from '@/lib/use-refresh-on-focus';
import { INSIGHT_CATEGORIES, listInsights, type Insight, type InsightCategory } from './insights-api';
import { InsightRefresh } from './insight-refresh';

const LABELS = { future: 'Future', reflections: 'Reflections', past: 'Past' };
const DESCRIPTIONS = {
  future: 'Look ahead with evidence from your connected accounts. These are possibilities, not promises.',
  reflections: 'Notice patterns in your connected accounts and make room for what matters.',
  past: 'Catch up with summaries Bob has already prepared for you.',
};
const EMPTY = {
  future: 'No outlooks yet. Bob will show the sources and uncertainty behind each one.',
  reflections: 'No reflections yet. As saved results arrive, this is where you can look back on patterns.',
  past: 'Saved perspectives from your integrations will appear here. Routine recaps live in each routine’s timeline.',
};

export function InsightsPage(): ReactElement {
  const { session } = useSession();
  return <InsightsContent key={session?.user.id ?? 'signed-out'} />;
}

function InsightsContent(): ReactElement {
  const route = routeFromPath(useLocationPath());
  const category = route.kind === 'insights' ? route.category : 'future';
  const padding = usePagePadding();
  const { isMobile } = useAppShellMobile();
  return <Layout height="fill" padding={padding} contentWidth={PAGE_WIDTH}
    header={<LayoutHeader><VStack gap={3}>
      <PageTitle>Insights</PageTitle>
      <PageSubtitle>A little perspective from your integrations. Only you can see these.</PageSubtitle>
      <TabList value={category} onChange={(value) => navigateTo(`/insights/${value}`)} hasDivider isFullBleed={!isMobile}>
        {INSIGHT_CATEGORIES.map((value) => <Tab key={value} value={value} label={LABELS[value]} href={`/insights/${value}`} onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); navigateTo(`/insights/${value}`);
        }} />)}
      </TabList>
    </VStack></LayoutHeader>}
    content={<LayoutContent label={`${LABELS[category]} insights`}><InsightResults key={category} category={category} /></LayoutContent>} />;
}

function InsightResults({ category }: { category: InsightCategory }): ReactElement {
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const focus = useRefreshOnFocus();
  const hash = useLocationHash();
  const { isMobile } = useAppShellMobile();
  useEffect(() => {
    let current = true;
    void listInsights(category).then((items) => { if (current) { setInsights(items); setFailed(false); } })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [category, retry, focus]);
  useEffect(() => {
    const result = insights?.find((insight) => `#${encodeURIComponent(insight.id)}` === hash);
    if (result) document.getElementById(result.id)?.scrollIntoView?.({ block: 'start' });
  }, [insights, hash]);
  return <VStack gap={5}>
    <Text>{DESCRIPTIONS[category]}</Text>
    {category !== 'past' && <InsightRefresh category={category} onPrepared={() => setRetry((value) => value + 1)} />}
    {failed && <Banner status="error" title="Couldn't load your insights" description="Your saved results are still yours. Try again in a moment."
      endContent={<Button label="Retry" onClick={() => setRetry((value) => value + 1)} />} />}
    {!failed && insights === null && <Text role="status">Opening your insights…</Text>}
    {insights?.length === 0 && <EmptyState isCompact={isMobile} title={`A fresh start for ${LABELS[category].toLowerCase()}`} description={EMPTY[category]} />}
    {insights?.map((insight) => <InsightResult key={insight.id} insight={insight} />)}
  </VStack>;
}

function InsightResult({ insight }: { insight: Insight }): ReactElement {
  const coverage = insight.category === 'reflections' ? null : insight.category === 'future' ? `${insight.sources.length} calendar sources included` : `${insight.messageCount} messages reviewed`;
  return <SavedSummary result={insight} coverage={coverage} />;
}
