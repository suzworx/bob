import { useState, type ReactElement } from 'react';
import { BellOff, Megaphone, Volume2, VolumeX } from 'lucide-react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { fetchWithAuth } from '@/lib/auth/use-session';
import { isDeviceOnline, type Device, type DeviceSettings } from './devices-api';
import { useDeviceSettingsSave, type DeviceSettingsSave } from './device-settings-groups';

// #668 quick actions, in the device page header: Test speaker and Announce are
// a notice card on this device (POST /api/devices/:id/announce; the firmware
// has no test-speaker command, so the test is a ringing notice), off while the
// device is offline. Do not disturb and Mute are the same settings save the
// Settings section uses (one save path, one lock). Results are toasts.

const TITLE_MAX = 28;
const BODY_MAX = 200;

type AnnounceOutcome = 'sent' | 'held' | 'no_device' | 'failed';
type Announcement = { title: string; body?: string; ring: boolean };

/** 202 is sent or held; 409 is no connected device; anything else failed. */
async function announceToDevice(id: string, announcement: Announcement): Promise<AnnounceOutcome> {
  try {
    const response = await fetchWithAuth(`/api/devices/${encodeURIComponent(id)}/announce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'notice', ...announcement }),
    });
    if (response.status === 409) return 'no_device';
    if (!response.ok) return 'failed';
    const { status } = (await response.json()) as { status: 'sent' | 'held' };
    return status;
  } catch {
    return 'failed';
  }
}

const outcomeText = (outcome: AnnounceOutcome, name: string): string =>
  ({
    sent: `Sent to ${name}.`,
    held: `${name} will show it when free.`,
    no_device: `${name} is offline.`,
    failed: `Couldn't reach ${name}. Try again.`,
  })[outcome];
const FIRMWARE_REASON = 'Needs a firmware update';

type AnnounceDialogProps = {
  deviceName: string; isOpen: boolean; onOpenChange: (open: boolean) => void; onSend: (a: Announcement) => Promise<AnnounceOutcome>;
};

function AnnounceDialog({ deviceName, isOpen, onOpenChange, onSend }: AnnounceDialogProps): ReactElement {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const close = (open: boolean): void => {
    if (!open) {
      setTitle('');
      setBody('');
      setError(null);
    }
    onOpenChange(open);
  };
  const announce = async (): Promise<void> => {
    setError(null);
    const outcome = await onSend({ title: title.trim(), ...(body.trim() ? { body: body.trim() } : {}), ring: false });
    // Sent or held closes; offline or failed keeps what was typed.
    if (outcome === 'sent' || outcome === 'held') close(false);
    else setError(outcomeText(outcome, deviceName));
  };
  const ready = title.trim() !== '' && body.length <= BODY_MAX;
  return (
    <Dialog isOpen={isOpen} onOpenChange={close} purpose="form" width={440}>
      <Layout
        header={<DialogHeader title={`Announce on ${deviceName}`} subtitle="Shows as a card on its screen." onOpenChange={close} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              <TextInput
                label="Title"
                description={`${TITLE_MAX - title.length} characters left.`}
                autoComplete="off"
                hasAutoFocus
                value={title}
                // TextInput has no maxLength prop; clamp to what the API accepts.
                onChange={(value) => setTitle(value.slice(0, TITLE_MAX))}
              />
              <TextArea label="Message" description="Optional." maxLength={BODY_MAX} value={body} onChange={setBody} />
              {error && (
                <Banner status="error" title={error} endContent={<Button label="Retry" size="sm" variant="secondary" clickAction={announce} />} />
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="ghost" onClick={() => close(false)} />
              <Button
                label="Announce"
                variant="primary"
                isDisabled={!ready}
                clickAction={announce}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

type DeviceQuickActionsProps = {
  device: Device;
  onSettingsSaved: (settings: DeviceSettings, pending: boolean) => void;
  /** The page's settings save, shared with the Settings section. */
  settingsSave?: DeviceSettingsSave;
};

export function DeviceQuickActions({ device, onSettingsSaved, settingsSave }: DeviceQuickActionsProps): ReactElement {
  const [announcing, setAnnouncing] = useState(false);
  const toast = useToast();
  const own = useDeviceSettingsSave(device, onSettingsSaved);
  const { saving, save } = settingsSave ?? own;
  const isNarrow = useMediaQuery('(max-width: 768px)');
  const send = async (announcement: Announcement): Promise<AnnounceOutcome> => {
    const outcome = await announceToDevice(device.id, announcement);
    const ok = outcome === 'sent' || outcome === 'held';
    toast({ body: outcomeText(outcome, device.name), type: ok ? 'info' : 'error', isAutoHide: true, uniqueID: `device-announce-${device.id}` });
    return outcome;
  };
  const online = isDeviceOnline(device);
  const offlineReason = online ? undefined : `${device.name} is offline`;
  const locked = !device.settings_supported || saving !== null;
  const lockReason = device.settings_supported ? undefined : FIRMWARE_REASON;
  const testReason = offlineReason ?? (device.settings.muted ? 'Unmute to test' : device.settings.dnd ? 'Turn off Do not disturb to test' : undefined);
  return (
    <HStack gap={2} wrap="wrap" vAlign="center">
      <Button
        label="Test speaker"
        variant="secondary"
        size="sm"
        isIconOnly={isNarrow}
        icon={<Icon icon={Volume2} size="sm" />}
        isDisabled={testReason !== undefined}
        tooltip={testReason}
        clickAction={async () => void (await send({ title: 'Speaker test', ring: true }))}
      />
      <Button
        label="Announce…"
        variant="secondary"
        size="sm"
        isIconOnly={isNarrow}
        icon={<Icon icon={Megaphone} size="sm" />}
        isDisabled={!online}
        tooltip={offlineReason}
        onClick={() => setAnnouncing(true)}
      />
      <ToggleButton
        label="Do not disturb"
        size="sm"
        icon={<Icon icon={BellOff} size="sm" />}
        tooltip={lockReason}
        isPressed={device.settings.dnd}
        isDisabled={locked}
        isLoading={saving === 'dnd'}
        pressedChangeAction={(pressed) => save({ dnd: pressed })}
      >
        {isNarrow ? undefined : 'Do not disturb'}
      </ToggleButton>
      <ToggleButton
        label="Mute"
        size="sm"
        icon={<Icon icon={VolumeX} size="sm" />}
        tooltip={lockReason}
        isPressed={device.settings.muted}
        isDisabled={locked}
        isLoading={saving === 'muted'}
        pressedChangeAction={(pressed) => save({ muted: pressed })}
      >
        {isNarrow ? undefined : 'Mute'}
      </ToggleButton>
      <AnnounceDialog deviceName={device.name} isOpen={announcing} onOpenChange={setAnnouncing} onSend={send} />
    </HStack>
  );
}
