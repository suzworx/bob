import { useState, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { appPath, navigateTo } from '@/app/routes';
import { changeApp, deleteApp, exportApp, type BobApp } from './bob-apps-api';
import type { useBobApps } from './use-bob-apps';

export type AppMenuItems = ComponentProps<typeof MoreMenu>['items'];
type State = Pick<ReturnType<typeof useBobApps>, 'busy' | 'perform'>;
type Props = { app: BobApp; state: State; marketing?: boolean; onDetails?: () => void; onShareImage?: () => void; onChanged?: () => void; render?: (items: AppMenuItems, confirmation: ReactNode) => ReactElement };

function regularItems(app: BobApp, busy: boolean, mutate: (operation: Parameters<typeof changeApp>[1]) => void, onExport: () => void, onDetails?: () => void): AppMenuItems {
  return [
    ...(onDetails ? [{ label: 'App details', onClick: onDetails }] : []),
    ...(!app.spaceId ? [{ label: 'Duplicate app', isDisabled: busy, onClick: () => mutate('duplicate') }] : []),
    { label: 'Export JSON', isDisabled: busy, onClick: onExport },
    ...(app.canManage && app.canUndo ? [{ label: 'Undo last change', isDisabled: busy, onClick: () => mutate('undo') }] : []),
    ...(app.canManage && (app.lifecycle === 'active' || app.lifecycle === 'paused') ? [{ label: app.lifecycle === 'paused' ? 'Resume app' : 'Pause app', isDisabled: busy, onClick: () => mutate(app.lifecycle === 'paused' ? 'resume' : 'pause') }] : []),
  ];
}

/** Secondary actions share one menu; deleting still requires its own explicit confirmation. */
export function AppActions({ app, state, marketing = false, onDetails, onShareImage, onChanged, render }: Props): ReactElement {
  const [removing, setRemoving] = useState(false);
  const mutate = (operation: Parameters<typeof changeApp>[1]): void => {
    void state.perform(async () => { const result = await changeApp(app, operation); if (operation === 'duplicate') navigateTo(appPath(result.id, app.spaceId)); }).then((saved) => { if (saved) onChanged?.(); });
  };
  const items: AppMenuItems = marketing ? [] : regularItems(app, state.busy, mutate, () => void state.perform(() => exportApp(app)), onDetails);
  if (onShareImage && !marketing) items.unshift({ label: 'Share view as image', isDisabled: state.busy, onClick: onShareImage });
  if (app.canManage) items.push(
    { type: 'divider' },
    { label: app.lifecycle === 'archived' ? 'Restore app' : 'Archive app', isDisabled: state.busy, onClick: () => mutate(app.lifecycle === 'archived' ? 'restore' : 'archive') },
    { label: 'Delete app', variant: 'destructive', isDisabled: state.busy, onClick: () => setRemoving(true) },
  );
  const description = marketing ? 'This permanently deletes Marketing, its saved campaigns, drafts and app history.' : 'This permanently deletes the app, its saved records and update history. Export a copy first if you’d like to keep it.';
  const confirmation = removing && <AlertDialog isOpen title="Delete this app?" description={description}
    actionLabel="Delete app permanently" isActionLoading={state.busy} onOpenChange={(open) => { if (!state.busy) setRemoving(open); }}
    onAction={() => void state.perform(async () => { await deleteApp(app); onChanged?.(); navigateTo(appPath(null, app.spaceId)); })} />;
  if (render) return render(items, confirmation);
  return <><MoreMenu label="App actions" presentation="adaptive" alignment="end" isDisabled={state.busy} items={items} />{confirmation}</>;
}
