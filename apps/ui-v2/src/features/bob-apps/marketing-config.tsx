import { useRef, useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { configDetail, configMutation, MarketingRequestError, type ConfigDetail } from './marketing-api';

const fieldLabel = { visibleViews: 'Views and order', contentGrouping: 'Content grouping', defaultChannels: 'Default channels' };
const display = (value: string | string[]): string => Array.isArray(value) ? value.join(', ') : value;

export function MarketingConfig({ detail, writable, canManage = true, onChanged }: { detail: ConfigDetail; writable: boolean; canManage?: boolean; onChanged: () => void }): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [older, setOlder] = useState<ConfigDetail['versions']>([]);
  const [beforeRevision, setBeforeRevision] = useState<number | null | undefined>(undefined);
  const mutation = useRef<{ fingerprint: string; id: string } | null>(null);
  const id = detail.installation.id;
  const revision = detail.installation.configRevision;
  const act = async (action: 'apply' | 'discard' | 'restore', payload: Record<string, unknown>): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(null);
    const fingerprint = JSON.stringify({ action, payload, revision });
    if (mutation.current?.fingerprint !== fingerprint) mutation.current = { fingerprint, id: crypto.randomUUID() };
    try {
      await configMutation(id, action, { ...payload, mutationId: mutation.current.id, expectedConfigRevision: revision });
      setOlder([]); setBeforeRevision(undefined); setPreview(null); onChanged();
    } catch (cause) {
      setError(cause instanceof MarketingRequestError && cause.status === 409 ? 'The app changed. Your conversation is safe. Review the latest version before trying again.' : "Couldn't save that app change. Please try again.");
      onChanged();
    } finally { setBusy(false); }
  };
  const more = async (): Promise<void> => {
    const before = beforeRevision === undefined ? detail.nextBeforeRevision : beforeRevision;
    if (!before || busy) return;
    setBusy(true);
    try { const page = await configDetail(id, undefined, before); setOlder((items) => [...items, ...page.versions]); setBeforeRevision(page.nextBeforeRevision); }
    catch { setError("Couldn't open older versions. Try again."); }
    finally { setBusy(false); }
  };
  return <VStack gap={4}>
    <Heading level={2}>Improve this app</Heading><Text>Ask Bob below. You see the change first, and your posts stay as they are.</Text>
    {error && <Banner status="warning" title={error} />}
    <Heading level={3}>{`Current app · Version ${revision}`}</Heading>
    <Text>{`Views: ${detail.installation.config.visibleViews.join(', ')}`}</Text><Text>{`Grouping: ${detail.installation.config.contentGrouping}`}</Text>
    <Text>{`Default channels: ${detail.installation.config.defaultChannels.join(', ')}`}</Text>
    {detail.pending.length === 0 && <Text>Ask Bob for an app change. A proposal appears here before anything is applied.</Text>}
    {detail.pending.map((proposal) => <VStack gap={3} key={proposal.id}>
      <Heading level={3}>Proposed app change</Heading><Text>{`Based on version ${proposal.baseConfigRevision}. No saved data changes.`}</Text>
      {proposal.baseConfigRevision !== revision && <Text>{`The app is now on version ${revision}, so this proposal can no longer be applied. Discard it or ask Bob for a new one.`}</Text>}
      {proposal.changes.map((change) => <Text key={change.field}>{`${fieldLabel[change.field]}: ${display(change.before)} → ${display(change.after)}`}</Text>)}
      <HStack gap={2} wrap="wrap"><Button label="Preview changes" onClick={() => setPreview(preview === proposal.id ? null : proposal.id)} />
        {canManage && <Button label="Apply changes" variant="primary" isDisabled={busy || !writable || !canManage || proposal.baseConfigRevision !== revision} onClick={() => void act('apply', { proposalId: proposal.id, hash: proposal.canonicalHash })} />}
        {canManage && <Button label="Discard proposal" isDisabled={busy || !writable || !canManage} onClick={() => void act('discard', { proposalId: proposal.id })} />}</HStack>
      {preview === proposal.id && <VStack gap={2}><Heading level={3}>Preview only</Heading><Text>{`Views in order: ${proposal.config.visibleViews.join(' → ')}`}</Text><Text>{`Group content by: ${proposal.config.contentGrouping}`}</Text><Text>{`Default channels: ${proposal.config.defaultChannels.join(', ')}`}</Text><Text>No changes have been applied.</Text></VStack>}
    </VStack>)}
    <Heading level={3}>App history</Heading>
    {[...detail.versions, ...older].map((version) => <VStack gap={2} key={version.revision}><Text>{`Version ${version.revision} · ${new Date(version.createdAt).toLocaleString()} · Package ${version.packageVersion}`}</Text>
      <HStack>{canManage && <Button label={`Restore version ${version.revision}`} isDisabled={busy || !writable || !canManage || !version.restorable || version.revision === revision} onClick={() => void act('restore', { versionRevision: version.revision })} />}</HStack></VStack>)}
    {(beforeRevision === undefined ? detail.nextBeforeRevision : beforeRevision) && <Button label="Load older versions" isDisabled={busy} onClick={() => void more()} />}
    <Heading level={3}>Not available yet</Heading>{detail.dependencies.map((dependency) => <Text key={dependency.id}>{dependency.reason}</Text>)}
  </VStack>;
}
