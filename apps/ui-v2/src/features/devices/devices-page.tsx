import { BRAND } from '@/lib/brand';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { MonitorSmartphoneIcon, PencilIcon, Plus, Trash2Icon } from 'lucide-react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Layout, LayoutContent, LayoutFooter, LayoutHeader } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Section } from '@astryxdesign/core/Section';
import { Selector } from '@astryxdesign/core/Selector';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { StackItem } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { useDeviceConversation } from '@/features/devices/use-device-conversation';
import { useOptionalSpaces, type Space } from '@/features/spaces/use-spaces';
import { DeviceQuickActions } from './device-quick-actions';
import { DeviceRecent, newestTurnAt, useDeviceActivity } from './device-recent';
import { DeviceSettingsGroups, batteryText, useDeviceSettingsSave } from './device-settings-groups';
import { NowTalkingCard } from './now-talking-card';
import { PairDialog } from './pair-dialog';
import {
  deviceProduct,
  isDeviceOnline,
  renameDevice,
  revokeDevice,
  setActiveSpace,
  type ActiveSpace,
  type Device,
  type DeviceSettings,
} from './devices-api';
import { forgetStoredDevice, refreshDevices, updateStoredDevice, useDevices } from './use-devices';
import { PAGE_WIDTH, PageTitle, usePagePadding } from '../../app/page-width';
import { devicePath, navigateTo, routeFromPath, useLocationPath } from '../../app/routes';
import { useRefreshOnFocus } from '../../lib/use-refresh-on-focus';

// The Devices page (#668, #1240). /devices is always the list: one row per
// device with its status, name and "Connected · 82%" / "Offline · seen Oct 16",
// and a row menu (Rename, Remove device). /devices/<id> is always that
// device's own page: a header with back, name, status and quick actions, then
// Talking in, Settings, Recent and About. /devices/pair opens the pair dialog
// over the list. One online rule (isDeviceOnline) feeds every surface, and the
// list comes from the shared useDevices store.

const NAME_MAX = 40;
const NAME_ERROR = `Use 1 to ${NAME_MAX} characters.`;
const RENAME_ERROR = "Couldn't rename it. Try again.";
const SPACE_SAVE_ERROR = "Couldn't change where new conversations start.";
const SPACE_GONE_ERROR = 'That space is gone. Pick another.';
const GENERAL = 'general';

/** "Connected · 82%" or "Offline · seen Oct 16" (or "never connected"). */
function StatusLine({ device }: { device: Device }): ReactElement {
  if (isDeviceOnline(device)) {
    const battery = device.live.battery_pct;
    return <>{battery === null ? 'Connected' : `Connected · ${battery}%${device.live.charging === true ? ', charging' : ''}`}</>;
  }
  if (device.last_seen_at === null) return <>Offline · never connected</>;
  return (
    <>
      {'Offline · seen '}
      <Timestamp value={device.last_seen_at} format="date" type="inherit" color="inherit" hasTooltip={false} />
    </>
  );
}

/** Online is a solid green dot; offline the neutral one, with its label. */
function Dot({ device }: { device: Device }): ReactElement {
  const online = isDeviceOnline(device);
  return <StatusDot variant={online ? 'success' : 'neutral'} label={online ? 'Connected' : 'Offline'} />;
}

type RowActions = { onRename: (device: Device) => void; onRemove: (device: Device) => void };

/** One MoreMenu per device; its items mount only while it is open. */
function DeviceMenu({ device, actions, size = 'sm' }: { device: Device; actions: RowActions; size?: 'sm' | 'md' }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <MoreMenu
      label={`Actions for ${device.name}`}
      size={size}
      alignment="end"
      presentation="adaptive"
      onOpenChange={setOpen}
      items={!open ? [] : [
        { label: 'Rename', icon: PencilIcon, onClick: () => actions.onRename(device) },
        { type: 'divider' },
        { label: 'Remove device', icon: Trash2Icon, variant: 'destructive', onClick: () => actions.onRemove(device) },
      ]}
    />
  );
}

