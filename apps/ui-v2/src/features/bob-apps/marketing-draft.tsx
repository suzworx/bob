import { useCallback, useState, useSyncExternalStore, type ReactElement } from 'react';
import { useClipboard } from '@astryxdesign/core/hooks';
import { Badge } from '@astryxdesign/core/Badge';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import type { Draft, MarketingPackage } from './marketing-api';
import type { MarketingDraftEdits } from './marketing-draft-edits';
import { PostCreative } from './post-creative';

/** A week post keeps its day and story beat in the pillar field as "Day N · pillar · beat". Any other pillar is just a pillar. */
export function weekLabel(pillar: string | null): { day: number | null; pillar: string | null; beat: string | null } {
  const [, day, name, beat] = /^Day (\d+) · (.+) · (.+)$/.exec(pillar ?? '') ?? [];
  return day ? { day: Number(day), pillar: name ?? null, beat: beat ?? null } : { day: null, pillar, beat: null };
}

function DraftEditor({ draft, edits, edit, writable }: { draft: Draft; edits: MarketingDraftEdits; edit: NonNullable<ReturnType<MarketingDraftEdits['read']>>; writable: boolean }): ReactElement {
  const { body, altText, pillar, busy, error, conflict, cancelRequested } = edit;
  const stale = edit.base.contentRevision !== draft.contentRevision;
  const locked = busy || Boolean(edit.submitted) || !writable;
  return <FormLayout>
    {error && <Banner status="error" title={error} />}
    {(stale || conflict) && !edit.submitted && <VStack gap={3}><Banner status="warning" title="This draft changed while you were editing. Your edits are still here." />
      <Text type="supporting">Latest saved text</Text><Text>{draft.body}</Text>
      <Button label="Keep my edits against latest draft" isDisabled={!stale || locked} onClick={() => edits.useLatest(draft)} /></VStack>}
    {busy && <Text role="status">Saving this draft…</Text>}
    <TextArea label={draft.channel === 'instagram' ? 'Caption' : 'Post narrative'} value={body} isDisabled={locked} onChange={(value) => edits.change(draft.id, 'body', value)} rows={6} />
    <TextArea label="Image description" value={altText} isDisabled={locked} onChange={(value) => edits.change(draft.id, 'altText', value)} />
    <TextInput label="Pillar" value={pillar} isDisabled={locked} onChange={(value) => edits.change(draft.id, 'pillar', value)} />
    <HStack gap={2} wrap="wrap"><Button label={edit.submitted && !busy ? 'Retry save' : 'Save draft'} variant="primary" isDisabled={busy || !writable || conflict || (stale && !edit.submitted)} onClick={() => void edits.save(draft)} />
      <Button label="Cancel" isDisabled={busy} onClick={() => edits.close(draft.id)} /></HStack>
    {cancelRequested && <Banner status="warning" title="Discard your unsaved edits?" endContent={<HStack gap={2}><Button label="Keep editing" onClick={() => edits.keep(draft.id)} /><Button label="Discard edits" onClick={() => edits.close(draft.id, true)} /></HStack>} />}
  </FormLayout>;
}

function CopyPost({ body }: { body: string }): ReactElement {
  const { copy, isCopied } = useClipboard({ announce: 'Post copied' });
  const [failed, setFailed] = useState(false);
  return <><Button label={isCopied ? 'Copied' : 'Copy post'} variant="primary" onClick={() => void copy(body).then((done) => setFailed(!done))} />
    {failed && <Text role="alert">Couldn't copy this post. Select the text and copy it yourself.</Text>}</>;
}

export function MarketingDraft({ draft, assets, writable, edits, onAsk, reviewing = false }: { draft: Draft; assets: MarketingPackage['assets']; writable: boolean; edits: MarketingDraftEdits; onAsk?: (draft: Draft) => void; reviewing?: boolean }): ReactElement {
  const { isMobile } = useAppShellMobile();
  const subscribe = useCallback((listener: () => void) => edits.subscribe(draft.id, listener), [edits, draft.id]);
  const snapshot = useCallback(() => edits.read(draft.id), [edits, draft.id]);
  const edit = useSyncExternalStore(subscribe, snapshot);
  const playful = assets.some((asset) => draft.approvedAssetIds.includes(asset.id) && asset.url.includes('bob-playful'));
  const creative = <PostCreative text={draft.body} channel={draft.channel} artUrl={playful ? '/brand/bob/bob-playful.webp' : '/brand/bob/bob-helper.webp'} />;
  const week = weekLabel(draft.pillar);
  const about = [week.beat, week.pillar].filter(Boolean).join(' · ');
  return <Card><VStack gap={isMobile ? 1 : 3}>
    <HStack gap={2} wrap="wrap"><Badge label={draft.channel === 'instagram' ? 'Instagram' : 'LinkedIn'} />{draft.state === 'needs_check' && <Badge variant="warning" label="Needs check" />}</HStack>
    {about && <Text type="supporting">{about}</Text>}
    {draft.body.split('\n').map((paragraph, index) => <Text key={`${index}:${paragraph}`}>{paragraph}</Text>)}
    {creative}
    {edit && !reviewing ? <DraftEditor draft={draft} edits={edits} edit={edit} writable={writable} />
      : <HStack gap={2} wrap="wrap" vAlign="center"><CopyPost body={draft.body} />{!reviewing && <Button label="Edit draft" isDisabled={!writable} onClick={() => edits.open(draft)} />}
        {!reviewing && writable && onAsk && <Button label="Ask Bob to change it" variant="ghost" onClick={() => onAsk(draft)} />}</HStack>}
  </VStack></Card>;
}
