import { useEffect, useState } from 'react';
import { listGoogleAccounts } from '@/features/integrations/google-accounts-api';
import { getTools } from '@/features/tools/tools-api';
import { useSession } from '@/lib/auth/use-session';
import { useRefreshOnFocus } from '@/lib/use-refresh-on-focus';
import type { MentionMember } from './use-mention-picker';
import { integrationMentions } from './platform-mentions';

/** Private references are dropped immediately when owner or conversation changes. */
export function useIntegrationMentions(privateContext: boolean, conversationId?: string): MentionMember[] {
  const { session } = useSession();
  const owner = privateContext ? session?.user.id ?? null : null;
  const scopeKey = `${owner ?? ''}:${conversationId ?? ''}`;
  const refreshKey = useRefreshOnFocus();
  const [policyRevision, setPolicyRevision] = useState(0);
  useEffect(() => {
    const changed = (): void => setPolicyRevision((value) => value + 1);
    window.addEventListener('bob:tool-preferences-changed', changed);
    return () => window.removeEventListener('bob:tool-preferences-changed', changed);
  }, []);
  const [loaded, setLoaded] = useState<{ scopeKey: string; members: MentionMember[] } | null>(null);
  useEffect(() => {
    if (!owner) return undefined;
    const controller = new AbortController();
    void listGoogleAccounts().then(async (accounts) => {
      const entries = await Promise.all(accounts.map(async (account): Promise<[string, ReadonlySet<string>]> => {
        try {
          const result = await getTools({ integrationId: account.id, ...(conversationId ? { conversationId } : {}) }, controller.signal);
          return [account.id, new Set(result.tools.filter((tool) => tool.enabled).map((tool) => tool.toolName))];
        } catch { return [account.id, new Set<string>()]; }
      }));
      if (!controller.signal.aborted) setLoaded({ scopeKey, members: integrationMentions(accounts, new Map(entries)) });
    }).catch(() => {
      if (!controller.signal.aborted) setLoaded({ scopeKey, members: [] });
    });
    return () => controller.abort();
  }, [owner, scopeKey, conversationId, refreshKey, policyRevision]);
  return owner && loaded?.scopeKey === scopeKey ? loaded.members : [];
}
