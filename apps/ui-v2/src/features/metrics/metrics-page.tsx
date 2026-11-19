import { useState, type ReactElement, type ReactNode } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Grid } from '@astryxdesign/core/Grid';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { StackItem } from '@astryxdesign/core/Stack';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import { VStack } from '@astryxdesign/core/VStack';
import { navigateTo } from '@/app/routes';
import { PAGE_WIDTH, PageTitle, usePagePadding } from '../../app/page-width';
import { LensAi } from './lens-ai';
import { LensDevices } from './lens-devices';
import { LensFeatures } from './lens-features';
import { LensReliability } from './lens-reliability';
import { LensUsers } from './lens-users';
import type { MetricsRange } from './metrics-api';
import { useOperatorAccessState } from './use-operator-access';
import { useOperatorMetrics, type MetricsLens, type OperatorMetrics } from './use-operator-metrics';

const RANGES: ReadonlyArray<{ key: MetricsRange; label: string }> = [
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
];
const LENSES: ReadonlyArray<{ key: MetricsLens; label: string }> = [
  { key: 'users', label: 'Users' },
  { key: 'reliability', label: 'Reliability' },
  { key: 'ai', label: 'AI' },
  { key: 'devices', label: 'Devices' },
  { key: 'features', label: 'Features' },
];
const DEFAULT_RANGE: MetricsRange = '7d';
const DEFAULT_LENS: MetricsLens = 'users';
const LOAD_ERROR = 'Metrics could not be loaded.';
const ACCESS_ERROR = 'Access could not be checked.';
const SKELETON_TILES = 4;

// The lens and range live in the query string (?lens=…&range=…) so a reload or
// a shared link opens the same view. Other query keys and the hash are kept.
function fromQuery(): { lens: MetricsLens; range: MetricsRange } {
  const query = new URLSearchParams(window.location.search);
  return {
    lens: LENSES.find(({ key }) => key === query.get('lens'))?.key ?? DEFAULT_LENS,
    range: RANGES.find(({ key }) => key === query.get('range'))?.key ?? DEFAULT_RANGE,
  };
}

function writeQuery(lens: MetricsLens, range: MetricsRange): void {
  const query = new URLSearchParams(window.location.search);
  query.set('lens', lens);
  query.set('range', range);
  window.history.replaceState(window.history.state, '', `${window.location.pathname}?${query.toString()}${window.location.hash}`);
}

function LoadingLens(): ReactElement {
  return (
    <VStack gap={6}>
      <VisuallyHidden>
        <Text role="status">Loading metrics…</Text>
      </VisuallyHidden>
      <Grid columns={{ minWidth: 190, repeat: 'fit' }} gap={4}>
        {Array.from({ length: SKELETON_TILES }, (_, index) => (
          <Card key={index}>
            <VStack gap={2}>
              <Skeleton height={16} width="60%" index={index} />
              <Skeleton height={28} width="40%" index={index} />
            </VStack>
          </Card>
        ))}
      </Grid>
      <Card>
        <Skeleton height={240} index={SKELETON_TILES} />
      </Card>
    </VStack>
  );
}

function ActiveLens({ metrics, retry }: { metrics: OperatorMetrics; retry: () => void }): ReactElement | null {
  if (metrics.state === 'loading') return <LoadingLens />;
  if (metrics.state === 'failed') {
    return <Banner status="error" title={LOAD_ERROR} container="card" endContent={<Button label="Retry" size="sm" variant="secondary" onClick={retry} />} />;
  }
  switch (metrics.lens) {
    case 'reliability':
      return <LensReliability usage={metrics.usage} voice={metrics.voice} platform={metrics.platform} />;
    case 'ai':
      return <LensAi ai={metrics.ai} />;
    case 'devices':
      return <LensDevices devices={metrics.devices} />;
    case 'features':
      return <LensFeatures features={metrics.features} />;
    case 'users':
      return <LensUsers users={metrics.users} />;
  }
}

function MetricsView({ embedded }: { embedded: boolean }): ReactElement {
  const padding = usePagePadding();
  const { isMobile } = useAppShellMobile();
  const [{ lens, range }, setView] = useState(fromQuery);
  const { metrics, retry } = useOperatorMetrics(lens, range);
  const show = (next: { lens: MetricsLens; range: MetricsRange }): void => {
    writeQuery(next.lens, next.range);
    setView(next);
  };
  const setLens = (value: string): void => show({ lens: LENSES.find((l) => l.key === value)?.key ?? lens, range });
  const rangeControl = (
    <SegmentedControl label="Time range" size="sm" value={range} onChange={(value) => show({ lens, range: RANGES.find((r) => r.key === value)?.key ?? range })}>
      {RANGES.map(({ key, label }) => (
        <SegmentedControlItem key={key} value={key} label={label} />
      ))}
    </SegmentedControl>
  );
  const lensTabs = (
    <TabList role="tablist" value={lens} onChange={setLens} hasDivider>
      {LENSES.map(({ key, label }) => (
        <Tab key={key} value={key} label={label} />
      ))}
    </TabList>
  );
  const body = <ActiveLens metrics={metrics} retry={retry} />;
  if (embedded) {
    // Inside the Admin page's Monitoring tab: the page owns the frame and the title.
    return (
      <VStack gap={4}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <StackItem size="fill">
            <Text type="supporting" maxLines={isMobile ? 1 : undefined}>Anonymous aggregates only: counts and times, never a person.</Text>
          </StackItem>
          {rangeControl}
        </HStack>
        {lensTabs}
        {body}
      </VStack>
    );
  }
  return (
    <Layout
      height="fill"
      padding={padding}
      contentWidth={PAGE_WIDTH}
      header={
        <LayoutHeader>
          <VStack gap={4}>
            <HStack gap={2} vAlign="start" wrap="wrap">
              <StackItem size="fill">
                <VStack gap={1}>
                  <PageTitle>Metrics</PageTitle>
                  <Text type="supporting">Anonymous aggregates only: counts and times, never a person.</Text>
                </VStack>
              </StackItem>
              {rangeControl}
            </HStack>
            {lensTabs}
          </VStack>
        </LayoutHeader>
      }
      content={<LayoutContent>{body}</LayoutContent>}
    />
  );
}

function Frame({ embedded, children }: { embedded: boolean; children: ReactNode }): ReactElement {
  const padding = usePagePadding();
  if (embedded) return <VStack gap={4}>{children}</VStack>;
  return <Layout height="fill" padding={padding} contentWidth={PAGE_WIDTH} content={<LayoutContent>{children}</LayoutContent>} />;
}

/**
 * The operator metrics. Standalone it is a full page with its own title;
 * `embedded` drops the page frame and title so the Admin page can show it as
 * its Monitoring tab. Either way only an operator sees any number.
 */
export function MetricsPage({ embedded = false }: { embedded?: boolean } = {}): ReactElement {
  const { access, retry } = useOperatorAccessState();
  if (access === 'yes') return <MetricsView embedded={embedded} />;
  return (
    <Frame embedded={embedded}>
      {access === 'checking' && (
        <Text type="supporting" role="status">
          Checking access…
        </Text>
      )}
      {access === 'failed' && (
        <Banner status="error" title={ACCESS_ERROR} container="card" endContent={<Button label="Retry" size="sm" variant="secondary" onClick={retry} />} />
      )}
      {access === 'no' && (
        <EmptyState
          title="Not available"
          description="Metrics are only shown to the people who run this service."
          headingLevel={2}
          actions={<Button label="Back to chat" variant="secondary" onClick={() => navigateTo('/')} />}
        />
      )}
    </Frame>
  );
}
