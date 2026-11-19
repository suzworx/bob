import type { ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { useMarketingReview } from './use-marketing-review';

export type ReviewController = ReturnType<typeof useMarketingReview>;
export function MarketingReviewPanel({ review, onNote }: { review: ReviewController; onNote: () => void }): ReactElement {
  const data = review.data;
  const drafts = data?.snapshot.drafts ?? [];
  const instagram = drafts.filter((draft) => draft.channel === 'instagram').length;
  const linkedin = drafts.length - instagram;
  return <VStack gap={3}>
    <Heading level={3}>Team review</Heading>
    <Text>Publishing is not connected.</Text>
    {review.error && <Banner status="warning" title={review.error} />}
    {review.loading && <Text role="status">Opening the complete saved plan…</Text>}
    {data && <>
      <Text>{`${drafts.length} posts · ${instagram} Instagram · ${linkedin} LinkedIn. Approval covers every saved post, across all channels.`}</Text>
      <Text>{data.state === 'approved' && !review.changed ? 'Plan approved. Publishing is not connected.' : 'This plan needs review.'}</Text>
      {data.notes.length > 0 && <VStack gap={2}><Heading level={3}>Team notes</Heading>{data.notes.map((note) => <VStack gap={1} key={note.id}><Text type="supporting">{`${note.author?.label ?? 'A team member'} · Bob’s summary`}</Text><Text>{note.text}</Text></VStack>)}</VStack>}
      <HStack gap={2} wrap="wrap"><Button label="Add a review note" onClick={onNote} />
        {data.canApprove && <Button label="Approve this plan" variant="primary" isDisabled={review.busy || review.loading || review.changed || data.state === 'approved' || drafts.length === 0} onClick={() => void review.approve()} />}
      </HStack>
    </>}
    <Button label="Refresh plan review" variant="ghost" isDisabled={review.busy || review.loading} onClick={review.refresh} />
  </VStack>;
}
