import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Collapsible, CollapsibleGroup } from '@astryxdesign/core/Collapsible';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { HStack } from '@astryxdesign/core/HStack';
import { Selector } from '@astryxdesign/core/Selector';
import { Slider } from '@astryxdesign/core/Slider';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { useAnnounce } from '@astryxdesign/core/hooks';
import {
  isDeviceOnline, updateDeviceSettings, type Device, type DeviceLive, type DeviceSettings, type ListeningMode, type RingSound,
} from './devices-api';

// #668 "Settings" (#327, #389): the device's settings folded into groups, each
// a row with a one-line summary that expands to its controls. Mute and Do not
// disturb are the header's toggles; they save through the same
// useDeviceSettingsSave as every control here, so the two can never race.
// Firmware that cannot take settings yet says so once, at the top.

const MODE_OPTIONS: Array<{ value: ListeningMode; label: string }> = [
  { value: 'ptt', label: 'Push to talk' },
  { value: 'wake', label: 'Wake word' },
  { value: 'announce_only', label: 'Announcements only' },
];
// #389: the ring lengths offered, in seconds; the server accepts any whole 10..120.
const RING_SECONDS_CHOICES = [10, 20, 30, 45, 60, 90, 120];
const RING_SOUND_OPTIONS: Array<{ value: RingSound; label: string }> = [
  { value: 'classic', label: 'Classic' },
  { value: 'chime', label: 'Chime' },
  { value: 'pulse', label: 'Pulse' },
];
const RING_LENGTH_HINT = 'How long a timer or alarm rings, 10 to 120 seconds.';
const SETTINGS_ERROR = 'The setting could not be saved.';
// How long the volume waits for the next key before it saves (c1).
const VOLUME_SETTLE_MS = 400;
const FIRMWARE_NOTE = 'Needs a firmware update';
const SETTING_NAMES: Record<keyof DeviceSettings, string> = {
  volume: 'the volume', muted: 'Mute', mode: 'how it listens', dnd: 'Do not disturb',
  ring_seconds: 'the ring length', ring_sound: 'the ring sound', wake_word: 'the wake word',
};

function ringLengthLabel(seconds: number): string {
  if (seconds === 60) return '1 minute';
  if (seconds === 120) return '2 minutes';
  return `${seconds} seconds`;
}

/** The offered lengths, plus the stored one when it is not among them. */
function ringLengthOptions(current: number): Array<{ value: string; label: string }> {
  const seconds = RING_SECONDS_CHOICES.includes(current)
    ? RING_SECONDS_CHOICES
    : [...RING_SECONDS_CHOICES, current].sort((a, b) => a - b);
  return seconds.map((value) => ({ value: String(value), label: ringLengthLabel(value) }));
}

export function batteryText(live: DeviceLive): string {
  if (live.battery_pct === null) return 'Battery unknown';
  return `Battery ${live.battery_pct}%${live.charging === true ? ', charging' : ''}`;
}

function label<T extends string>(options: Array<{ value: T; label: string }>, value: T): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/** Says whether the device has confirmed the stored settings (#327): visible
 *  text beside a StatusDot, and a polite announcement when it changes. */
function SettingsStatus({ device }: { device: Device }): ReactElement {
  const announce = useAnnounce();
  const announced = useRef<boolean | null>(null);
  useEffect(() => {
    const previous = announced.current;
    announced.current = device.pending;
    if (device.pending && previous !== true) announce(`${device.name} settings applying`);
    else if (!device.pending && previous === true) announce(`${device.name} settings applied`);
  }, [announce, device.name, device.pending]);
  const text = device.pending ? 'Applying…' : 'Applied';
  return (
    <HStack gap={1} vAlign="center">
      <StatusDot variant={device.pending ? 'warning' : 'success'} label={text} />
      <Text type="supporting" size="sm">{text}</Text>
    </HStack>
  );
}

/** A group's always-visible row: its name and a one-line summary. */
function GroupRow({ name, summary }: { name: string; summary: string }): ReactElement {
  return (
    <VStack gap={0}>
      <Text weight="semibold">{name}</Text>
      <Text type="supporting">{summary}</Text>
    </VStack>
  );
}

type GroupProps = { value: string; name: string; summary: string; isDisabled?: boolean; children?: ReactNode };

function Group({ value, name, summary, isDisabled = false, children }: GroupProps): ReactElement {
  return (
    <Collapsible value={value} isDisabled={isDisabled} trigger={<GroupRow name={name} summary={summary} />}>
      {children}
    </Collapsible>
  );
}

/**
 * c1: the Volume slider's value and commit. The Astryx Slider ends a "drag" on
 * every key, so a commit waits for the keys to settle and saves the final value
 * once; until the save lands the slider shows where the user put it, and a
 * failed save falls back to the stored value.
 */
function useSettledVolume(stored: number, commit: (volume: number) => Promise<void>) {
  const [drag, setDrag] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onChangeEnd = (value: number): void => {
    setDrag(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (value !== stored) await commit(value);
      // A volume moved on while this saved stays where the user put it.
      setDrag((current) => (current === value ? null : current));
    }, VOLUME_SETTLE_MS);
  };
  return { value: drag ?? stored, onChange: setDrag, onChangeEnd };
}

/** Which controls wait, and why: firmware that never reported its settings
 *  (#327) or the ring settings (#389) cannot take them, and every control but
 *  the Volume slider waits while a change saves. The slider stays usable while
 *  its own save is in flight (c1): a key pressed on a disabled slider was dropped. */
