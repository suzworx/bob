import type { ReactElement } from 'react';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { BRAND } from '@/lib/brand';
import { PAGE_WIDTH, PageTitle, usePagePadding } from '../../app/page-width';
import { GoogleAccountsSection } from './google-accounts-section';

/** /integrations: the accounts the assistant can use. The Google section reads
 * an OAuth return (?state=…, ?error=…) from the URL itself, so the callback can
 * land here directly. */
export function IntegrationsPage(): ReactElement {
  const padding = usePagePadding();
  const { isMobile } = useAppShellMobile();
  return <Layout height="fill" padding={padding} contentWidth={PAGE_WIDTH}
    header={<LayoutHeader><VStack gap={1}>
      <PageTitle>Integrations</PageTitle>
      <Text type="supporting" maxLines={isMobile ? 1 : undefined}>{`Accounts ${BRAND.assistantName} can use for you. Only you can see these.`}</Text>
    </VStack></LayoutHeader>}
    content={<LayoutContent label="Integrations"><GoogleAccountsSection headingLevel={2} /></LayoutContent>} />;
}
