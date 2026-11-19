import type { ReactElement } from 'react';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { VStack } from '@astryxdesign/core/VStack';
import { useLocationSearch } from '@/app/routes';
import { PAGE_WIDTH, PageTitle, usePagePadding, PageSubtitle } from '@/app/page-width';
import { ToolControls } from './tool-controls';
import type { ToolContext } from './tools-api';
export function ToolsPage(): ReactElement {
  const padding = usePagePadding();
  const params = new URLSearchParams(useLocationSearch());
  const context: ToolContext = {};
  for (const key of ['spaceId', 'conversationId', 'integrationId'] as const) {
    const value = params.get(key);
    if (value) context[key] = value;
  }
  return <Layout height="fill" padding={padding} contentWidth={PAGE_WIDTH}
    header={<LayoutHeader><VStack gap={1}><PageTitle>Tools</PageTitle>
      <PageSubtitle>Choose what Bob can help with. Keep the tools you need, and turn the rest off.</PageSubtitle></VStack></LayoutHeader>}
    content={<LayoutContent label="Tools"><ToolControls context={context} /></LayoutContent>} />;
}
