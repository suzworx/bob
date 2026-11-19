import { useState, type ReactElement } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { ListItem } from '@astryxdesign/core/List';
import { appPath, navigateTo } from '@/app/routes';
import { installMarketing, type Installation, type MarketingPackage } from './marketing-api';

export function MarketingInstall({ pack, installations, onChanged, onFailure, spaceId, canManage = true }: { spaceId?: string | null; canManage?: boolean; pack: MarketingPackage; installations: Installation[]; onChanged: () => void; onFailure: (failed: boolean) => void }): ReactElement {
  const [busy, setBusy] = useState(false);
  const [mutationId] = useState(() => crypto.randomUUID());
  const installed = installations[0];
  const install = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); onFailure(false);
    try { const item = await installMarketing(mutationId, spaceId); onChanged(); navigateTo(appPath(item.appId, spaceId)); }
    catch { onFailure(true); onChanged(); }
    finally { setBusy(false); }
  };
  // Truthful only while the catalog says publishing is off; the catalog's own reason is written for us, not for people.
  const postsNothing = pack.capabilities.find((item) => item.id === 'publishing')?.status === 'unavailable';
  return <ListItem label="Bob Marketing" description={<>{`Turn ideas into campaigns and posts with Bob.${postsNothing ? ' Nothing gets posted for you.' : ''}`}</>}
    endContent={<Button label={installed ? 'Open Marketing' : 'Install Marketing'} size="sm" isDisabled={busy || (!installed && !canManage)} onClick={() => installed ? navigateTo(appPath(installed.appId, spaceId)) : void install()} />} />;
}
