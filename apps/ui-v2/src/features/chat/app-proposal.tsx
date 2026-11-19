import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { AppRequestError, changeApp, getApp, type BobApp } from '@/features/bob-apps/bob-apps-api';
import type { AppProposalRef } from './tool-calls';

type Status = 'loading' | 'ready' | 'active' | 'changed' | 'unavailable' | 'load-error' | 'conflict';
function statusOf(app: BobApp, proposal: AppProposalRef): Status {
  if (app.id !== proposal.id || app.spaceId !== null || !app.canManage) return 'unavailable';
  if (app.lifecycle === 'active') return 'active';
  return app.lifecycle === 'draft' && app.revision === proposal.revision && app.pendingDefinition === null ? 'ready' : 'changed';
}

/** Conversation content only; the existing authenticated command owns activation. */
export function AppProposal({ proposal }: { proposal: AppProposalRef }): ReactElement | null {
  const [status, setStatus] = useState<Status>('loading');
  const [app, setApp] = useState<BobApp | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readVersion, setReadVersion] = useState(0);
  const mutationId = useRef<string | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let current = true;
    setStatus('loading');
    void getApp(proposal.id).then((saved) => {
      if (!current) return;
      setApp(saved); setStatus(statusOf(saved, proposal));
    }).catch(() => { if (current) setStatus('load-error'); });
    return () => { current = false; alive.current = false; };
  }, [proposal.id, proposal.revision, readVersion]);

  const recover = async (): Promise<void> => {
    try {
      const saved = await getApp(proposal.id);
      if (!alive.current) return;
      setApp(saved); setStatus(statusOf(saved, proposal));
      if (statusOf(saved, proposal) === 'active') return;
    } catch { /* The outcome remains unknown until a fresh authorized read succeeds. */ }
    if (alive.current) setError(true);
  };
  const show = (saved: BobApp): void => {
    if (!alive.current) return;
    setApp(saved); setStatus(statusOf(saved, proposal));
  };
  const failed = async (cause: unknown): Promise<void> => {
    if (!alive.current) return;
    if (cause instanceof AppRequestError && cause.status === 409) setStatus('conflict');
    else await recover();
  };
  const accept = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(false);
    try {
      const current = await getApp(proposal.id);
      if (!alive.current) return;
      setApp(current); setStatus(statusOf(current, proposal));
      if (statusOf(current, proposal) !== 'ready') return;
      mutationId.current ??= crypto.randomUUID();
      const saved = await changeApp(current, 'activate', mutationId.current);
      show(saved);
    } catch (cause) { await failed(cause); }
    finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return <ProposalContent proposal={proposal} title={app?.definition.title ?? proposal.title} status={status}
    error={error} busy={busy} onAccept={accept} onRetry={() => { setReadVersion((value) => value + 1); }} />;
}

function ProposalContent({ proposal, title, status, error, busy, onAccept, onRetry }: {
  proposal: AppProposalRef; title: string; status: Status; error: boolean; busy: boolean;
  onAccept: () => Promise<void>; onRetry: () => void;
}): ReactElement | null {
  if (status === 'loading' || status === 'unavailable') return null;
  return <Card><VStack gap={2}>
    <Text type="label">{title}</Text>
    {status === 'active' ? <Text role="status">Your app is ready. Make it yours.</Text>
      : <Text type="supporting">{status === 'ready' ? 'A little app, ready when you are.' : 'Open the app to review its latest version.'}</Text>}
    {status === 'conflict' && <Banner status="warning" title="This app changed. Review it before using it." />}
    {error && <Banner status="error" title="I couldn't confirm that. Your proposal is still here." />}
    {status === 'load-error' && <Banner status="error" title="Couldn't open this app" />}
    <HStack gap={2} wrap="wrap">
      {status === 'ready' && <Button label={error ? 'Retry' : 'Use this app'} variant="primary" isLoading={busy} onClick={() => { void onAccept(); }} />}
      {status === 'load-error' ? <Button label="Retry" onClick={onRetry} />
        : <Button label={status === 'active' ? 'Open app' : 'Review app'} variant="ghost" href={`/apps/${proposal.id}`} />}
    </HStack>
  </VStack></Card>;
}