function DeviceListRow({ device, actions, isNew }: { device: Device; actions: RowActions; isNew: boolean }): ReactElement {
  return (
    <ListItem
      label={device.name}
      description={<>{isNew ? 'Just paired · ' : ''}<StatusLine device={device} /></>}
      startContent={<Dot device={device} />}
      endContent={<DeviceMenu device={device} actions={actions} />}
      isSelected={isNew}
      onClick={() => navigateTo(devicePath(device.id))}
    />
  );
}

function ListSkeleton(): ReactElement {
  return (
    <VStack gap={2} role="status" aria-label="Loading devices">
      <Skeleton height={48} index={0} />
      <Skeleton height={48} index={1} />
    </VStack>
  );
}

/** Rename: a small form dialog that stays open, with the error under the field, on any failure. */
function RenameDialog({ device, onClose, onRenamed }: {
  device: Device; onClose: () => void; onRenamed: (name: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState(device.name);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed.length > NAME_MAX) {
      setError(NAME_ERROR);
      return;
    }
    setError(null);
    try {
      if (await renameDevice(device.id, trimmed)) onRenamed(trimmed);
      else setError(RENAME_ERROR);
    } catch {
      setError(RENAME_ERROR);
    }
  };
  return (
    <Dialog isOpen onOpenChange={(open) => !open && onClose()} purpose="form" width={400}>
      <Layout
        header={<DialogHeader title={`Rename ${device.name}`} onOpenChange={(open) => !open && onClose()} />}
        content={
          <LayoutContent>
            <TextInput
              label="Device name"
              description={`${NAME_MAX - draft.length} characters left.`}
              autoComplete="off"
              hasAutoFocus
              value={draft}
              status={error === null ? undefined : { type: 'error', message: error }}
              statusVariant="detached"
              onChange={(value) => {
                setDraft(value.slice(0, NAME_MAX));
                setError(null);
              }}
              onEnter={() => void save()}
            />
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="ghost" onClick={onClose} />
              <Button label="Save" variant="primary" clickAction={save} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

/** Remove: names the device and the consequence; stays open (loading) until the DELETE settles. */
function RemoveDialog({ device, onClose, onRemoved }: { device: Device; onClose: () => void; onRemoved: () => void }): ReactElement {
  const [removing, setRemoving] = useState(false);
  const [failed, setFailed] = useState(false);
  const remove = async (): Promise<void> => {
    setRemoving(true);
    setFailed(false);
    let ok = false;
    try {
      ok = await revokeDevice(device.id);
    } catch {
      ok = false;
    }
    setRemoving(false);
    if (ok) onRemoved();
    else setFailed(true);
  };
  return (
    <AlertDialog
      isOpen
      onOpenChange={(open) => !open && !removing && onClose()}
      title={`Remove ${device.name}?`}
      description={
        failed
          ? `Couldn't remove ${device.name}. Try again.`
          : `${device.name} stops working until you pair it again.`
      }
      actionLabel={failed ? 'Try again' : 'Remove'}
      isActionLoading={removing}
      onAction={() => void remove()}
    />
  );
}

type DetailProps = {
  device: Device;
  devices: Device[];
  accountSpace: ActiveSpace | null;
  spaces: Space[];
  refreshKey: number;
  actions: RowActions;
};

/** "New conversations start in": this device's own space when it has one
 *  (2+ devices), else the account's, which every device follows. */
function useDefaultSpace(device: Device, devices: Device[], account: ActiveSpace | null, spaces: Space[]) {
  const scoped = devices.length > 1;
  const [override, setOverride] = useState<{ value: ActiveSpace | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setOverride(null), [device.active_space_id, account?.id]);
  const own = (): ActiveSpace | null => {
    const ownId = device.active_space_id ?? null;
    if (ownId === null || ownId === account?.id) return account;
    const found = spaces.find((space) => space.id === ownId);
    return found ? { id: found.id, name: found.name } : account;
  };
  const value = override !== null ? override.value : scoped ? own() : account;
  const choose = async (spaceId: string | null): Promise<void> => {
    setSaving(true);
    setError(null);
    const result = await setActiveSpace(spaceId, scoped ? device.id : undefined);
    setSaving(false);
    if (result.ok) {
      setOverride({ value: result.activeSpace });
      void refreshDevices();
    } else {
      setError(result.reason === 'not_found' ? SPACE_GONE_ERROR : SPACE_SAVE_ERROR);
      if (result.reason === 'not_found') void refreshDevices();
    }
  };
  return { value, saving, error, choose, scoped };
}

function DeviceDetail({ device, devices, accountSpace, spaces, refreshKey, actions }: DetailProps): ReactElement {
  const { isMobile: isNarrow } = useAppShellMobile();
  const scopedId = devices.length > 1 ? device.id : undefined;
  const conversation = useDeviceConversation({ deviceId: scopedId });
  const activity = useDeviceActivity(device.id, refreshKey);
  const onSaved = useCallback(
    (settings: DeviceSettings, pending: boolean) => updateStoredDevice(device.id, { settings, pending }),
    [device.id],
  );
  const settingsSave = useDeviceSettingsSave(device, onSaved);
  const space = useDefaultSpace(device, devices, accountSpace, spaces);
  const product = deviceProduct(device.model);
  const spaceOptions = [{ value: GENERAL, label: 'General' }, ...spaces.map((s) => ({ value: s.id, label: s.name }))];

  const padding = usePagePadding();
  return (
    <Layout
      height="fill"
      padding={padding}
      contentWidth={PAGE_WIDTH}
      header={
        <LayoutHeader>
          <VStack gap={3}>
            <HStack gap={2} vAlign="center">
              <IconButton
                label="Back to devices"
                tooltip="Devices"
                icon={<Icon icon="chevronLeft" size="sm" />}
                variant="ghost"
                onClick={() => navigateTo(devicePath(null))}
              />
              <StackItem size="fill">
                <VStack gap={0}>
                  <Heading level={1} maxLines={1}>{device.name}</Heading>
                  <HStack gap={2} vAlign="center">
                    <Dot device={device} />
                    <Text type="supporting" size="sm"><StatusLine device={device} /></Text>
                  </HStack>
                </VStack>
              </StackItem>
              <DeviceMenu device={device} actions={actions} size="md" />
            </HStack>
            <DeviceQuickActions device={device} onSettingsSaved={onSaved} settingsSave={settingsSave} />
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent label={device.name}>
          <>
            <Section dividers={['bottom']} paddingInline={6}>
              <VStack gap={2}>
                <Heading level={2}>Talking in</Heading>
                <NowTalkingCard
                  device={conversation}
                  activeSpace={space.value}
                  spaces={spaces}
                  lastTurnAt={newestTurnAt(activity)}
                  devices={devices}
                  deviceId={scopedId}
                  deviceName={device.name}
                />
              </VStack>
            </Section>
            <Section dividers={['bottom']} paddingInline={6}>
              <VStack gap={3}>
                <Heading level={2}>Settings</Heading>
                <Selector
                  label="New conversations start in"
                  description={space.scoped ? `Only ${device.name}.` : 'Every device on your account.'}
                  options={spaceOptions}
                  value={space.value?.id ?? GENERAL}
                  isLoading={space.saving}
                  isDisabled={space.saving}
                  status={space.error === null ? undefined : { type: 'error', message: space.error }}
                  statusVariant="detached"
                  onChange={(value) => void space.choose(value === GENERAL ? null : value)}
                />
                <DeviceSettingsGroups device={device} onSaved={onSaved} settingsSave={settingsSave} />
              </VStack>
            </Section>
            <Section dividers={['bottom']} paddingInline={6}>
              <VStack gap={2}>
                <Heading level={2}>Recent</Heading>
                <DeviceRecent deviceName={device.name} activity={activity} spaces={spaces} />
              </VStack>
            </Section>
            <Section paddingInline={6}>
              <VStack gap={2}>
                <Heading level={2}>About</Heading>
                <MetadataList orientation={isNarrow ? 'vertical' : 'horizontal'}>
                  <MetadataListItem label="Model">{product.hardware === null ? product.name : `${product.name} · ${product.hardware}`}</MetadataListItem>
                  <MetadataListItem label="Firmware">{device.live.fw_version ?? 'Unknown'}</MetadataListItem>
                  <MetadataListItem label="Paired">
                    <Timestamp value={device.paired_at} format="date" type="inherit" color="inherit" />
                  </MetadataListItem>
                  <MetadataListItem label="Battery">{batteryText(device.live).replace(/^Battery /, '')}</MetadataListItem>
                </MetadataList>
              </VStack>
            </Section>
          </>
        </LayoutContent>
      }
    />
  );
}

/** /devices/pair is the dialog over the list, whether or not the shell's route
 *  table names it yet (it would otherwise read as a device id). The prop holds
 *  only until the dialog closes to /devices. */
function pairingFor(path: string, pairingProp: boolean, routeKind: string): boolean {
  if (path === '/devices/pair' || path === '/pair') return true;
  return pairingProp && routeKind !== 'devices';
}

type DialogsProps = {
  pairing: boolean;
  renaming: Device | null;
  removing: Device | null;
  onPaired: (deviceId: string, name: string) => void;
  onClosePairing: () => void;
  onCloseRename: () => void;
  onCloseRemove: () => void;
};

/** The page's dialogs: pair, rename and remove, each with its toast. */
function DevicesDialogs({ pairing, renaming, removing, onPaired, onClosePairing, onCloseRename, onCloseRemove }: DialogsProps): ReactElement {
  const toast = useToast();
  return (
    <>
      {pairing && (
        <PairDialog
          isOpen
          onOpenChange={(isOpen) => !isOpen && onClosePairing()}
          onPaired={(paired) => {
            toast({ body: `${paired.name} is paired.`, isAutoHide: true, uniqueID: `device-paired-${paired.device_id}` });
            onPaired(paired.device_id, paired.name);
          }}
        />
      )}
      {renaming && (
        <RenameDialog
          key={renaming.id}
          device={renaming}
          onClose={onCloseRename}
          onRenamed={(name) => {
            updateStoredDevice(renaming.id, { name });
            toast({ body: `Renamed to ${name}.`, isAutoHide: true });
            onCloseRename();
          }}
        />
      )}
      {removing && (
        <RemoveDialog
          key={removing.id}
          device={removing}
          onClose={onCloseRemove}
          onRemoved={() => {
            forgetStoredDevice(removing.id);
            toast({ body: `${removing.name} removed.`, isAutoHide: true });
            onCloseRemove();
            navigateTo(devicePath(null));
          }}
        />
      )}
    </>
  );
}

function ListHeader({ state, devices, onPair }: { state: string; devices: Device[]; onPair: () => void }): ReactElement {
  const { isMobile } = useAppShellMobile();
  const empty = state === 'ready' && devices.length === 0;
  return (
    <LayoutHeader>
      <HStack gap={2} vAlign="center" hAlign="between">
        <VStack gap={0}>
          <PageTitle>Devices</PageTitle>
          {state === 'ready' && !empty && (
            <Text type="supporting" size="sm" maxLines={isMobile ? 1 : undefined}>{`${devices.filter(isDeviceOnline).length} connected`}</Text>
          )}
        </VStack>
        {/* With no devices the empty state carries this action instead. */}
        {!empty && (
          <Button label="Pair a device" variant="primary" size={isMobile ? 'sm' : undefined} icon={<Icon icon={Plus} size="sm" />} onClick={onPair} />
        )}
      </HStack>
    </LayoutHeader>
  );
}

type ListBodyProps = {
  state: string;
  devices: Device[];
  missing: boolean;
  justPaired: string | null;
  actions: RowActions;
  onPair: () => void;
  onRetry: () => void;
};

/** Loading, error, a missing device, empty, or the list. */
function ListBody({ state, devices, missing, justPaired, actions, onPair, onRetry }: ListBodyProps): ReactElement | null {
  if (state === 'loading') return <ListSkeleton />;
  if (state === 'failed') {
    return (
      <Banner
        status="error"
        title="Couldn't load your devices."
        endContent={<Button label="Retry" size="sm" variant="secondary" onClick={onRetry} />}
      />
    );
  }
  if (missing) {
    return (
      <EmptyState
        title="This device isn't here anymore"
        description="It may have been removed, or it's paired to another account."
        icon={<Icon icon={MonitorSmartphoneIcon} size="lg" />}
        actions={<Button label="Back to devices" variant="secondary" onClick={() => navigateTo(devicePath(null))} />}
        headingLevel={2}
        isCompact
      />
    );
  }
  if (devices.length === 0) {
    return (
      <EmptyState
        title="No devices yet"
        description={`Pair a ${BRAND.assistantName} device to talk hands-free.`}
        icon={<Icon icon={MonitorSmartphoneIcon} size="lg" />}
        actions={<Button label="Pair a device" variant="primary" onClick={onPair} />}
        headingLevel={2}
      />
    );
  }
  return (
    <List hasDividers>
      {devices.map((paired) => (
        <DeviceListRow key={paired.id} device={paired} actions={actions} isNew={paired.id === justPaired} />
      ))}
    </List>
  );
}

/**
 * The /devices page (and /devices/<id>, /devices/pair). `pairing` opens the
 * pair dialog over the list; closing it returns to /devices.
 */
export function DevicesPage({ pairing: pairingProp = false }: { pairing?: boolean } = {}): ReactElement {
  const { state, devices, activeSpace, loads, refresh } = useDevices();
  const spaces = useOptionalSpaces();
  const path = useLocationPath();
  const route = routeFromPath(path);
  const pairing = pairingFor(path, pairingProp, route.kind);
  const routeDeviceId = route.kind === 'devices' && !pairing ? route.deviceId : null;
  const [renaming, setRenaming] = useState<Device | null>(null);
  const [removing, setRemoving] = useState<Device | null>(null);
  const [justPaired, setJustPaired] = useState<string | null>(null);
  const open = routeDeviceId === null ? undefined : devices.find((candidate) => candidate.id === routeDeviceId);

  // A tab coming back re-reads the list (quietly: a failure keeps it).
  const refreshKey = useRefreshOnFocus();
  useEffect(() => {
    if (refreshKey > 0) void refresh();
  }, [refresh, refreshKey]);

  const actions: RowActions = { onRename: setRenaming, onRemove: setRemoving };
  const startPairing = (): void => navigateTo('/devices/pair');
  const closePairing = (): void => navigateTo(devicePath(null));
  const dialogs = (
    <DevicesDialogs
      pairing={pairing}
      renaming={renaming}
      removing={removing}
      onPaired={(deviceId) => {
        setJustPaired(deviceId);
        closePairing();
        void refresh();
      }}
      onClosePairing={closePairing}
      onCloseRename={() => setRenaming(null)}
      onCloseRemove={() => setRemoving(null)}
    />
  );

  if (open !== undefined) {
    return (
      <>
        <DeviceDetail
          key={open.id}
          device={open}
          devices={devices}
          accountSpace={activeSpace}
          spaces={spaces?.spaces ?? []}
          refreshKey={loads}
          actions={actions}
        />
        {dialogs}
      </>
    );
  }

  const padding = usePagePadding();
  return (
    <Layout
      height="fill"
      padding={padding}
      contentWidth={PAGE_WIDTH}
      header={<ListHeader state={state} devices={devices} onPair={startPairing} />}
      content={
        <LayoutContent label="Devices">
          <VStack gap={4}>
            <ListBody
              state={state}
              devices={devices}
              missing={routeDeviceId !== null}
              justPaired={justPaired}
              actions={actions}
              onPair={startPairing}
              onRetry={() => void refresh()}
            />
          </VStack>
          {dialogs}
        </LayoutContent>
      }
    />
  );
}
