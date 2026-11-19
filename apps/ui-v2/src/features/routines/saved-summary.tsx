import type { ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Heading } from '@astryxdesign/core/Heading';
import { List, ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { RichMarkdown } from '@/features/chat/rich-markdown';
import type { RoutineResult } from './routines-api';

export function SavedSummary({ result, coverage = `${result.messageCount} messages reviewed` }: { result: RoutineResult; coverage?: string | null }): ReactElement {
  return <VStack as="article" id={result.id} gap={4} aria-label={result.title}>
    <Heading level={2}>{result.title}</Heading>
    <Text type="supporting">{`${new Date(result.periodStart).toLocaleDateString()} – ${new Date(result.periodEnd).toLocaleDateString()}${coverage ? ` · ${coverage}` : ''}`}</Text>
    {result.partial && <Banner status="warning" title="A partial picture" description="Some messages were unavailable. This recap covers the information Bob could read." />}
    <RichMarkdown>{result.summary}</RichMarkdown>
    {result.sources.length > 0 && <Collapsible value={`sources-${result.id}`} defaultIsOpen={false} trigger={`Sources (${result.sources.length})`}>
      <List hasDividers>{result.sources.map((source) => <ListItem key={`${source.kind}:${source.id}`} label={source.label || (source.kind === 'gmail' ? 'Email source' : 'Calendar source')}
        description={source.kind === 'gmail' ? 'Email' : 'Calendar'} href={source.url} target={source.url ? '_blank' : undefined} />)}</List>
    </Collapsible>}
    <Text type="supporting">{`Prepared ${new Date(result.generatedAt).toLocaleString()}`}</Text>
  </VStack>;
}