function lockState(device: Device, saving: keyof DeviceSettings | null) {
  const firmwareReason = device.settings_supported ? undefined : FIRMWARE_NOTE;
  const unsupported = firmwareReason !== undefined;
  const locked = saving !== null || unsupported;
  return {
    locked,
    volumeLocked: unsupported || (saving !== null && saving !== 'volume'),
    ringLocked: locked || !device.ring_settings_supported,
    firmwareReason,
    ringNote: device.ring_settings_supported ? undefined : FIRMWARE_NOTE,
  };
}

export type DeviceSettingsSave = {
  /** The setting being saved, or null; every control waits while one saves. */
  saving: keyof DeviceSettings | null;
  /** True after the last save failed (the control shows the stored value). */
  failed: boolean;
  save: (patch: Partial<DeviceSettings>) => Promise<void>;
};

/**
 * The one save path for a device's settings: the header's Mute and Do not
 * disturb toggles and every Settings control share it, so they lock together
 * and fail the same way (an error toast naming the setting; the control keeps
 * the server-acknowledged value).
 */
export function useDeviceSettingsSave(
  device: Pick<Device, 'id'>, onSaved: (settings: DeviceSettings, pending: boolean) => void,
): DeviceSettingsSave {
  const [saving, setSaving] = useState<keyof DeviceSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const toast = useToast();
  const save = useCallback(async (patch: Partial<DeviceSettings>): Promise<void> => {
    const key = Object.keys(patch)[0] as keyof DeviceSettings;
    setSaving(key);
    setFailed(false);
    const result = await updateDeviceSettings(device.id, patch);
    if (result.ok) onSaved(result.settings, result.pending);
    else {
      setFailed(true);
      toast({ body: `Couldn't change ${SETTING_NAMES[key]}.`, type: 'error', isAutoHide: true, uniqueID: `device-setting-${device.id}` });
    }
    setSaving(null);
  }, [device.id, onSaved, toast]);
  return { saving, failed, save };
}

type DeviceSettingsGroupsProps = {
  device: Device;
  onSaved: (settings: DeviceSettings, pending: boolean) => void;
  /** The page's shared save (with the header toggles); omitted, its own. */
  settingsSave?: DeviceSettingsSave;
};

/**
 * Every control shows the server-acknowledged value: a change saves at once,
 * all controls wait while it saves, and a failed save leaves the previous value
 * with an error toast and a Banner. Only the volume drag is local. A saved
 * change reads "Applying…" until the device reports it back.
 */
export function DeviceSettingsGroups({ device, onSaved, settingsSave }: DeviceSettingsGroupsProps): ReactElement {
  const { settings } = device;
  const own = useDeviceSettingsSave(device, onSaved);
  const { saving, failed, save } = settingsSave ?? own;
  const volume = useSettledVolume(settings.volume, (value) => save({ volume: value }));
  const { locked, volumeLocked, ringLocked, firmwareReason, ringNote } = lockState(device, saving);
  const soundSummary = `${settings.muted ? 'Muted' : `Volume ${settings.volume}`} · ${label(RING_SOUND_OPTIONS, settings.ring_sound)} ring, ${ringLengthLabel(settings.ring_seconds)}`;
  const listeningSummary = settings.mode === 'wake' && device.wake_word_supported
    ? `${label(MODE_OPTIONS, settings.mode)} · "Hey Bob"`
    : label(MODE_OPTIONS, settings.mode);

  return (
    <VStack gap={2}>
      {firmwareReason !== undefined && (
        <Banner status="info" title={`Update ${device.name} to change settings from here.`} />
      )}
      {device.settings_supported && device.pending && <SettingsStatus device={device} />}
      {device.settings_supported && !isDeviceOnline(device) && (
        <Text type="supporting" size="sm">{`Changes apply when ${device.name} is back online.`}</Text>
      )}
      <CollapsibleGroup type="single" hasDividers>
        <Group value="sound" name="Sound" summary={soundSummary}>
          <FormLayout>
            <Slider
              label="Volume"
              description={settings.muted ? 'Muted' : undefined}
              min={0}
              max={10}
              step={1}
              valueDisplay="text"
              value={volume.value}
              isDisabled={volumeLocked}
              disabledMessage={firmwareReason}
              onChange={volume.onChange}
              onChangeEnd={volume.onChangeEnd}
            />
            <Selector
              label="Ring sound"
              description={ringNote ?? 'The sound a timer or alarm rings with.'}
              options={RING_SOUND_OPTIONS}
              value={settings.ring_sound}
              isDisabled={ringLocked}
              disabledMessage={ringNote}
              isLoading={saving === 'ring_sound'}
              onChange={(value) => void save({ ring_sound: value as RingSound })}
            />
            <Selector
              label="Timer ring length"
              description={ringNote ?? RING_LENGTH_HINT}
              options={ringLengthOptions(settings.ring_seconds)}
              value={String(settings.ring_seconds)}
              isDisabled={ringLocked}
              disabledMessage={ringNote}
              isLoading={saving === 'ring_seconds'}
              onChange={(value) => void save({ ring_seconds: Number(value) })}
            />
          </FormLayout>
        </Group>
        <Group value="listening" name="Listening" summary={listeningSummary}>
          <FormLayout>
            <Selector
              label="Listening mode"
              description={`How ${device.name} starts listening.`}
              options={MODE_OPTIONS}
              value={settings.mode}
              isDisabled={locked}
              isLoading={saving === 'mode'}
              onChange={(value) => void save({ mode: value as ListeningMode })}
            />
          </FormLayout>
        </Group>
      </CollapsibleGroup>
      {saving !== null && <Text type="supporting" size="sm" role="status">Saving…</Text>}
      {failed && <Banner status="error" title={SETTINGS_ERROR} />}
    </VStack>
  );
}
