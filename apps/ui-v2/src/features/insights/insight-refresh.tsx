import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { listGoogleAccounts, type GoogleAccount } from '@/features/integrations/google-accounts-api';
import { useRefreshOnFocus } from '@/lib/use-refresh-on-focus';
import { refreshInsights } from './insights-api';

export function InsightRefresh({ category, onPrepared }: {
  category: 'future' | 'reflections'; onPrepared: () => void;
}): ReactElement {
  const [accounts, setAccounts] = useState<GoogleAccount[] | null>(null);
  const [accountId, setAccountId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const alive = useRef(true);
  const focus = useRefreshOnFocus();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    void listGoogleAccounts().then((items) => { if (current) { setAccounts(items); setError(null); } })
      .catch(() => { if (current) setError("Couldn't load your Google accounts. Try again."); });
    return () => { current = false; };
  }, [retry, focus]);
  const capability = category === 'future' ? 'calendar.read' : 'gmail.read';
  const eligible = accounts?.filter((account) => !account.needsReconnect && account.access.includes(capability)) ?? [];
  const prepare = async (): Promise<void> => {
    if (busy || !eligible.some((account) => account.id === accountId)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const results = await refreshInsights(accountId, category);
      if (!alive.current) return;
      setNotice(results.length > 0 ? 'Your fresh perspective is ready below.' : noResults(category));
      onPrepared();
    } catch (problem) { if (alive.current) setError(refreshError(problem)); }
    finally { if (alive.current) setBusy(false); }
  };
  return <VStack gap={3}>
    <Text>{category === 'future' ? 'Bob can look at the next seven days on your selected calendars to spot busy days and overlaps.' : 'Bob can compare saved email summaries to reflect on the periods they cover. No new emails are read for this.'}</Text>
    {error && <Banner status="error" title={error} endContent={accounts === null ? <Button label="Retry accounts" onClick={() => setRetry((value) => value + 1)} /> : <Button label="Manage integrations" href="/integrations" />} />}
    {accounts === null && !error && <Text role="status">Checking your connected accounts…</Text>}
    {accounts !== null && eligible.length === 0 && <Banner status="info" title={`Connect an account with ${category === 'future' ? 'Calendar' : 'Gmail'} access`}
      endContent={<Button label="Manage integrations" href="/integrations" />} />}
    {eligible.length > 0 && <>
      <Selector label="Google account" placeholder="Choose an account" value={accountId} onChange={setAccountId} isDisabled={busy}
        options={eligible.map((account) => ({ value: account.id, label: account.email }))} />
      <Button label={category === 'future' ? 'Prepare outlook' : 'Reflect on summaries'} isDisabled={busy || !eligible.some((account) => account.id === accountId)}
        isLoading={busy} onClick={() => void prepare()} />
    </>}
    {notice && <Text role="status">{notice}</Text>}
  </VStack>;
}

function noResults(category: 'future' | 'reflections'): string {
  return category === 'reflections' ? 'Bob needs at least two saved email summaries from different periods to reflect on.'
    : 'No outlook was prepared. Check your calendar selection in Integrations.';
}

function refreshError(problem: unknown): string {
  return problem instanceof Error && problem.message === 'insight_no_selected_calendars'
    ? 'Choose calendars in Integrations before preparing your outlook.' : "Couldn't prepare this insight. Check your Google connection and try again.";
}
